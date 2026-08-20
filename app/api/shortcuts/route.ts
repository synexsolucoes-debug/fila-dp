import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext } from "@/lib/fila-dp-db";
import { ApiError } from "@/lib/api-errors";
import { isKnownView } from "@/lib/process-navigation";

/**
 * Favoritos e recentes de uma pessoa dentro de um grupo (§67).
 *
 * O menu cresceu com a organização por processo: sete processos e mais de
 * vinte destinos. Quem trabalha em três deles o dia inteiro abre dois níveis
 * toda vez, e quem voltou do almoço não tem como retomar de onde parou.
 *
 * Isto é preferência pessoal, não dado da operação: fica por usuário e por
 * grupo, e não aparece para mais ninguém. Não há permissão a exigir além de
 * pertencer ao grupo — os atalhos de uma pessoa são dela.
 *
 * O que a rota *não* faz é decidir o que a pessoa pode abrir. Ela grava e
 * devolve chaves de tela; quem recorta pelo plano contratado e pelo papel é o
 * painel, no mesmo lugar em que já recorta o menu. Duplicar a decisão de
 * acesso aqui criaria a segunda cópia que um dia diverge da primeira — e a
 * §30 pede que ela seja uma só.
 */

const MAXIMO_DE_FAVORITOS = 8;

type ShortcutRow = { view_key: string; favorite: number; position: number; last_used_at: string };

async function readShortcuts(
  d1: Awaited<ReturnType<typeof getWorkspaceContext>>["d1"],
  workspaceId: string,
  userId: string,
) {
  const rows = await d1.prepare(
    `SELECT view_key, favorite, position, last_used_at
       FROM fdp_user_module_shortcuts
      WHERE workspace_id = ? AND user_id = ?
      ORDER BY favorite DESC, position, last_used_at DESC`,
  ).bind(workspaceId, userId).all<ShortcutRow>();

  const favorites = rows.results.filter((row) => row.favorite === 1)
    .sort((a, b) => a.position - b.position)
    .map((row) => row.view_key);
  const recents = rows.results
    .slice()
    .sort((a, b) => String(b.last_used_at).localeCompare(String(a.last_used_at)))
    .map((row) => row.view_key);
  return { favorites, recents };
}

export async function GET() {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    return Response.json(await readShortcuts(d1, workspace.id, user.id));
  } catch (error) { return apiError(error); }
}

/**
 * Dois pedidos, um verbo.
 *
 * `{ view, visited: true }` registra passagem — é o que alimenta os recentes.
 * `{ view, favorite: true | false }` marca ou desmarca. Separar em duas rotas
 * daria dois caminhos para escrever na mesma linha da mesma tabela, com duas
 * chances de esquecer o mesmo recorte de segurança.
 */
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const view = body.view;
    // Chave inventada não entra: o menu mostraria um atalho para lugar nenhum,
    // e a tabela guardaria lixo que ninguém sabe de onde veio.
    if (!isKnownView(view)) throw ApiError.badRequest("Tela desconhecida.", "UNKNOWN_VIEW");

    const { d1, workspace, user } = await getWorkspaceContext(auth.user);

    if (typeof body.favorite === "boolean") {
      if (body.favorite) {
        const total = await d1.prepare(
          "SELECT count(*)::int AS total FROM fdp_user_module_shortcuts WHERE workspace_id = ? AND user_id = ? AND favorite = 1 AND view_key <> ?",
        ).bind(workspace.id, user.id, view).first<{ total: number }>();
        // Um teto, e um recado que diz o que fazer. Uma lista de favoritos sem
        // limite deixa de ser uma lista de favoritos e vira o menu de novo.
        if ((total?.total ?? 0) >= MAXIMO_DE_FAVORITOS) {
          throw ApiError.badRequest(
            `São no máximo ${MAXIMO_DE_FAVORITOS} favoritos. Remova um para adicionar outro.`,
            "SHORTCUT_LIMIT",
          );
        }
        await d1.prepare(
          `INSERT INTO fdp_user_module_shortcuts (workspace_id, user_id, view_key, favorite, position, last_used_at, use_count)
           VALUES (?, ?, ?, 1, ?, now(), 0)
           ON CONFLICT (workspace_id, user_id, view_key)
           DO UPDATE SET favorite = 1, position = EXCLUDED.position`,
        ).bind(workspace.id, user.id, view, (total?.total ?? 0) + 1).run();
      } else {
        // Desmarcar não apaga a linha: a pessoa continua tendo passado por ali,
        // e apagar faria o destino sumir também dos recentes, que é uma segunda
        // coisa que ela não pediu.
        await d1.prepare(
          "UPDATE fdp_user_module_shortcuts SET favorite = 0, position = 0 WHERE workspace_id = ? AND user_id = ? AND view_key = ?",
        ).bind(workspace.id, user.id, view).run();
      }
    } else {
      await d1.prepare(
        `INSERT INTO fdp_user_module_shortcuts (workspace_id, user_id, view_key, favorite, position, last_used_at, use_count)
         VALUES (?, ?, ?, 0, 0, now(), 1)
         ON CONFLICT (workspace_id, user_id, view_key)
         DO UPDATE SET last_used_at = now(), use_count = fdp_user_module_shortcuts.use_count + 1`,
      ).bind(workspace.id, user.id, view).run();
    }

    return Response.json(await readShortcuts(d1, workspace.id, user.id));
  } catch (error) { return apiError(error); }
}
