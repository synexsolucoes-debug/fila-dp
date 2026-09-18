import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import {
  competenceSeries, fromCents, isCompetence, planInstallments, toCents,
  type LedgerCategory, type LedgerModality,
} from "@/lib/payroll-ledger";
import { MAX_INSTALLMENTS } from "@/lib/payroll-ledger-service";

/**
 * Grava os lançamentos da importação.
 *
 * Tudo ou nada: se **qualquer** linha resolvida estiver incompleta, nada é
 * gravado e a resposta diz quais. Meia importação é pior do que nenhuma — ela
 * deixa o DP sem saber o que já entrou e o que falta, e é exatamente o estado
 * que a planilha produzia.
 *
 * ## O que acontece com `5/10`
 *
 * O lançamento nasce com as dez parcelas, e as **anteriores à corrente** nascem
 * `skipped`, com a observação de que são anteriores ao Vinculato. Elas não
 * entram no saldo e **não** são marcadas como descontadas: a planilha dizia que
 * cinco já tinham sido pagas, e a planilha não é comprovante. Se o DP quiser
 * registrar que foram, confirma cada uma pela porta de sempre, com nome e hora.
 *
 * ## Reimportação
 *
 * O índice único parcial em `(workspace, row_hash) WHERE entry_id IS NOT NULL`
 * impede que a mesma linha vire dois lançamentos — mas ele é a última trava, e
 * não a primeira. Deixar a gravação esbarrar nele derrubaria o lote inteiro por
 * causa de uma linha repetida, e quem reimporta o mesmo arquivo para pegar as
 * linhas que faltavam receberia um erro de banco no lugar do trabalho feito.
 * Por isso a consulta abaixo já descarta as linhas cujo texto virou lançamento
 * em alguma importação anterior, e a resposta as reporta em separado.
 *
 * O que ancora isso é o `row_hash`: ele nasce do conteúdo do arquivo mais a aba
 * e a linha de origem, então o mesmo arquivo lido de novo produz exatamente os
 * mesmos hashes. **O limite é honesto**: um arquivo diferente com o mesmo
 * conteúdo — a mesma planilha salva de novo, por exemplo — gera hashes
 * diferentes e não é reconhecido como repetição. Contra isso a defesa é a
 * revisão da prévia, que mostra pessoa, valor e competência antes de gravar.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { id } = await params;
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.import", "gravar os lançamentos da importação");

    const importacao = await d1.prepare(`SELECT id, status, entry_competence, mapping_json, filename
      FROM fdp_ledger_imports WHERE workspace_id = ? AND id = ?`)
      .bind(workspace.id, id).first<Record<string, unknown>>();
    if (!importacao) throw ApiError.notFound("Importação não encontrada.", "LEDGER_IMPORT_NOT_FOUND");
    if (String(importacao.status) === "committed") {
      throw ApiError.badRequest("Esta importação já foi gravada.", "LEDGER_IMPORT_COMMITTED");
    }
    if (String(importacao.status) === "canceled") {
      throw ApiError.badRequest("Esta importação foi cancelada.", "LEDGER_IMPORT_CANCELED");
    }

    const mapping = (importacao.mapping_json ?? {}) as { companyId?: string };
    const companyId = String(mapping.companyId ?? "");
    if (!companyId) throw ApiError.badRequest("A importação não tem empresa de destino.", "LEDGER_COMPANY_REQUIRED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);

    const entryCompetence = String(importacao.entry_competence);

    const linhas = await d1.prepare(`SELECT row.id, row.sheet_name, row.row_number, row.employee_id,
        row.parsed_json, row.row_hash, row.entry_id
      FROM fdp_ledger_import_rows row
      WHERE row.workspace_id = ? AND row.import_id = ? AND row.resolution = 'resolved'
        AND row.entry_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM fdp_ledger_import_rows anterior
          WHERE anterior.workspace_id = row.workspace_id
            AND anterior.row_hash = row.row_hash
            AND anterior.row_hash <> ''
            AND anterior.entry_id IS NOT NULL
        )
      ORDER BY row.sheet_name, row.row_number`)
      .bind(workspace.id, id).all<Record<string, unknown>>();

    /* Quantas ficaram de fora por já terem virado lançamento antes. É o número
       que distingue "não havia nada a gravar" de "já estava tudo gravado", e
       são duas respostas muito diferentes para quem reimporta. */
    const repetidas = await d1.prepare(`SELECT COUNT(*)::int AS total
      FROM fdp_ledger_import_rows row
      WHERE row.workspace_id = ? AND row.import_id = ? AND row.resolution = 'resolved'
        AND row.entry_id IS NULL
        AND EXISTS (
          SELECT 1 FROM fdp_ledger_import_rows anterior
          WHERE anterior.workspace_id = row.workspace_id
            AND anterior.row_hash = row.row_hash
            AND anterior.row_hash <> ''
            AND anterior.entry_id IS NOT NULL
        )`).bind(workspace.id, id).first<{ total: number }>();
    const jaGravadas = Number(repetidas?.total ?? 0);

    if (!linhas.results.length && jaGravadas > 0) {
      /* Nada a fazer, e isso é sucesso: a importação anterior já cobriu estas
         linhas. Recusar com erro faria a pessoa procurar um defeito que não
         existe — e, pior, tentar de novo. */
      await d1.batch([
        d1.prepare(`UPDATE fdp_ledger_imports SET status = 'committed', committed_by = ?, committed_at = now()
          WHERE workspace_id = ? AND id = ?`).bind(user.id, workspace.id, id),
        prepareAuditEvent({
          workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
          action: "ledger_import.committed", entityType: "ledger_import", entityId: id,
          after: { entries: 0, entryCompetence },
          metadata: { companyId, alreadyImported: jaGravadas },
          requestId: request.headers.get("x-fila-dp-request-id"),
        }),
      ]);
      return Response.json({
        committed: 0, attempted: 0, priorInstallmentsAsHistory: 0, alreadyImported: jaGravadas,
      }, { status: 200 });
    }

    if (!linhas.results.length) {
      const pendentes = await d1.prepare(`SELECT COUNT(*)::int AS total FROM fdp_ledger_import_rows
        WHERE workspace_id = ? AND import_id = ? AND resolution = 'pending'`)
        .bind(workspace.id, id).first<{ total: number }>();
      throw ApiError.badRequest(
        Number(pendentes?.total ?? 0) > 0
          ? `Nenhuma linha foi resolvida ainda. ${pendentes?.total} continuam pendentes — resolva-as ou marque-as como ignoradas.`
          : "Não há linhas resolvidas a gravar.",
        "LEDGER_IMPORT_NOTHING_TO_COMMIT",
      );
    }

    /* Primeira passada: valida tudo. Nada é gravado enquanto uma linha
       resolvida estiver incompleta — a resposta aponta a aba e a linha. */
    type Preparada = {
      rowId: string;
      employeeId: string;
      rowHash: string;
      category: LedgerCategory;
      modality: LedgerModality;
      title: string;
      sourceText: string;
      totalCents: number | null;
      installmentCount: number | null;
      currentInstallment: number | null;
      firstCompetence: string;
      unitLabel: string;
      departmentLabel: string;
      operationLabel: string;
    };
    const preparadas: Preparada[] = [];
    const problemas: { sheetName: string; rowNumber: number; reason: string }[] = [];

    for (const linha of linhas.results) {
      const parsed = (linha.parsed_json ?? {}) as Record<string, unknown>;
      const escolhido = (parsed.chosen ?? null) as Record<string, unknown> | null;
      const referencia = { sheetName: String(linha.sheet_name), rowNumber: Number(linha.row_number) };
      if (!escolhido) {
        problemas.push({ ...referencia, reason: "a linha está marcada como resolvida mas não tem lançamento escolhido" });
        continue;
      }
      const employeeId = linha.employee_id ? String(linha.employee_id) : "";
      if (!employeeId) {
        problemas.push({ ...referencia, reason: "sem pessoa escolhida" });
        continue;
      }

      const category = String(escolhido.category ?? "") as LedgerCategory;
      const modality = String(escolhido.modality ?? "single") as LedgerModality;
      const firstCompetence = String(escolhido.firstCompetence ?? "") || entryCompetence;
      if (!isCompetence(firstCompetence)) {
        problemas.push({ ...referencia, reason: "competência de início inválida" });
        continue;
      }

      let totalCents: number | null = null;
      let installmentCount: number | null = null;
      if (modality !== "recurring") {
        const bruto = escolhido.totalAmount;
        if (bruto === null || bruto === undefined || bruto === "") {
          problemas.push({ ...referencia, reason: "sem valor total" });
          continue;
        }
        try { totalCents = toCents(typeof bruto === "number" ? bruto : String(bruto)); }
        catch { problemas.push({ ...referencia, reason: "valor total ilegível" }); continue; }
        if (!(totalCents > 0)) { problemas.push({ ...referencia, reason: "valor total menor ou igual a zero" }); continue; }

        installmentCount = modality === "single" ? 1 : Math.trunc(Number(escolhido.installmentCount ?? 0));
        if (!Number.isInteger(installmentCount) || installmentCount < 1) {
          problemas.push({ ...referencia, reason: "quantidade de parcelas inválida" });
          continue;
        }
        if (installmentCount > MAX_INSTALLMENTS) {
          problemas.push({ ...referencia, reason: `acima do limite de ${MAX_INSTALLMENTS} parcelas` });
          continue;
        }
        if (installmentCount > totalCents) {
          problemas.push({ ...referencia, reason: "o total não se divide na quantidade de parcelas" });
          continue;
        }
      }

      const currentInstallment = Number(escolhido.currentInstallment ?? 0) || null;
      if (currentInstallment && installmentCount && currentInstallment > installmentCount) {
        problemas.push({ ...referencia, reason: "a parcela corrente é maior que a quantidade de parcelas" });
        continue;
      }

      preparadas.push({
        rowId: String(linha.id),
        employeeId,
        rowHash: String(linha.row_hash ?? ""),
        category,
        modality,
        title: String(escolhido.title ?? "Importado da planilha").slice(0, 180),
        sourceText: String(escolhido.sourceText ?? "").slice(0, 1000),
        totalCents,
        installmentCount,
        currentInstallment,
        firstCompetence,
        unitLabel: String(parsed.unit ?? "").slice(0, 120),
        departmentLabel: String(parsed.department ?? "").slice(0, 120),
        operationLabel: String(parsed.operation ?? "").slice(0, 120),
      });
    }

    if (problemas.length) {
      throw new ApiError(409, "LEDGER_IMPORT_INCOMPLETE",
        `${problemas.length} linha(s) resolvida(s) estão incompletas. Nada foi gravado — corrija e tente novamente.`,
        { problems: problemas.slice(0, 50) });
    }

    const requestId = request.headers.get("x-fila-dp-request-id");
    const statements = [];
    let parcelasAnteriores = 0;

    for (const preparada of preparadas) {
      const entryId = crypto.randomUUID();
      statements.push(d1.prepare(`INSERT INTO fdp_ledger_entries
        (id, workspace_id, company_id, employee_id, employment_type_snapshot, department_id, department_label,
         unit_label, operation_label, category, title, description, reason,
         requested_on, requested_by, total_amount, modality, installment_count,
         first_competence, expected_end_competence, settlement_target, status,
         origin_type, origin_id, details_json, approved_by, approved_at, created_by, updated_by)
        SELECT ?, ?, employee.company_id, employee.id, COALESCE(employee.employment_type, ''),
          employee.department_id, ?, ?, ?, ?, ?, ?, ?,
          CURRENT_DATE, ?, ?, ?, ?, ?, ?, 'payroll', 'active',
          'import', ?, ?::jsonb, ?, now(), ?, ?
        FROM fdp_employees employee
        WHERE employee.workspace_id = ? AND employee.company_id = ? AND employee.id = ?`)
        .bind(entryId, workspace.id, preparada.departmentLabel, preparada.unitLabel, preparada.operationLabel,
          preparada.category, preparada.title,
          /* O texto original da planilha vira a descrição do lançamento: quem
             abrir daqui a um ano lê o que estava escrito, não a interpretação. */
          preparada.sourceText, `Importado de ${String(importacao.filename)}`,
          user.id, preparada.totalCents === null ? null : fromCents(preparada.totalCents),
          preparada.modality, preparada.installmentCount, preparada.firstCompetence,
          preparada.installmentCount
            ? competenceSeries(preparada.firstCompetence, preparada.installmentCount).at(-1)
            : null,
          `${id}:${preparada.rowId}`,
          JSON.stringify({ sourceText: preparada.sourceText, importId: id, rowId: preparada.rowId }),
          user.id, user.id, user.id,
          workspace.id, companyId, preparada.employeeId));

      if (preparada.totalCents !== null && preparada.installmentCount) {
        const plano = planInstallments({
          totalCents: preparada.totalCents,
          count: preparada.installmentCount,
          firstCompetence: preparada.firstCompetence,
        });
        for (const parte of plano) {
          /* As parcelas anteriores à corrente nascem `skipped`, e não
             descontadas: a planilha dizia que já tinham sido pagas, e a
             planilha não é comprovante. Quem quiser registrar que foram
             confirma cada uma pela porta de sempre. */
          const anterior = preparada.currentInstallment !== null && parte.number < preparada.currentInstallment;
          if (anterior) parcelasAnteriores += 1;
          statements.push(d1.prepare(`INSERT INTO fdp_ledger_installments
            (id, workspace_id, entry_id, company_id, number, total_count, competence, planned_amount, status, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(crypto.randomUUID(), workspace.id, entryId, companyId, parte.number, parte.totalCount,
              parte.competence, fromCents(parte.plannedCents),
              anterior ? "skipped" : "scheduled",
              anterior ? "Anterior ao Vinculato: histórico da planilha, sem confirmação de desconto." : ""));
        }
      }

      statements.push(d1.prepare(`INSERT INTO fdp_ledger_events
        (id, workspace_id, entry_id, event_type, summary, payload_json, actor_user_id)
        VALUES (?, ?, ?, 'imported', ?, ?::jsonb, ?)`)
        .bind(crypto.randomUUID(), workspace.id, entryId,
          `Importado de ${String(importacao.filename)}`,
          JSON.stringify({ importId: id, rowId: preparada.rowId, sourceText: preparada.sourceText }), user.id));

      /* O `row_hash` só ganha efeito de unicidade quando `entry_id` existe: é
         esta linha que fecha a porta da reimportação duplicada. */
      statements.push(d1.prepare(`UPDATE fdp_ledger_import_rows SET entry_id = ?
        WHERE workspace_id = ? AND id = ? AND entry_id IS NULL`)
        .bind(entryId, workspace.id, preparada.rowId));
    }

    statements.push(
      d1.prepare(`UPDATE fdp_ledger_imports SET status = 'committed', committed_by = ?, committed_at = now()
        WHERE workspace_id = ? AND id = ?`).bind(user.id, workspace.id, id),
      prepareAuditEvent({
        workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
        action: "ledger_import.committed", entityType: "ledger_import", entityId: id,
        after: { entries: preparadas.length, entryCompetence },
        metadata: { companyId, skippedPriorInstallments: parcelasAnteriores, alreadyImported: jaGravadas },
        requestId,
      }),
    );

    await d1.batch(statements);

    /* A contagem vem do banco: uma linha cujo hash já existia de uma
       importação anterior não gravou, e relatar o que se tentou em vez do que
       aconteceu seria mentir sobre o resultado. */
    const gravadas = await d1.prepare(`SELECT COUNT(*)::int AS total FROM fdp_ledger_import_rows
      WHERE workspace_id = ? AND import_id = ? AND entry_id IS NOT NULL`)
      .bind(workspace.id, id).first<{ total: number }>();

    return Response.json({
      committed: Number(gravadas?.total ?? 0),
      attempted: preparadas.length,
      /* As parcelas anteriores à corrente entraram como histórico, não como
         desconto realizado. A tela precisa dizer isso, não escondê-lo. */
      priorInstallmentsAsHistory: parcelasAnteriores,
      alreadyImported: jaGravadas,
    }, { status: 201 });
  } catch (error) { return apiError(error); }
}
