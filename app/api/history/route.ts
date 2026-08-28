import { ApiError, apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";

/**
 * O histórico completo da operação (spec: Últimas movimentações → "Ver
 * histórico completo").
 *
 * A Visão geral mostra cinco movimentações e não dizia como ver as demais. O
 * registro existia em `fdp_activity_events` desde sempre; o que faltava era
 * onde lê-lo — o mesmo padrão da ficha do processo em rascunho.
 *
 * ## Recorte
 *
 * O evento herda a visibilidade da demanda a que pertence. Sem isso, o
 * histórico viraria caminho lateral para o que o recorte por empresa esconde:
 * quem não pode ver a demanda leria, na trilha, o título dela e quem mexeu.
 *
 * Evento sem demanda (`card_id` nulo) é do workspace, e aparece para quem tem
 * acesso ao workspace — é o caso de configuração e integração.
 *
 * ## Paginação
 *
 * Por cursor de data, e não por deslocamento: a trilha cresce enquanto alguém
 * a lê, e `OFFSET` faria a segunda página repetir ou pular linhas conforme
 * eventos novos entrassem no topo.
 */

const PAGINA = 60;
const MAXIMO = 200;

const text = (value: unknown) => (value == null ? "" : String(value));

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, board, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "cards.read");

    const url = new URL(request.url);
    const antesDe = url.searchParams.get("antesDe") ?? "";
    const limite = Math.min(Math.max(Number(url.searchParams.get("limite") ?? PAGINA) || PAGINA, 1), MAXIMO);

    if (antesDe && Number.isNaN(Date.parse(antesDe))) {
      throw ApiError.badRequest("O cursor de paginação não é uma data válida.", "INVALID_CURSOR");
    }

    /* O mesmo conjunto de empresas que o quadro usa. Vem de uma função
       compartilhada justamente para que histórico e quadro não possam divergir
       — duas listas de empresas visíveis seriam duas respostas para a mesma
       pergunta, e a segunda a ser esquecida vira o furo. */
    const escopo = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);

    const linhas = await d1.prepare(`SELECT ae.id, ae.card_id, ae.actor_email, ae.event_type,
          ae.payload_json, ae.created_at,
          COALESCE(u.name, ae.actor_email) AS actor_name,
          c.title AS card_title, c.reference_number, c.company_id, c.company
        FROM fdp_activity_events ae
        LEFT JOIN fdp_users u ON u.email = ae.actor_email
        LEFT JOIN fdp_cards c ON c.id = ae.card_id AND c.workspace_id = ae.workspace_id
       WHERE ae.workspace_id = ?
         AND (NULLIF(?, '') IS NULL OR ae.created_at < NULLIF(?, '')::timestamptz)
         AND (c.id IS NULL OR c.board_id = ?)
       ORDER BY ae.created_at DESC, ae.id DESC
       LIMIT ?`)
      .bind(workspace.id, antesDe, antesDe, board.id, limite + 1)
      .all<Record<string, unknown>>();

    const todas = linhas.results ?? [];
    /* O recorte por empresa é aplicado depois da consulta, como no snapshot:
       a lista de empresas visíveis já está em memória, e filtrar em SQL exigiria
       montar um `IN` variável que o verificador de consultas não conseguiria
       conferir contra o schema. */
    const permitidas = todas.filter((linha) => {
      const companyId = text(linha.company_id);
      if (!linha.card_id) return true;
      if (!companyId) return true;
      return escopo.unrestricted || escopo.companyIds.has(companyId);
    });

    const pagina = permitidas.slice(0, limite);
    /* `hasMore` olha o que a consulta trouxe, não o que sobrou do filtro: se o
       recorte removeu tudo desta página, ainda pode haver eventos visíveis mais
       atrás, e dizer "acabou" esconderia o resto da trilha. */
    const temMais = todas.length > limite;

    return Response.json({
      events: pagina.map((linha) => ({
        id: text(linha.id),
        cardId: linha.card_id ? text(linha.card_id) : null,
        cardTitle: text(linha.card_title),
        referenceNumber: linha.reference_number == null ? null : Number(linha.reference_number),
        company: text(linha.company),
        actorName: text(linha.actor_name),
        eventType: text(linha.event_type),
        payload: typeof linha.payload_json === "string"
          ? safeParse(linha.payload_json) : (linha.payload_json ?? {}),
        createdAt: text(linha.created_at),
      })),
      nextCursor: temMais && pagina.length ? text(pagina[pagina.length - 1].created_at) : null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

function safeParse(value: string): unknown {
  try { return JSON.parse(value); } catch { return {}; }
}
