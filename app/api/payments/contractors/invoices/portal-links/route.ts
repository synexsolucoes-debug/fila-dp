import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getCompanyAccessScope, getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/registrations";
import { validCompetence } from "@/lib/operations";
import {
  createPortalToken,
  portalExpiryFromDays,
  portalLinkStatus,
  portalLinkUrl,
} from "@/lib/contractor-invoice-portal";
import { buildInvoiceNoticeFile, invoiceNoticeFilename } from "@/lib/contractor-invoice-notice";

/**
 * Os links do portal do prestador, por competência.
 *
 * O `GET` responde a pergunta que a tela de Notas Fiscais faz o mês inteiro:
 * de quem eu já pedi, quem abriu, quem mandou. O `POST` gera os links de quem
 * ainda precisa emitir — em lote, porque pedir nota é trabalho de lote: ninguém
 * abre trinta telas para mandar trinta mensagens.
 *
 * O token completo só existe na resposta do `POST`. O `GET` devolve situação e
 * data, nunca o link: quem perdeu a mensagem gera outro, e gerar outro revoga o
 * anterior. Guardar o token para poder relê-lo depois seria transformar o banco
 * num chaveiro de credenciais válidas, que é exatamente o que o hash evita.
 */

type LinkRow = {
  id: string; provider_id: string; closing_id: string; competence: string;
  contractor_name: string; contractor_code: string; expected_amount: string | number;
  expires_at: string; first_opened_at: string | null; opened_count: number;
  submitted_at: string | null; submitted_invoice_id: string | null;
  revoked_at: string | null; revoke_reason: string; created_at: string;
};

const publicLink = (row: LinkRow) => ({
  id: row.id,
  providerId: row.provider_id,
  closingId: row.closing_id,
  competence: row.competence,
  contractorName: row.contractor_name,
  contractorCode: row.contractor_code,
  expectedAmount: Number(row.expected_amount ?? 0),
  status: portalLinkStatus(row),
  expiresAt: row.expires_at,
  firstOpenedAt: row.first_opened_at ?? "",
  openedCount: Number(row.opened_count ?? 0),
  submittedAt: row.submitted_at ?? "",
  submittedInvoiceId: row.submitted_invoice_id ?? "",
  revokedAt: row.revoked_at ?? "",
  revokeReason: row.revoke_reason ?? "",
  createdAt: row.created_at,
});

const selectLinks = `SELECT link.id, link.provider_id, link.closing_id, link.competence, link.expected_amount,
    link.expires_at, link.first_opened_at, link.opened_count, link.submitted_at, link.submitted_invoice_id,
    link.revoked_at, link.revoke_reason, link.created_at,
    provider.legal_name AS contractor_name, provider.code AS contractor_code
  FROM fdp_contractor_invoice_portal_links link
  JOIN fdp_auxiliary_providers provider ON provider.workspace_id = link.workspace_id AND provider.id = link.provider_id`;

export async function GET(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "invoice.read");
    const url = new URL(request.url);
    const companyId = cleanText(url.searchParams.get("companyId"), 120);
    if (!companyId) throw ApiError.badRequest("Selecione uma empresa.", "COMPANY_REQUIRED");
    const competence = validCompetence(url.searchParams.get("competence"));
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const result = await d1.prepare(`${selectLinks}
      WHERE link.workspace_id = ? AND link.company_id = ? AND link.competence = ?
      ORDER BY provider.legal_name`)
      .bind(workspace.id, companyId, competence)
      .all<LinkRow>();
    return Response.json({ links: result.results.map(publicLink) });
  } catch (error) { return apiError(error); }
}

/**
 * Gera os links da competência e devolve o arquivo de avisos pronto.
 *
 * Sem `contractorIds`, atende todo mundo que tem nota a emitir e ainda não
 * mandou — o caso do mês. Com a lista, atende só quem foi pedido, que é o caso
 * de quem perdeu a mensagem e precisa de outro link.
 *
 * Quem já enviou a nota fica de fora mesmo quando vem nomeado: gerar link para
 * quem já cumpriu é convidar a uma segunda via que ninguém pediu. Substituir
 * uma nota recebida é decisão de conferência, e ela tem tela própria.
 *
 * ## Por que gerar é a única forma de o link entrar no arquivo
 *
 * O banco guarda o hash do token, nunca o token. Isso significa que o endereço
 * de um link já criado é irrecuperável — de propósito: é o que faz um vazamento
 * do banco não devolver nenhum link utilizável. A consequência é que o arquivo
 * de avisos não pode *ler* links; ele os cria no momento em que é produzido, e
 * os anteriores daquele fechamento são revogados na mesma transação.
 *
 * Isso é a semântica certa e não um efeito colateral: quem gera o arquivo de
 * avisos vai mandá-lo para todo mundo, e o link que valia na mensagem anterior
 * não deve continuar valendo depois de um reenvio geral.
 *
 * ## Recorte
 *
 * `companyId` é opcional, e a ausência dele não é descuido: o arquivo de avisos
 * cobre o grupo, porque o prestador é do grupo e recortar deixaria de fora quem
 * atende mais de uma empresa. `issuerCompanyId` é outra coisa — a emitente, que
 * entra no texto de cada mensagem e não filtra ninguém.
 */
export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const body = await request.json() as Record<string, unknown>;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "invoice.portal.manage");
    const competence = validCompetence(body.competence);
    /* A emitente é quem recebe a nota de todo mundo, e o acesso a ela é exigido
       porque é o nome dela que vai no documento. */
    const issuerCompanyId = cleanText(body.issuerCompanyId ?? body.companyId, 120);
    if (!issuerCompanyId) throw ApiError.badRequest("Selecione a empresa emitente.", "COMPANY_REQUIRED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, issuerCompanyId);

    /* O recorte dos prestadores: uma empresa quando pedida, senão tudo que a
       pessoa alcança — o mesmo alcance do relatório de avisos. */
    const companyId = cleanText(body.companyId, 120);
    if (companyId) await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    const access = await getCompanyAccessScope(d1, workspace.id, user.id, workspace.role);
    const empresas = companyId ? [companyId] : [...access.companyIds];
    if (!companyId && !access.unrestricted && empresas.length === 0) {
      throw ApiError.badRequest("Você não tem acesso a nenhuma empresa desta competência.", "COMPANY_ACCESS_REQUIRED");
    }

    const escolhidos = Array.isArray(body.contractorIds)
      ? body.contractorIds.map((item) => cleanText(item, 120)).filter(Boolean)
      : [];
    const expiresAt = portalExpiryFromDays(body.days);

    /* O recorte é o mesmo do aviso de NF: quem tem valor de nota a emitir nesta
       competência. Os dois falam das mesmas pessoas de propósito — é isso que
       permite conferir uma lista contra a outra. */
    const candidatos = await d1.prepare(`SELECT closing.id, closing.company_id, closing.provider_id,
        closing.payroll_cycle_id, closing.competence, closing.invoice_expected_amount,
        provider.legal_name AS contractor_name
      FROM fdp_contractor_closings closing
      JOIN fdp_auxiliary_providers provider ON provider.workspace_id = closing.workspace_id AND provider.id = closing.provider_id
      WHERE closing.workspace_id = ? AND closing.competence = ?
        AND (?::boolean OR closing.company_id = ANY(?::text[]))
        AND closing.excluded_at IS NULL
        AND closing.invoice_expected_amount > 0
        AND closing.invoice_current_id IS NULL
        AND closing.status NOT IN ('closed', 'paid')
        AND (?::boolean OR closing.provider_id = ANY(?::text[]))
      ORDER BY provider.legal_name`)
      .bind(workspace.id, competence, !companyId && access.unrestricted, empresas,
        escolhidos.length === 0, escolhidos)
      .all<{
        id: string; company_id: string; provider_id: string; payroll_cycle_id: string; competence: string;
        invoice_expected_amount: string | number; contractor_name: string;
      }>();

    if (!candidatos.results.length) {
      throw ApiError.badRequest(
        "Nenhum prestador desta competência está esperando nota fiscal.",
        "PORTAL_NO_PENDING_CONTRACTORS",
      );
    }

    const gerados: Array<{ providerId: string; contractorName: string; closingId: string; expectedAmount: number; url: string }> = [];
    const statements = [];
    for (const closing of candidatos.results) {
      const token = createPortalToken(workspace.id);
      const id = crypto.randomUUID();
      /* Gerar o segundo link revoga o primeiro no mesmo lote. O índice parcial
         só admite um aberto por fechamento, e deixar o banco recusar daria ao
         operador um erro em vez do link que ele pediu — sendo que a intenção de
         quem gera de novo é sempre "vale este agora". */
      statements.push(d1.prepare(`UPDATE fdp_contractor_invoice_portal_links
          SET revoked_at = now(), revoked_by = ?, revoke_reason = 'Substituído por um link novo', updated_at = now()
        WHERE workspace_id = ? AND closing_id = ? AND revoked_at IS NULL AND submitted_at IS NULL`)
        .bind(user.id, workspace.id, closing.id));
      statements.push(d1.prepare(`INSERT INTO fdp_contractor_invoice_portal_links
          (id, workspace_id, company_id, provider_id, payroll_cycle_id, closing_id, competence,
           token_hash, expires_at, expected_amount, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, workspace.id, closing.company_id, closing.provider_id, closing.payroll_cycle_id, closing.id,
          closing.competence, token.hash, expiresAt.toISOString(),
          Number(closing.invoice_expected_amount ?? 0), user.id));
      gerados.push({
        providerId: closing.provider_id,
        contractorName: closing.contractor_name,
        closingId: closing.id,
        expectedAmount: Number(closing.invoice_expected_amount ?? 0),
        url: portalLinkUrl(token.token),
      });
    }

    statements.push(prepareAuditEvent({
      workspaceId: workspace.id,
      actorUserId: user.id,
      actorEmail: auth.user.email,
      action: "contractor_invoice_portal.links_created",
      entityType: "contractor_invoice_portal_link",
      entityId: issuerCompanyId,
      // O token não entra na trilha: auditoria guarda o que aconteceu, não a
      // credencial que permitiria repetir.
      after: { competence, total: gerados.length, expiresAt: expiresAt.toISOString() },
      metadata: { issuerCompanyId, companyId: companyId || null, providerIds: gerados.map((item) => item.providerId) },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }));

    const emitente = await d1.prepare("SELECT legal_name, tax_id, city FROM fdp_companies WHERE workspace_id = ? AND id = ?")
      .bind(workspace.id, issuerCompanyId)
      .first<{ legal_name: string; tax_id: string; city: string }>();

    await d1.batch(statements);

    const mensagens = buildInvoiceNoticeFile(
      gerados.map((item) => ({ prestador: item.contractorName, nf_esperada: item.expectedAmount, provider_id: item.providerId })),
      { razaoSocial: emitente?.legal_name ?? "", cnpj: emitente?.tax_id ?? "", cidade: emitente?.city ?? "" },
      competence,
      new Map(gerados.map((item) => [item.providerId, item.url])),
    );

    return Response.json({
      links: gerados, messages: mensagens, filename: invoiceNoticeFilename(competence),
      expiresAt: expiresAt.toISOString(),
    }, { status: 201 });
  } catch (error) { return apiError(error); }
}
