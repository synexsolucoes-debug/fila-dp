import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, getWorkspaceModules } from "@/lib/fila-dp-db";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { redact } from "@/lib/assistant/redaction";
import {
  askAssistant, assertConfigured, buildSystemPrompt, readAssistantConfig, type AssistantMessage,
} from "@/lib/assistant/provider";

/**
 * Conversa com o assistente.
 *
 * O contexto que sai daqui é deliberadamente pobre: quem é a pessoa, que papel
 * tem, em que tela está, e quais módulos ela enxerga — com o motivo de cada
 * bloqueio. Nada de colaborador, prestador, folha ou valor.
 *
 * Essa pobreza é o desenho, não uma limitação a corrigir depois. Um assistente
 * que enxerga a folha inteira precisaria de uma decisão de LGPD que não é do
 * produto; um que enxerga a estrutura da tela já responde a maior parte das
 * perguntas de suporte, que é o que reduz chamado.
 */

const MAX_TURNS = 12;

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    const url = new URL(request.url);
    const conversationId = cleanText(url.searchParams.get("conversationId"), 60);
    const status = readAssistantConfig();

    const messages = conversationId
      ? await d1.prepare(`SELECT m.id, m.role, m.content, m.created_at
          FROM fdp_assistant_messages m
          JOIN fdp_assistant_conversations c ON c.id = m.conversation_id AND c.workspace_id = m.workspace_id
          WHERE m.workspace_id = ? AND m.conversation_id = ? AND c.user_id = ?
          ORDER BY m.created_at`).bind(workspace.id, conversationId, user.id).all<Record<string, unknown>>()
      : { results: [] };

    return Response.json({
      // A tela precisa saber se pode conversar antes de deixar alguém digitar.
      available: status.configured,
      // O que falta é dito ao usuário sem nome de variável secreta.
      unavailableReason: status.configured
        ? null
        : "O assistente ainda não foi configurado neste ambiente. Fale com o administrador da plataforma.",
      conversationId: conversationId || null,
      messages: messages.results.map((row) => ({
        id: row.id, role: row.role, content: row.content, createdAt: row.created_at,
      })),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);

    const status = readAssistantConfig();
    assertConfigured(status);

    const question = cleanText(body.message, 2000);
    if (!question) throw ApiError.badRequest("Escreva a sua pergunta.", "ASSISTANT_MESSAGE_REQUIRED");
    const screen = cleanText(body.screen, 60) || "Painel";

    // O que a pessoa enxerga é o que o assistente sabe que ela enxerga — com as
    // exceções individuais já aplicadas, porque é isso que ela vê na tela.
    const modules = await getWorkspaceModules(d1, workspace.id, workspace.role,
      String((workspace as Record<string, unknown>).status ?? "active"),
      (workspace as { memberGrants?: ReadonlyMap<string, boolean> }).memberGrants,
      (workspace as { departmentModules?: ReadonlySet<string> }).departmentModules);

    const system = buildSystemPrompt({
      workspaceName: workspace.name,
      userName: user.name || auth.user.email.split("@")[0],
      role: workspace.role,
      screen,
      allowedModules: modules.filter((item) => item.allowed).map((item) => ({ key: item.key, name: item.name })),
      blockedModules: modules.filter((item) => !item.allowed)
        .map((item) => ({ key: item.key, name: item.name, reason: item.message })),
    });

    let conversationId = cleanText(body.conversationId, 60);
    const history: AssistantMessage[] = [];
    if (conversationId) {
      const rows = await d1.prepare(`SELECT m.role, m.content FROM fdp_assistant_messages m
        JOIN fdp_assistant_conversations c ON c.id = m.conversation_id AND c.workspace_id = m.workspace_id
        WHERE m.workspace_id = ? AND m.conversation_id = ? AND c.user_id = ?
        ORDER BY m.created_at DESC LIMIT ?`)
        .bind(workspace.id, conversationId, user.id, MAX_TURNS).all<{ role: string; content: string }>();
      // A consulta traz os mais recentes; a conversa precisa ir em ordem.
      history.push(...rows.results.reverse().map((row) => ({
        role: row.role === "assistant" ? "assistant" as const : "user" as const,
        content: String(row.content),
      })));
    }

    const reply = await askAssistant({
      config: status.config,
      system,
      messages: [...history, { role: "user", content: question }],
    });

    // A pergunta é gravada **já redigida**: o texto original não fica em lugar
    // nenhum, nem no banco do cliente.
    const safeQuestion = redact(question);

    const statements = [];
    if (!conversationId) {
      conversationId = crypto.randomUUID();
      statements.push(d1.prepare(`INSERT INTO fdp_assistant_conversations (id, workspace_id, user_id, title, screen)
        VALUES (?, ?, ?, ?, ?)`)
        .bind(conversationId, workspace.id, user.id, safeQuestion.text.slice(0, 80), screen));
    } else {
      statements.push(d1.prepare("UPDATE fdp_assistant_conversations SET updated_at = now() WHERE workspace_id = ? AND id = ? AND user_id = ?")
        .bind(workspace.id, conversationId, user.id));
    }
    statements.push(
      d1.prepare(`INSERT INTO fdp_assistant_messages (id, workspace_id, conversation_id, role, content, redactions_json)
        VALUES (?, ?, ?, 'user', ?, ?::jsonb)`)
        .bind(crypto.randomUUID(), workspace.id, conversationId, safeQuestion.text, JSON.stringify(safeQuestion.hits)),
      d1.prepare(`INSERT INTO fdp_assistant_messages (id, workspace_id, conversation_id, role, content, redactions_json, provider, model)
        VALUES (?, ?, ?, 'assistant', ?, '[]'::jsonb, ?, ?)`)
        .bind(crypto.randomUUID(), workspace.id, conversationId, reply.text, reply.provider, reply.model),
    );
    await d1.batch(statements);

    return Response.json({
      conversationId,
      reply: reply.text,
      // A tela avisa quando algo foi removido da pergunta: sem isso a pessoa
      // acha que o assistente ignorou o dado, e repete.
      redacted: safeQuestion.redacted,
      redactionKinds: safeQuestion.hits.map((hit) => hit.kind),
    });
  } catch (error) {
    return apiError(error);
  }
}
