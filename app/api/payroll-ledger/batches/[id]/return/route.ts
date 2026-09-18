import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { MAX_RETURN_FILE_BYTES, parseLedgerReturn } from "@/lib/ledger-export";
import { confirmationKey, fromCents, toCents } from "@/lib/payroll-ledger";

/**
 * A importação de retorno: o arquivo volta com o que a folha descontou.
 *
 * Este é o caminho honesto enquanto não existir integração oficial com ERP
 * nenhum — e ele não é um atalho que pula as regras. Cada linha do arquivo vira
 * uma confirmação pela **mesma** porta de sempre: com chave de idempotência,
 * passando pelo trigger que recalcula o saldo e que recusa desconto acima do
 * previsto.
 *
 * Três recusas que o produto faz de propósito:
 *
 *  * **linha em branco não confirma nada.** Célula vazia é "ninguém descontou",
 *    e zero digitado também — descontar R$ 0,00 não é um fato;
 *  * **valor acima do saldo da parcela é problema apontado, não gravado.** O
 *    ajuste autorizado tem permissão própria e exige justificativa escrita, e
 *    um arquivo de planilha não é lugar para isso;
 *  * **valor negativo não vira estorno.** Estornar exige motivo, e ele é feito
 *    na tela, por quem tem `ledger.reverse`.
 *
 * Reimportar o mesmo arquivo não duplica baixa: a chave de idempotência é a
 * mesma, e o índice único do banco deixa passar a primeira.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.confirm", "confirmar os descontos pelo arquivo de retorno");

    const batch = await d1.prepare(`SELECT id, company_id, competence, status FROM fdp_ledger_batches
      WHERE workspace_id = ? AND id = ?`).bind(workspace.id, id).first<Record<string, unknown>>();
    if (!batch) throw ApiError.notFound("Conferência não encontrada.", "LEDGER_BATCH_NOT_FOUND");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, String(batch.company_id));
    if (["closed"].includes(String(batch.status))) {
      throw ApiError.badRequest("Esta conferência está encerrada. Reabra-a para registrar confirmações.", "LEDGER_BATCH_CLOSED");
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw ApiError.badRequest("Envie o arquivo de retorno exportado pelo Vinculato.", "LEDGER_RETURN_FILE_REQUIRED");
    }
    if (file.size > MAX_RETURN_FILE_BYTES) {
      throw ApiError.badRequest("O arquivo de retorno deve ter no máximo 10 MB.", "LEDGER_RETURN_FILE_TOO_LARGE");
    }
    const reference = String(form.get("reference") ?? "").trim().slice(0, 200) || file.name.slice(0, 200);

    let parsed;
    try {
      parsed = await parseLedgerReturn(await file.arrayBuffer());
    } catch (issue) {
      throw ApiError.badRequest(
        issue instanceof Error ? issue.message : "Não foi possível ler o arquivo de retorno.",
        "LEDGER_RETURN_UNREADABLE",
      );
    }

    if (!parsed.rows.length) {
      return Response.json({
        confirmed: 0, blank: parsed.blank, problems: parsed.problems,
        message: "Nenhuma linha com valor de desconto preenchido. Nada foi confirmado.",
      });
    }

    /* As parcelas são lidas de uma vez, com o recorte de workspace e empresa:
       um identificador de outra empresa — ou de outro cliente — simplesmente
       não aparece aqui, e vira problema apontado em vez de baixa indevida. */
    const ids = parsed.rows.map((row) => row.installmentId);
    const encontradas = await d1.prepare(`SELECT installment.id, installment.entry_id, installment.competence,
        installment.planned_amount, installment.discounted_amount, installment.status,
        entry.status AS entry_status
      FROM fdp_ledger_installments installment
      JOIN fdp_ledger_entries entry
        ON entry.workspace_id = installment.workspace_id AND entry.id = installment.entry_id
      WHERE installment.workspace_id = ? AND installment.company_id = ?
        AND installment.id IN (${ids.map(() => "?").join(",")})`)
      .bind(workspace.id, String(batch.company_id), ...ids).all<Record<string, unknown>>();

    const porId = new Map(encontradas.results.map((row) => [String(row.id), row]));
    const problems = [...parsed.problems];
    const statements = [];
    let confirmadas = 0;
    let totalCents = 0;

    for (const linha of parsed.rows) {
      const parcela = porId.get(linha.installmentId);
      if (!parcela) {
        problems.push({ sheetRow: linha.sheetRow, reason: "parcela não encontrada nesta empresa" });
        continue;
      }
      if (!["approved", "active", "suspended"].includes(String(parcela.entry_status))) {
        problems.push({ sheetRow: linha.sheetRow, reason: "o lançamento desta parcela não está aprovado" });
        continue;
      }
      if (["canceled", "rescheduled", "skipped"].includes(String(parcela.status))) {
        problems.push({ sheetRow: linha.sheetRow, reason: `parcela ${String(parcela.status)} — fora da programação` });
        continue;
      }
      const previsto = toCents(Number(parcela.planned_amount ?? 0));
      const jaDescontado = toCents(Number(parcela.discounted_amount ?? 0));
      if (jaDescontado + linha.amountCents > previsto) {
        const livre = Math.max(0, previsto - jaDescontado);
        problems.push({
          sheetRow: linha.sheetRow,
          reason: livre > 0
            ? `valor acima do saldo da parcela (cabem ${fromCents(livre).toFixed(2)}); um ajuste acima do saldo é feito na tela, com justificativa`
            : "a parcela já está integralmente descontada",
        });
        continue;
      }

      const competence = String(parcela.competence);
      const chave = confirmationKey({
        installmentId: linha.installmentId, competence,
        amountCents: linha.amountCents, kind: "confirmation", batchId: id,
      });
      confirmadas += 1;
      totalCents += linha.amountCents;

      statements.push(d1.prepare(`INSERT INTO fdp_ledger_confirmations
        (id, workspace_id, installment_id, entry_id, competence, amount, kind, source, reference,
         justification, batch_id, confirmed_by, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, 'confirmation', 'return_import', ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`)
        .bind(crypto.randomUUID(), workspace.id, linha.installmentId, String(parcela.entry_id),
          competence, fromCents(linha.amountCents), reference, linha.note, id, user.id, chave));
      statements.push(d1.prepare(`INSERT INTO fdp_ledger_events
        (id, workspace_id, entry_id, installment_id, event_type, summary, payload_json, actor_user_id)
        VALUES (?, ?, ?, ?, 'confirmed', ?, ?::jsonb, ?)`)
        .bind(crypto.randomUUID(), workspace.id, String(parcela.entry_id), linha.installmentId,
          `Confirmado pelo retorno: ${fromCents(linha.amountCents).toFixed(2)}`,
          JSON.stringify({ reference, sheetRow: linha.sheetRow }), user.id));
    }

    statements.push(prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "ledger_batch.return_imported", entityType: "ledger_batch", entityId: id,
      after: { confirmed: confirmadas, amount: fromCents(totalCents) },
      metadata: { reference, blank: parsed.blank, problems: problems.length },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }));

    if (statements.length > 1) await d1.batch(statements);

    /* A contagem devolvida é lida do banco: com `ON CONFLICT DO NOTHING`, parte
       das linhas pode já estar confirmada de uma importação anterior, e relatar
       o que se tentou em vez do que aconteceu seria mentir sobre o resultado. */
    const gravadas = await d1.prepare(`SELECT COUNT(*)::int AS total,
        COALESCE(SUM(amount), 0) AS amount
      FROM fdp_ledger_confirmations
      WHERE workspace_id = ? AND batch_id = ? AND source = 'return_import'`)
      .bind(workspace.id, id).first<Record<string, unknown>>();

    return Response.json({
      confirmed: confirmadas,
      totalConfirmedInBatch: Number(gravadas?.total ?? 0),
      totalAmountInBatch: Number(gravadas?.amount ?? 0),
      blank: parsed.blank,
      problems,
    }, { status: 201 });
  } catch (error) { return apiError(error); }
}
