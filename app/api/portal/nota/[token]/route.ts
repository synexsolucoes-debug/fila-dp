import { getAttachmentsBucket, getScopedD1 } from "@/db";
import { apiError } from "@/lib/fila-dp-api";
import { ApiError } from "@/lib/api-errors";
import { clientAddress, consumePublicAuthRateLimit } from "@/lib/auth-rate-limit";
import { cleanText, optionalDate } from "@/lib/registrations";
import {
  checkInvoiceFile,
  documentDigits,
  invoiceAmountFromInput,
  sanitizeInvoiceFilename,
} from "@/lib/contractor-invoices";
import { assertNotDuplicated, registerInvoice } from "@/lib/contractor-invoice-service";
import { refreshContractorReconciliation } from "@/lib/payment-service";
import {
  assertPortalLinkUsable,
  hashPortalToken,
  parsePortalToken,
  samePortalHash,
} from "@/lib/contractor-invoice-portal";

type Params = { params: Promise<{ token: string }> };

/**
 * O portal do prestador: ler o pedido e enviar a nota, sem conta e sem senha.
 *
 * Esta é a única rota do produto que atende alguém de fora do workspace, e o
 * desenho parte disso:
 *
 * - **o inquilino vem do token, e a conexão nasce presa a ele.** Não há
 *   consulta sem recorte seguida de filtro na aplicação: `getScopedD1` emite
 *   `app.workspace_id` na mesma transação, e a RLS da tabela vale para esta
 *   rota como vale para qualquer outra;
 * - **toda recusa é a mesma recusa.** Token malformado, inexistente, de outro
 *   inquilino ou com hash diferente saem como um 404 idêntico. Distinguir os
 *   casos ensinaria quem está adivinhando onde chegou mais perto;
 * - **a resposta carrega o mínimo.** Nome do prestador, razão social e CNPJ de
 *   quem recebe a nota, competência, valor e prazo — o que a mensagem de aviso
 *   já dizia. Nenhum outro prestador, nenhum total da empresa, nenhum
 *   identificador interno além do necessário para o envio;
 * - **o envio termina no `registerInvoice` da tela.** Mesma verificação de
 *   duplicidade, mesma substituição versionada, mesma conferência humana
 *   depois. O portal muda quem digita, não o que vale.
 */

const genericNotFound = () => ApiError.notFound(
  "Este link não é válido. Confira o endereço recebido ou procure quem cuida do pagamento.",
  "PORTAL_LINK_NOT_FOUND",
);

type LinkRow = {
  id: string; workspace_id: string; company_id: string; provider_id: string;
  payroll_cycle_id: string; closing_id: string; competence: string;
  token_hash: string; expires_at: string; expected_amount: string | number;
  submitted_at: string | null; revoked_at: string | null;
  contractor_name: string; issuer_legal_name: string; issuer_tax_id: string; issuer_city: string;
  closing_expected_amount: string | number; closing_status: string; invoice_current_id: string | null;
};

/**
 * Resolve o token e devolve o link com o que a tela precisa.
 *
 * A limitação de tentativas vem antes da consulta, por token e por endereço:
 * sem ela a rota seria um oráculo que diz, em milissegundos, se um segredo
 * existe. Ela é consumida em toda visita — inclusive nas bem-sucedidas —,
 * porque contar só os erros deixa de fora quem já tem um token válido e quer
 * usá-lo como alavanca para descobrir os outros.
 */
async function resolveLink(rawToken: string, request: Request) {
  const parsed = parsePortalToken(rawToken);
  if (!parsed) throw genericNotFound();

  const limite = await consumePublicAuthRateLimit("contractor_portal", parsed.secret.slice(0, 32), clientAddress(request));
  if (!limite.allowed) {
    throw new ApiError(429, "PORTAL_RATE_LIMITED",
      "Muitas tentativas neste link. Aguarde alguns minutos e tente de novo.",
      { retryAfterSeconds: limite.retryAfterSeconds });
  }

  const hash = hashPortalToken(parsed.workspaceId, parsed.secret);
  const d1 = getScopedD1({ workspaceId: parsed.workspaceId });
  const link = await d1.prepare(`SELECT link.id, link.workspace_id, link.company_id, link.provider_id,
      link.payroll_cycle_id, link.closing_id, link.competence, link.token_hash, link.expires_at,
      link.expected_amount, link.submitted_at, link.revoked_at,
      provider.legal_name AS contractor_name,
      company.legal_name AS issuer_legal_name, company.tax_id AS issuer_tax_id, company.city AS issuer_city,
      closing.invoice_expected_amount AS closing_expected_amount, closing.status AS closing_status,
      closing.invoice_current_id
    FROM fdp_contractor_invoice_portal_links link
    JOIN fdp_auxiliary_providers provider ON provider.workspace_id = link.workspace_id AND provider.id = link.provider_id
    JOIN fdp_companies company ON company.workspace_id = link.workspace_id AND company.id = link.company_id
    JOIN fdp_contractor_closings closing ON closing.workspace_id = link.workspace_id AND closing.id = link.closing_id
    WHERE link.workspace_id = ? AND link.token_hash = ?`)
    .bind(parsed.workspaceId, hash)
    .first<LinkRow>();

  // O índice já comparou os hashes; esta segunda conferência protege o caminho
  // em que a linha volta por outro critério e o `===` vazaria, pelo tempo,
  // quantos caracteres iniciais coincidiam.
  if (!link || !samePortalHash(link.token_hash, hash)) throw genericNotFound();
  return { d1, link };
}

const portalPayload = (link: LinkRow) => ({
  contractorName: link.contractor_name,
  competence: link.competence,
  expectedAmount: Number(link.expected_amount ?? 0),
  expiresAt: link.expires_at,
  submittedAt: link.submitted_at ?? "",
  issuer: {
    legalName: link.issuer_legal_name,
    taxId: link.issuer_tax_id,
    city: link.issuer_city,
  },
});

export async function GET(request: Request, { params }: Params) {
  try {
    const { token } = await params;
    const { d1, link } = await resolveLink(token, request);

    /* Abrir é fato do link, e é o que responde "ele recebeu?" quando a nota não
       chega. Contado mesmo quando o link já não serve: saber que a pessoa abriu
       depois do prazo é informação, não ruído. */
    await d1.prepare(`UPDATE fdp_contractor_invoice_portal_links
        SET opened_count = opened_count + 1,
            first_opened_at = COALESCE(first_opened_at, now()),
            updated_at = now()
      WHERE workspace_id = ? AND id = ?`)
      .bind(link.workspace_id, link.id)
      .run();

    return Response.json({
      portal: portalPayload(link),
      // A situação vai junto com os dados, e não como erro: a tela do prestador
      // precisa desenhar "prazo vencido" com o nome dele e o valor à vista, e
      // não uma página de erro que não diz de que pedido se trata.
      status: link.revoked_at ? "revoked" : link.submitted_at ? "submitted"
        : new Date(link.expires_at).getTime() <= Date.now() ? "expired" : "active",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request, { params }: Params) {
  let uploadedObjectKey = "";
  let bucketRef: ReturnType<typeof getAttachmentsBucket> | null = null;
  try {
    const { token } = await params;
    const form = await request.formData();
    const { d1, link } = await resolveLink(token, request);
    assertPortalLinkUsable(link);

    if (link.closing_status === "closed" || link.closing_status === "paid") {
      throw ApiError.badRequest(
        "Este pagamento já foi concluído. Procure quem cuida do pagamento antes de enviar a nota.",
        "PAYMENT_CLOSING_LOCKED",
      );
    }

    const invoiceNumber = cleanText(form.get("invoiceNumber"), 80);
    if (!invoiceNumber) throw ApiError.badRequest("Informe o número da nota fiscal.", "INVOICE_NUMBER_REQUIRED");
    const issueDate = optionalDate(form.get("issueDate"), true);
    if (!issueDate) throw ApiError.badRequest("Informe a data de emissão da nota.", "INVOICE_ISSUE_DATE_REQUIRED");
    const amount = invoiceAmountFromInput(form.get("receivedAmount"));
    const series = cleanText(form.get("series"), 20);
    const issuerDocument = documentDigits(form.get("issuerDocument"));

    const file = form.get("invoiceFile");
    if (!(file instanceof File) || file.size <= 0) {
      /* Pelo painel o arquivo é opcional: quem está com a nota na mão às vezes
         só registra o número e anexa depois. Aqui ele é obrigatório — o portal
         existe para receber o documento, e um envio sem arquivo devolveria ao
         DP exatamente o trabalho que este link foi criado para tirar. */
      throw ApiError.badRequest("Anexe o arquivo da nota fiscal.", "INVOICE_FILE_REQUIRED");
    }
    const { contentType } = checkInvoiceFile({ name: file.name, type: file.type, size: file.size });
    const filename = sanitizeInvoiceFilename(file.name);

    await assertNotDuplicated(d1, {
      workspaceId: link.workspace_id,
      closingId: link.closing_id,
      providerId: link.provider_id,
      invoiceNumber,
      series,
      issuerDocument,
      // Quem envia não pode dispensar o próprio alerta de duplicidade: liberar
      // um envio repetido é decisão de conferência, e conferência é do DP.
      acknowledged: false,
      canAcknowledge: false,
    });

    const documentId = crypto.randomUUID();
    uploadedObjectKey = `workspaces/${link.workspace_id}/contractors/${link.provider_id}/invoices/${link.competence}/${documentId}`;
    bucketRef = getAttachmentsBucket();
    await bucketRef.put(uploadedObjectKey, file.stream(), {
      httpMetadata: { contentType, contentDisposition: "attachment" },
      customMetadata: {
        documentId, providerId: link.provider_id, closingId: link.closing_id,
        workspaceId: link.workspace_id, competence: link.competence,
      },
    });

    const stored = await d1.prepare(`WITH lock AS (
        SELECT pg_advisory_xact_lock(hashtext(?))
      ), entitlement AS (
        SELECT plan.storage_limit_mb FROM fdp_workspace_subscriptions subscription
        JOIN fdp_saas_plans plan ON plan.id = subscription.plan_id, lock
        WHERE subscription.workspace_id = ? AND subscription.status IN ('trialing', 'active')
      ), inserted AS (
        INSERT INTO fdp_contractor_documents
          (id, workspace_id, company_id, provider_id, closing_id, document_kind, competence, invoice_number,
           object_key, filename, content_type, size_bytes, created_by, created_via)
        SELECT ?, ?, ?, ?, ?, 'invoice', ?, ?, ?, ?, ?, ?, ?, 'contractor_portal' FROM entitlement
        WHERE (SELECT COALESCE(SUM(size_bytes), 0) FROM fdp_card_attachments WHERE workspace_id = ?)
            + (SELECT COALESCE(SUM(size_bytes), 0) FROM fdp_epi_attachments WHERE workspace_id = ?)
            + (SELECT COALESCE(SUM(size_bytes), 0) FROM fdp_contractor_documents WHERE workspace_id = ?)
            + ? <= entitlement.storage_limit_mb::bigint * 1024 * 1024
        RETURNING id
      ) SELECT id FROM inserted`)
      .bind(link.workspace_id, link.workspace_id, documentId, link.workspace_id, link.company_id,
        link.provider_id, link.closing_id, link.competence, invoiceNumber, uploadedObjectKey,
        filename, contentType, file.size, /* created_by */ null,
        link.workspace_id, link.workspace_id, link.workspace_id, file.size)
      .first<{ id: string }>();
    if (!stored) {
      await bucketRef.delete(uploadedObjectKey).catch(() => undefined);
      uploadedObjectKey = "";
      /* O limite é do contratante, e quem esbarra nele é o prestador. A
         mensagem não expõe planos nem números do cliente: ela diz o que fazer. */
      throw new ApiError(507, "PORTAL_STORAGE_UNAVAILABLE",
        "Não foi possível guardar o arquivo agora. Avise quem cuida do pagamento na empresa.");
    }

    const registered = await registerInvoice(d1, {
      workspaceId: link.workspace_id,
      closing: {
        id: link.closing_id, company_id: link.company_id, provider_id: link.provider_id,
        payroll_cycle_id: link.payroll_cycle_id, competence: link.competence,
        invoice_expected_amount: link.closing_expected_amount,
      },
      invoiceNumber, series, issueDate, issuerDocument,
      issuerName: link.contractor_name, receiverDocument: link.issuer_tax_id,
      serviceDescription: "", amount, notes: "",
      documentId,
      duplicateAck: false,
      replacesInvoiceId: link.invoice_current_id,
      actor: { kind: "contractor_portal", name: link.contractor_name },
      ip: clientAddress(request),
      userAgent: request.headers.get("user-agent") ?? "",
    });

    /* O link fecha junto com a nota. A condição no WHERE é o que impede dois
       envios simultâneos de virarem duas notas: o segundo não encontra link
       aberto e é recusado antes de escrever. */
    const closed = await d1.prepare(`UPDATE fdp_contractor_invoice_portal_links
        SET submitted_at = now(), submitted_invoice_id = ?, updated_at = now()
      WHERE workspace_id = ? AND id = ? AND submitted_at IS NULL AND revoked_at IS NULL
      RETURNING id`)
      .bind(registered.invoiceId, link.workspace_id, link.id)
      .first<{ id: string }>();
    if (!closed) {
      throw new ApiError(409, "PORTAL_LINK_SUBMITTED",
        "Esta nota já havia sido recebida. Confira com quem cuida do pagamento antes de enviar de novo.");
    }

    await refreshContractorReconciliation(d1, link.workspace_id, link.closing_id);

    return Response.json({
      received: {
        invoiceNumber,
        amount: registered.comparison.informedAmount,
        expectedAmount: registered.comparison.expectedAmount,
        // A diferença não vai para o prestador. Ele informou um valor e a
        // empresa pediu outro: quem concilia isso é a conferência, e antecipar
        // um "faltam R$ 40" vira discussão antes de alguém ter olhado.
        competence: link.competence,
      },
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (uploadedObjectKey && bucketRef) await bucketRef.delete(uploadedObjectKey).catch(() => undefined);
    return apiError(error);
  }
}
