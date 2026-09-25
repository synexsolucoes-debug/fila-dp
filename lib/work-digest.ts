import { escapeHtml } from "./email.ts";
import { hasCapability } from "./authorization.ts";
import {
  buildWorkCenterQuery, buildWorkCountsQuery, emptyWorkItemFilters, toWorkItem, workItemSources,
  type WorkItem,
} from "./work-items.ts";

/**
 * Resumo diário por e-mail, passo 1 (roadmap P0 "notificação externa").
 *
 * A Central de Trabalho (§3 a §12) já sabe responder "o que está vencido?" —
 * é a mesma pergunta que `/api/work?prazo=vencido` já resolve. O que faltava
 * era alguém perguntar por fora, uma vez por dia, para quem não abre o
 * sistema. Este módulo não inventa uma fonte nova: ele monta a mesma consulta
 * com `scope: "team"` e `due: "overdue"`, para o papel "admin" — o único que
 * hoje enxerga todas as empresas do workspace sem precisar de
 * `fdp_member_company_access` — e formata o resultado como e-mail.
 *
 * Só administradores recebem, e só quando há algo vencido. Estender a membros
 * com acesso restrito por empresa, ou a quem tem acesso mas não é admin,
 * pediria repetir a consulta por destinatário (cada um vê um recorte
 * diferente) — deixado para quando houver um segundo consumidor real dessa
 * segmentação.
 */
const MAX_DIGEST_ITEMS = 10;

/** As mesmas fontes que a rota `/api/work` liberaria para um administrador. */
function adminSources() {
  return workItemSources.filter((source) => hasCapability({ role: "admin" }, source.capability));
}

export type WorkDigest = {
  items: WorkItem[];
  overdueTotal: number;
};

/**
 * Monta a consulta e os parâmetros do resumo. Devolve `null` quando nenhuma
 * fonte está disponível para o papel admin (não deveria acontecer em produção,
 * mas evita montar uma união vazia).
 */
export function buildWorkDigestQueries(workspaceId: string) {
  const sources = adminSources();
  const shared = { sources, workspaceId, userId: "", companyIds: null };
  const counts = buildWorkCountsQuery({ ...shared, scope: "team" });
  const page = buildWorkCenterQuery({
    ...shared,
    filters: { ...emptyWorkItemFilters, scope: "team", due: "overdue" },
    sort: "urgency",
    cursor: [],
    limit: MAX_DIGEST_ITEMS,
  });
  if (!counts || !page) return null;
  return { counts, page };
}

/** Linha completa até `overdueTotal`; o e-mail lista as primeiras e diz "e mais N". */
export function workDigestFromRows(
  countsRow: Record<string, unknown> | null,
  pageRows: readonly Record<string, unknown>[],
): WorkDigest | null {
  const overdueTotal = Number(countsRow?.overdue ?? 0);
  if (overdueTotal <= 0) return null;
  const today = new Date().toISOString().slice(0, 10);
  const items = pageRows.slice(0, MAX_DIGEST_ITEMS).map((row) => toWorkItem(row, today));
  return { items, overdueTotal };
}

/**
 * O HTML do resumo. Função pura — sem isto separado do envio, testar o
 * conteúdo do e-mail exigiria um Resend de mentira.
 */
export function workDigestEmailHtml(workspaceName: string, digest: WorkDigest, baseUrl: string) {
  const base = baseUrl.replace(/\/+$/u, "");
  const rows = digest.items.map((item) => {
    const label = item.companyName ? `${item.title} — ${item.companyName}` : item.title;
    return `<li><a href="${escapeHtml(base + item.href)}">${escapeHtml(label)}</a></li>`;
  }).join("");
  const hidden = digest.overdueTotal - digest.items.length;
  const more = hidden > 0
    ? `<p>E mais ${hidden} ${hidden === 1 ? "item vencido" : "itens vencidos"} na Central de Trabalho.</p>`
    : "";
  const count = digest.overdueTotal === 1 ? "1 item vencido precisa" : `${digest.overdueTotal} itens vencidos precisam`;
  return `<p>Olá.</p><p>${escapeHtml(workspaceName)}: ${count} de atenção.</p><ul>${rows}</ul>${more}`;
}
