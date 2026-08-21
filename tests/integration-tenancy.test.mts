import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import {
  matchesConfiguredChannel, parseTeamsConfig, parseTeamsPayload, plainTextFromAdaptiveCard, teamsEventId,
} from "../lib/teams-integration.ts";

/**
 * O requisito estrutural: **toda integração pertence a um workspace**.
 * Credencial, configuração, canal, evento e demanda gerada ficam dentro do
 * grupo dono da integração, e nenhuma consulta de integração pode escapar do
 * `workspaceId` da sessão.
 *
 * Boa parte da garantia é estrutural (RLS + chave composta + parâmetro
 * vinculado), então parte destes testes lê o código-fonte das rotas: é a forma
 * de reprovar a reintrodução do padrão perigoso — aceitar `workspaceId` do
 * cliente — sem precisar de um banco de verdade.
 */

const routeUrl = (path: string) => new URL(`../${path}`, import.meta.url);

test("as rotas de integração tiram o workspace da sessão, nunca do cliente", async () => {
  const routes = [
    "app/api/integrations/events/route.ts",
    "app/api/integrations/movements/route.ts",
    "app/api/integrations/movements/[id]/route.ts",
    "app/api/integrations/[id]/webhook-secret/route.ts",
    "app/api/integrations/sync/route.ts",
    "app/api/integrations/overview/route.ts",
  ];
  for (const route of routes) {
    const source = await readFile(routeUrl(route), "utf8");
    assert.match(source, /getWorkspaceContext\(auth\.user\)/u, `${route} precisa resolver o grupo pela sessão`);
    // Um `workspaceId` lido de query, corpo ou parâmetro de rota seria o
    // caminho direto para ler a integração de outro cliente.
    assert.doesNotMatch(
      source,
      /searchParams\.get\("workspaceId"\)|body\.workspaceId|params\.workspaceId/u,
      `${route} não pode aceitar workspaceId do cliente`,
    );
  }
});

test("toda consulta de integração dessas rotas carrega o filtro por workspace", async () => {
  for (const route of [
    "app/api/integrations/events/route.ts",
    "app/api/integrations/movements/route.ts",
    "app/api/integrations/movements/[id]/route.ts",
    "app/api/integrations/[id]/webhook-secret/route.ts",
  ]) {
    const source = await readFile(routeUrl(route), "utf8");
    const statements = source.match(/(SELECT|UPDATE|INSERT INTO)[\s\S]{0,600}?`/gu) ?? [];
    for (const statement of statements) {
      if (!/fdp_(integrations|integration_events|integration_credentials|movement_suggestions)\b/u.test(statement)) continue;
      assert.match(
        statement,
        /workspace_id/u,
        `${route}: consulta a tabela de integração sem workspace_id`,
      );
    }
  }
});

test("o filtro por integração é conferido contra o grupo antes de virar consulta", async () => {
  // Sem essa conferência, um id de integração de outro cliente selecionaria as
  // linhas dele e a RLS viraria a única defesa — defesa única é defesa frágil.
  const source = await readFile(routeUrl("app/api/integrations/events/route.ts"), "utf8");
  assert.match(source, /SELECT id FROM fdp_integrations WHERE workspace_id = \? AND id = \?/u);
});

test("o webhook não confia no workspaceId da URL: o segredo é que autoriza", async () => {
  const source = await readFile(routeUrl("app/api/integrations/webhook/[channel]/route.ts"), "utf8");
  // O segredo conferido é o daquele grupo; trocar o identificador na URL não
  // abre a porta de outro cliente porque o segredo não confere.
  assert.match(source, /resolveWebhookSecret\(d1, workspaceId, integration\.id, channel\)/u);
  const authentication = source.indexOf("assertWebhookSecret(receivedSecret");
  assert.ok(authentication > 0);
  for (const write of ["INSERT INTO", "UPDATE fdp_"]) {
    assert.ok(source.indexOf(write) > authentication, `${write} antes da autenticação`);
  }
  // Workspace inexistente e integração não configurada respondem igual: separar
  // os casos diria a quem sondar quais identificadores existem.
  assert.match(source, /integration\.webhook_unconfigured[\s\S]{0,200}401/u);
});

test("a demanda do Teams nasce no grupo dono da integração", async () => {
  const source = await readFile(routeUrl("lib/teams-integration.ts"), "utf8");
  // Nenhum insert de cartão ou sugestão pode tirar o grupo do payload.
  for (const table of ["fdp_cards", "fdp_checklist_items", "fdp_movement_suggestions"]) {
    const start = source.indexOf(`INSERT INTO ${table}`);
    assert.ok(start > 0, `o insert em ${table} precisa existir para o teste ter sentido`);
    // A lista de colunas termina no primeiro VALUES/SELECT do comando.
    const columns = source.slice(start, source.indexOf("VALUES", start));
    assert.match(columns, /workspace_id/u, `insert em ${table} sem workspace_id`);
  }
  assert.match(source, /input\.workspaceId/u);
  assert.doesNotMatch(source, /payload\.workspaceId/u, "o grupo jamais vem do payload do provedor");
});

test("os colaboradores usados na interpretação são só os do grupo", async () => {
  // Nome de colaborador de um cliente não pode participar da leitura da
  // mensagem de outro — nem para elevar confiança.
  const source = await readFile(routeUrl("lib/teams-integration.ts"), "utf8");
  assert.match(source, /FROM fdp_employees WHERE workspace_id = \?/u);
});

test("as credenciais de webhook são lidas pelo par grupo + integração", async () => {
  const source = await readFile(routeUrl("lib/teams-integration.ts"), "utf8");
  assert.match(
    source,
    /FROM fdp_integration_credentials\s+WHERE workspace_id = \? AND integration_id = \?/u,
    "credencial de um grupo nunca pode ser aberta no contexto de outro",
  );
});

test("o segredo em claro do webhook é devolvido uma vez e nunca relido", async () => {
  const files = await readdir(new URL("../app/api/integrations/", import.meta.url), { recursive: true });
  const sources = await Promise.all(
    files.filter((file) => String(file).endsWith("route.ts"))
      .map(async (file) => [String(file), await readFile(new URL(`../app/api/integrations/${file}`, import.meta.url), "utf8")] as const),
  );
  for (const [name, source] of sources) {
    // Guardar o material cifrado é o trabalho da rota de credenciais; o que
    // nenhuma rota pode fazer é LER esse material de volta para devolvê-lo.
    // Por isso a proibição é sobre SELECT, não sobre a existência do nome.
    for (const statement of source.match(/SELECT[\s\S]{0,400}?FROM fdp_[a-z_]+/gu) ?? []) {
      assert.doesNotMatch(
        statement,
        /encrypted_value|initialization_vector|auth_tag/u,
        `${name} lê material de credencial numa rota de leitura`,
      );
    }
    assert.doesNotMatch(source, /Response\.json\([^)]*encrypted_value/u, `${name} devolve material de credencial`);
  }
  const rotation = sources.find(([name]) => name.includes("webhook-secret"))?.[1] ?? "";
  assert.match(rotation, /Cache-Control": "no-store/u);
  assert.match(rotation, /não será exibido novamente/u);
  // A trilha guarda impressão digital, jamais o segredo.
  assert.match(rotation, /fingerprint: publicCredentialFingerprint/u);
  assert.doesNotMatch(rotation, /after: \{[^}]*secret[^}]*:\s*secret/u);
});

/* Canal configurado ------------------------------------------------------ */

const payload = (partial: Record<string, unknown> = {}) => parseTeamsPayload({
  teamId: "team-dp", teamName: "Departamento Pessoal",
  channelId: "canal-movimentacoes", channelName: "Movimentações",
  messageId: "msg-1", senderName: "Renata",
  text: "João da Silva terá alteração salarial para R$ 5.500,00 a partir de 01/09/2026.",
  ...partial,
});

test("o corpo cru do gatilho do Power Automate é entendido sem mapeamento manual", () => {
  // O caminho oficial do Teams é um fluxo do Power Automate. Quem apenas
  // encaminha o `body` do gatilho "When a new channel message is added" manda a
  // forma nativa do Graph: canal/time sob channelIdentity, remetente sob
  // from.user, conteúdo HTML sob body.content. O conector precisa entender isso
  // sem exigir que o autor do fluxo monte um JSON à mão — senão devolveria
  // "mensagem sem texto" para a montagem mais óbvia.
  const parsed = parseTeamsPayload({
    id: "1699999999999",
    webUrl: "https://teams.microsoft.com/l/message/19:abc/1699999999999",
    body: { contentType: "html", content: "<div>João da Silva terá <b>alteração salarial</b> para R$ 5.500,00 a partir de 01/09/2026.</div>" },
    from: { user: { id: "u-1", displayName: "Renata Gestora" } },
    channelIdentity: { teamId: "team-dp", channelId: "canal-movimentacoes" },
    lastEditedDateTime: "",
  });
  assert.equal(parsed.teamId, "team-dp");
  assert.equal(parsed.channelId, "canal-movimentacoes");
  assert.equal(parsed.messageId, "1699999999999");
  assert.equal(parsed.senderName, "Renata Gestora");
  assert.equal(parsed.text, "João da Silva terá alteração salarial para R$ 5.500,00 a partir de 01/09/2026.");
  assert.match(parsed.messageUrl, /teams\.microsoft\.com/u);
});

test("o contrato JSON limpo do fluxo também é aceito", () => {
  const parsed = parseTeamsPayload({
    teamId: "team-dp", teamName: "Departamento Pessoal",
    channelId: "canal-movimentacoes", channelName: "Movimentações",
    messageId: "abc", messageUrl: "https://x", senderName: "Renata",
    text: "Maria Souza passará de Assistente para Analista em 01/09/2026.",
  });
  assert.equal(parsed.teamId, "team-dp");
  assert.equal(parsed.senderName, "Renata");
  assert.match(parsed.text, /Maria Souza/u);
});

test("Adaptive Card de aprovação é convertido em texto utilizável", () => {
  const attachments = [{ content: JSON.stringify({
    type: "AdaptiveCard",
    body: [
      { type: "TextBlock", text: "Rejeitado" },
      { type: "TextBlock", text: "VALMIR JUNIOR - VENDAS PAP - GOIÂNIA" },
      { type: "FactSet", facts: [
        { title: "Nome completo:", value: "Valdemir dos Santos Paes de Andrade" },
        { title: "CPF:", value: "987.654.321-00" },
        { title: "Solicitado por:", value: "Gabriella de Paula" },
      ] },
    ],
  }) }];
  assert.match(plainTextFromAdaptiveCard(attachments), /Nome completo: Valdemir/u);
  const parsed = parseTeamsPayload({ id: "card-1", attachments });
  assert.match(parsed.text, /Solicitado por: Gabriella/u);
});

test("mensagem de canal não monitorado é ignorada", () => {
  // O requisito: não existe um canal global para todos os clientes. Cada grupo
  // monitora o seu.
  const config = parseTeamsConfig({ teamId: "team-dp", channelId: "canal-movimentacoes" });
  assert.equal(matchesConfiguredChannel(config, payload()), true);
  assert.equal(matchesConfiguredChannel(config, payload({ channelId: "canal-aleatorio" })), false);
  assert.equal(matchesConfiguredChannel(config, payload({ teamId: "outro-time" })), false);
});

test("grupo recém-conectado, ainda sem canal escolhido, aceita as mensagens", () => {
  const config = parseTeamsConfig({});
  assert.equal(matchesConfiguredChannel(config, payload()), true);
});

test("as automações são escolhidas por grupo", () => {
  const both = parseTeamsConfig({});
  assert.deepEqual(both.automations, {
    salary_change: true, role_change: true, admission: true, termination: true, warning: true,
  });
  const onlySalary = parseTeamsConfig({ automations: { salary_change: true, role_change: false } });
  assert.equal(onlySalary.automations.role_change, false);
});

test("a configuração do Teams é por grupo e não vaza para outro", () => {
  const a = parseTeamsConfig({ tenantId: "tenant-a", teamId: "t-a", channelId: "c-a", teamName: "DP A" });
  const b = parseTeamsConfig({ tenantId: "tenant-b", teamId: "t-b", channelId: "c-b", teamName: "DP B" });
  assert.notEqual(a.tenantId, b.tenantId);
  assert.equal(matchesConfiguredChannel(a, payload({ teamId: "t-b", channelId: "c-b" })), false);
  assert.equal(matchesConfiguredChannel(b, payload({ teamId: "t-a", channelId: "c-a" })), false);
});

/* Idempotência da mensagem ---------------------------------------------- */

test("a mesma mensagem produz sempre o mesmo identificador de evento", () => {
  const body = JSON.stringify({ messageId: "msg-1" });
  assert.equal(teamsEventId(payload(), body), teamsEventId(payload(), body));
  assert.equal(teamsEventId(payload(), body), "teams:msg-1");
});

test("mensagem editada é um evento distinto, para poder atualizar a sugestão", () => {
  const body = JSON.stringify({ messageId: "msg-1" });
  const original = teamsEventId(payload(), body);
  const edited = teamsEventId(payload({ editedAt: "2026-08-13T12:00:00Z" }), body);
  assert.notEqual(original, edited, "a edição precisa ser reconhecida como fato novo");
  assert.match(edited, /^teams:msg-1:/u, "mas continua rastreável até a mensagem original");
});

test("sem messageId o identificador cai no hash do corpo, e não em algo aleatório", () => {
  // Um identificador aleatório faria toda reentrega virar demanda nova.
  const body = JSON.stringify({ text: "qualquer" });
  const first = teamsEventId(payload({ messageId: "" }), body);
  const second = teamsEventId(payload({ messageId: "" }), body);
  assert.equal(first, second);
  assert.match(first, /^teams:hash:[0-9a-f]{64}$/u);
  assert.notEqual(first, teamsEventId(payload({ messageId: "" }), JSON.stringify({ text: "outra" })));
});

test("o índice parcial impede duas sugestões pendentes para a mesma mensagem", async () => {
  const migration = await readFile(
    new URL("../drizzle/postgres/0037_integration_events_and_workspace_lifecycle.sql", import.meta.url),
    "utf8",
  );
  assert.match(
    migration,
    /fdp_movement_suggestions_message_uq[\s\S]{0,200}"workspace_id", "integration_id", "message_id"[\s\S]{0,120}WHERE "message_id" <> '' AND "status" = 'pending'/u,
  );
});

test("a confirmação da sugestão só cria demanda com os dados obrigatórios", async () => {
  const source = await readFile(routeUrl("app/api/integrations/movements/[id]/route.ts"), "utf8");
  const validation = source.indexOf("assertComplete(row.movement_kind");
  const insert = source.indexOf("INSERT INTO fdp_cards");
  assert.ok(validation > 0 && validation < insert, "confirmar sem os dados empurraria um cartão incompleto para o DP");
  // Sugestão já resolvida não vira uma segunda demanda.
  assert.match(source, /MOVEMENT_SUGGESTION_RESOLVED/u);
  assert.match(source, /row\.status !== "pending"/u);
});
