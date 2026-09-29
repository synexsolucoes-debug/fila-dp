import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent, requireCompanyAccess } from "@/lib/fila-dp-db";
import { requireNamedCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cleanText } from "@/lib/clean-text";
import { MAX_IMPORT_SHEETS, parseImportRows, totalsOf } from "@/lib/ledger-import";
import { isCompetence } from "@/lib/payroll-ledger";
import { protectCpf } from "@/lib/registrations";

/**
 * Importação assistida da planilha: leitura e prévia.
 *
 * O arquivo **não é guardado**. O que fica é a interpretação, linha a linha,
 * com o texto original ao lado — e nenhuma delas vira lançamento aqui. Gravar é
 * outro passo, outra rota, depois de alguém resolver as ambiguidades.
 *
 * ## Por que a competência de entrada existe
 *
 * A planilha do cliente tem 87 abas cobrindo sete anos. Importá-la inteira
 * recriaria sete anos de pagamentos que já aconteceram. A competência de
 * entrada é o corte: dela em diante o Vinculato controla; o que é anterior fica
 * como saldo inicial a confirmar, e o histórico antigo continua na planilha,
 * para consulta.
 *
 * ## Identificação de pessoa
 *
 * Por CPF, quando a planilha traz — comparado pelo mesmo HMAC que o cadastro
 * usa, então o CPF em claro nunca é gravado nem devolvido. Sem CPF, a linha
 * fica com a pessoa em aberto e **exige** escolha humana: nome não identifica
 * alguém numa base com 721 grafias distintas e homônimos reais.
 */
export async function POST(request: Request) {
  const auth = await getApiUser(); if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireNamedCapability(workspace, "ledger.import", "importar a planilha de vales e descontos");

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) throw ApiError.badRequest("Envie a leitura da planilha.", "LEDGER_IMPORT_PAYLOAD_REQUIRED");

    const filename = cleanText(body.filename, 200) || "planilha.xlsx";
    const fileHash = cleanText(body.fileHash, 64);
    if (!/^[0-9a-f]{64}$/u.test(fileHash)) {
      throw ApiError.badRequest("A leitura da planilha veio sem identificação de arquivo.", "LEDGER_IMPORT_HASH_REQUIRED");
    }

    const companyId = cleanText(body.companyId, 120);
    const entryCompetence = cleanText(body.entryCompetence, 7);
    const sheetNames = Array.isArray(body.sheetNames)
      ? body.sheetNames.map((value) => cleanText(value, 200)).filter(Boolean).slice(0, MAX_IMPORT_SHEETS)
      : [];
    if (!sheetNames.length) {
      throw ApiError.badRequest("Escolha ao menos uma aba para importar.", "LEDGER_IMPORT_SHEETS_REQUIRED");
    }

    /* O teto continua existindo mesmo com a leitura vindo do cliente: confiar
       no conteúdo não é aceitar qualquer volume. Acima disto a importação vira
       um lote que ninguém revisa de verdade — e revisar é o passo que dá valor
       a ela. */
    const rows = parseImportRows(body.rows);
    if (!rows.length) {
      throw ApiError.badRequest(
        "Nenhuma linha com pessoa foi encontrada nas abas escolhidas.",
        "LEDGER_IMPORT_NO_ROWS",
      );
    }

    if (!companyId) throw ApiError.badRequest("Selecione a empresa de destino.", "LEDGER_COMPANY_REQUIRED");
    await requireCompanyAccess(d1, workspace.id, user.id, workspace.role, companyId);
    if (!isCompetence(entryCompetence)) {
      throw ApiError.badRequest(
        "Informe a competência de entrada no formato AAAA-MM — é a partir dela que o Vinculato passa a controlar.",
        "INVALID_LEDGER_COMPETENCE",
      );
    }

    /* O CPF vira HMAC antes de qualquer comparação, com a mesma chave do
       cadastro. Um CPF inválido na planilha não derruba a importação: a linha
       fica sem identificação e exige escolha humana, como as sem CPF. */
    const porHash = new Map<string, string>();
    for (const row of rows) {
      if (!row.taxId) continue;
      try {
        const { cpfHash } = protectCpf(row.taxId);
        if (cpfHash) porHash.set(cpfHash, row.rowHash);
      } catch { /* CPF inválido: segue sem identificação. */ }
    }

    const encontrados = new Map<string, { id: string; name: string }>();
    if (porHash.size) {
      const hashes = [...porHash.keys()];
      const pessoas = await d1.prepare(`SELECT employee.id, employee.full_name, employee.cpf_hash
        FROM fdp_employees employee
        WHERE employee.workspace_id = ? AND employee.company_id = ?
          AND employee.cpf_hash IN (${hashes.map(() => "?").join(",")})`)
        .bind(workspace.id, companyId, ...hashes).all<Record<string, unknown>>();
      for (const pessoa of pessoas.results) {
        encontrados.set(String(pessoa.cpf_hash), { id: String(pessoa.id), name: String(pessoa.full_name) });
      }
    }

    const importId = crypto.randomUUID();
    const statements = [
      d1.prepare(`INSERT INTO fdp_ledger_imports
        (id, workspace_id, filename, file_hash, entry_competence, mapping_json, totals_json, status, created_by)
        VALUES (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, 'previewed', ?)`)
        .bind(importId, workspace.id, filename, fileHash, entryCompetence,
          JSON.stringify({ companyId, sheetNames }), JSON.stringify(totalsOf(rows)), user.id),
    ];

    let identificadas = 0;
    for (const row of rows) {
      let employeeId: string | null = null;
      if (row.taxId) {
        try {
          const { cpfHash } = protectCpf(row.taxId);
          const achado = cpfHash ? encontrados.get(cpfHash) : undefined;
          if (achado) { employeeId = achado.id; identificadas += 1; }
        } catch { /* segue sem identificação */ }
      }

      const ambiguidades = [...row.ambiguities];
      if (!employeeId) {
        ambiguidades.push({
          code: "employee_unresolved",
          message: row.taxId
            ? "O CPF desta linha não corresponde a nenhum colaborador desta empresa. Escolha a pessoa à mão."
            : "Sem CPF na planilha: escolha a pessoa à mão. Nome sozinho não identifica alguém.",
        });
      }

      statements.push(d1.prepare(`INSERT INTO fdp_ledger_import_rows
        (id, workspace_id, import_id, sheet_name, row_number, block_label, raw_json, parsed_json,
         ambiguities_json, resolution, employee_id, row_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, 'pending', ?, ?)`)
        .bind(crypto.randomUUID(), workspace.id, importId, row.sheetName, row.rowNumber,
          row.blockLabel.slice(0, 200),
          /* O texto original inteiro, com a aba e a linha de onde veio. É a
             referência de quem for conferir a interpretação depois. O CPF em
             claro sai: ele já cumpriu o papel de identificar. */
          JSON.stringify({ ...row.raw, __employeeName: row.employeeName, __taxId: row.taxId ? `***${row.taxId.slice(-2)}` : "" }),
          JSON.stringify({
            employeeName: row.employeeName, unit: row.unit, department: row.department,
            operation: row.operation, blockTaxId: row.blockTaxId,
            advanceAmount: row.advanceAmount, candidates: row.candidates,
          }),
          JSON.stringify(ambiguidades), employeeId, row.rowHash));
    }

    statements.push(prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "ledger_import.previewed", entityType: "ledger_import", entityId: importId,
      after: { entryCompetence, sheets: sheetNames.length, rows: rows.length },
      metadata: { companyId, identified: identificadas, filename },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }));

    await d1.batch(statements);

    return Response.json({
      importId,
      totals: { ...totalsOf(rows), identified: identificadas, unidentified: rows.length - identificadas },
      saved: true,
    }, { status: 201 });
  } catch (error) { return apiError(error); }
}
