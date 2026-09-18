"use client";

import { useRef, useState } from "react";
import {
  CheckCircle2, FileSpreadsheet, Info, Loader2, TriangleAlert, Upload, X,
} from "lucide-react";
import { formatBRL, formatCompetence, ledgerCategoryLabels } from "@/lib/payroll-ledger";
import type { LedgerCategory } from "@/lib/payroll-ledger";
import { EmptyState } from "../shared/panel-ui";
import styles from "./ledger.module.css";
import type {
  LedgerImport, LedgerImportCandidate, LedgerImportCommitResult, LedgerImportRow, LedgerImportTotals,
} from "./ledger.api";
import type { LedgerCompanyOption, LedgerPermissions, LedgerPersonOption } from "./ledger.types";

/**
 * Importação assistida da planilha de vales.
 *
 * O caminho é de sete passos e nenhum deles é automático, porque a planilha de
 * origem não é um arquivo de dados: é sete anos de anotação humana, com blocos
 * empilhados na mesma aba, colunas que mudam de significado no meio e valores
 * escritos de cinco formas diferentes. Ler isso sem perguntar produziria dívida
 * que ninguém contraiu.
 *
 * Três recusas deliberadas, que a tela diz em voz alta:
 *
 *  * **`5/10` não vira cinco parcelas descontadas.** Vira um lançamento de dez
 *    parcelas com as cinco primeiras marcadas como anteriores ao Vinculato. A
 *    planilha dizia que foram pagas; a planilha não é comprovante;
 *  * **"lançado" não é prova de desconto.** Linha com essa palavra fica
 *    ambígua e espera decisão humana;
 *  * **nome não identifica ninguém.** Sem CPF na planilha, a pessoa é escolhida
 *    à mão. A base tem homônimos reais.
 */
export function ImportPanel({
  companies, people, permissions, busy, importacao, rows, totals, commitResult,
  onPickFile, onPreview, onLoadRows, onResolve, onIgnore, onCommit, onCancel, onReset,
  sheets, file, entryCompetence, companyId,
  onCompetenceChange, onCompanyChange,
}: {
  companies: LedgerCompanyOption[];
  people: LedgerPersonOption[];
  permissions: LedgerPermissions | undefined;
  busy: boolean;
  importacao: LedgerImport | null;
  rows: LedgerImportRow[];
  totals: LedgerImportTotals | null;
  commitResult: LedgerImportCommitResult | null;
  sheets: string[];
  file: File | null;
  entryCompetence: string;
  companyId: string;
  onPickFile: (file: File) => void;
  onPreview: (sheetNames: string[]) => void;
  onLoadRows: (resolution: string) => void;
  onResolve: (rowId: string, employeeId: string, candidate: LedgerImportCandidate) => void;
  onIgnore: (rowId: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onReset: () => void;
  onCompetenceChange: (value: string) => void;
  onCompanyChange: (value: string) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [escolhidas, setEscolhidas] = useState<string[]>([]);
  const [recorte, setRecorte] = useState("pending");
  /* A escolha de pessoa e de proposta vive por linha e só aqui: enquanto não
     for enviada, ela não é decisão de ninguém. */
  const [pessoaPorLinha, setPessoaPorLinha] = useState<Record<string, string>>({});
  const [propostaPorLinha, setPropostaPorLinha] = useState<Record<string, number>>({});

  if (!permissions?.import) {
    return (
      <EmptyState
        icon={FileSpreadsheet}
        title="Sem permissão para importar"
        text="A importação da planilha exige a permissão própria de importação, separada da de lançar e da de confirmar desconto."
      />
    );
  }

  /* Passo 1 e 2: o arquivo e as abas. Enquanto não houver importação aberta,
     esta é a tela inteira. */
  if (!importacao) {
    return (
      <div className={styles.importWizard}>
        <ol className={styles.importSteps}>
          <li aria-current={!file ? "step" : undefined}>1. Escolher o arquivo</li>
          <li aria-current={file && !sheets.length ? "step" : undefined}>2. Ler as abas</li>
          <li aria-current={sheets.length ? "step" : undefined}>3. Empresa e competência de entrada</li>
          <li>4. Conferir a prévia</li>
          <li>5. Identificar as pessoas</li>
          <li>6. Resolver as ambiguidades</li>
          <li>7. Gravar</li>
        </ol>

        <div className={styles.notice}>
          <Upload aria-hidden="true" />
          <span>
            O arquivo <strong>não é guardado</strong>. O que fica é a interpretação de cada linha, com o texto original
            ao lado — e nenhuma delas vira lançamento antes do último passo.
          </span>
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx"
            hidden
            onChange={(event) => {
              const escolhido = event.target.files?.[0];
              if (escolhido) { setEscolhidas([]); onPickFile(escolhido); }
              event.target.value = "";
            }}
          />
          <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => fileInput.current?.click()}>
            {busy ? <Loader2 aria-hidden="true" className={styles.spin} /> : <Upload aria-hidden="true" />}
            {file ? "Trocar arquivo" : "Escolher planilha"}
          </button>
        </div>

        {file && (
          <p className={styles.notice}>
            <FileSpreadsheet aria-hidden="true" />
            <span><strong>{file.name}</strong> — {sheets.length} aba(s) encontrada(s).</span>
          </p>
        )}

        {sheets.length > 0 && (
          <>
            <div className={styles.formGrid}>
              <label>
                Empresa de destino
                <select value={companyId} onChange={(event) => onCompanyChange(event.target.value)}>
                  <option value="">Selecione</option>
                  {companies.map((company) => (
                    <option key={company.id} value={company.id}>{company.name}</option>
                  ))}
                </select>
                <span className={styles.fieldHint}>
                  A pessoa é procurada dentro desta empresa. Empresa errada não acha ninguém — e não inventa ninguém.
                </span>
              </label>
              <label>
                Competência de entrada
                <input
                  value={entryCompetence}
                  onChange={(event) => onCompetenceChange(event.target.value)}
                  placeholder="2026-09"
                  inputMode="numeric"
                />
                <span className={styles.fieldHint}>
                  O corte: daqui em diante o Vinculato controla. O que é anterior entra como histórico, sem recriar
                  pagamento que já aconteceu.
                </span>
              </label>
            </div>

            <fieldset className={styles.sheetPicker}>
              <legend>Abas a importar</legend>
              <p className={styles.fieldHint}>
                Escolha só o que ainda vale. Importar sete anos de abas recriaria sete anos de descontos já feitos.
              </p>
              <div className={styles.sheetGrid}>
                {sheets.map((sheet) => (
                  <label key={sheet} className={styles.checkboxFilter}>
                    <input
                      type="checkbox"
                      checked={escolhidas.includes(sheet)}
                      onChange={(event) => setEscolhidas((atual) => event.target.checked
                        ? [...atual, sheet]
                        : atual.filter((nome) => nome !== sheet))}
                    />
                    {sheet}
                  </label>
                ))}
              </div>
            </fieldset>

            <div className={styles.formActions}>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={busy || !escolhidas.length || !companyId || !/^\d{4}-\d{2}$/u.test(entryCompetence)}
                onClick={() => onPreview(escolhidas)}
              >
                {busy ? <Loader2 aria-hidden="true" className={styles.spin} /> : <FileSpreadsheet aria-hidden="true" />}
                Montar a prévia de {escolhidas.length} aba(s)
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  const gravada = importacao.status === "committed";
  const cancelada = importacao.status === "canceled";
  const pendentes = totals ? totals.total - totals.resolved - totals.ignored : 0;

  return (
    <div className={styles.importWizard}>
      <div className={styles.tableTools}>
        <span>
          <strong>{importacao.filename}</strong> · entrada em {formatCompetence(importacao.entry_competence)}
        </span>
        {totals && (
          <span>
            {totals.total} linha(s) · {totals.resolved} resolvida(s) · {totals.ignored} ignorada(s) ·{" "}
            {pendentes} pendente(s) · {totals.unidentified} sem pessoa
          </span>
        )}
      </div>

      {commitResult && (
        <p className={styles.notice} data-tone="safe">
          <CheckCircle2 aria-hidden="true" />
          <span>
            {commitResult.committed} lançamento(s) gravado(s).
            {commitResult.priorInstallmentsAsHistory > 0 && (
              <>
                {" "}{commitResult.priorInstallmentsAsHistory} parcela(s) anteriores entraram como{" "}
                <strong>histórico da planilha</strong>, não como desconto confirmado — se foram mesmo descontadas,
                confirme cada uma pela tela de parcelas.
              </>
            )}
            {commitResult.alreadyImported > 0 && (
              <> {commitResult.alreadyImported} linha(s) já tinham sido gravadas numa importação anterior e não viraram
              lançamento de novo.</>
            )}
          </span>
        </p>
      )}

      {cancelada && (
        <p className={styles.notice} data-tone="warning">
          <TriangleAlert aria-hidden="true" />
          <span>Esta importação foi cancelada. As linhas ficam registradas, e nenhuma virou lançamento.</span>
        </p>
      )}

      {!gravada && !cancelada && (
        <p className={styles.notice}>
          <Info aria-hidden="true" />
          <span>
            Uma linha só fica pronta quando tem <strong>pessoa</strong> e <strong>proposta</strong>. A gravação é tudo
            ou nada: se qualquer linha resolvida estiver incompleta, nada é gravado e a resposta diz quais.
          </span>
        </p>
      )}

      <div className={styles.filters}>
        <label>
          Mostrar
          <select
            value={recorte}
            onChange={(event) => { setRecorte(event.target.value); onLoadRows(event.target.value); }}
          >
            <option value="">Todas as linhas</option>
            <option value="pending">Pendentes</option>
            <option value="resolved">Resolvidas</option>
            <option value="ignored">Ignoradas</option>
          </select>
        </label>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="Nenhuma linha neste recorte"
          text="Troque o recorte para ver as linhas resolvidas, as ignoradas ou todas."
        />
      ) : (
        <ul className={styles.importRows}>
          {rows.map((row) => {
            const propostas = row.parsed_json.candidates ?? [];
            const indice = propostaPorLinha[row.id] ?? 0;
            const proposta = propostas[indice];
            const pessoa = pessoaPorLinha[row.id] ?? row.employee_id ?? "";
            const avisos = [...(row.ambiguities_json ?? []), ...(proposta?.ambiguities ?? [])];

            return (
              <li key={row.id} className={styles.importRow} data-resolution={row.resolution}>
                <header>
                  <strong>{row.parsed_json.employeeName || "—"}</strong>
                  <small>
                    {row.sheet_name} · linha {row.row_number}
                    {row.block_label ? ` · ${row.block_label}` : ""}
                  </small>
                </header>

                {/* O texto original da planilha, intocado. É a referência de
                    quem for conferir de onde a interpretação saiu. */}
                <blockquote className={styles.importSource}>
                  {Object.entries(row.raw_json ?? {})
                    .filter(([chave, valor]) => !chave.startsWith("__") && valor)
                    .map(([chave, valor]) => <span key={chave}><b>{chave}:</b> {valor}</span>)}
                </blockquote>

                {avisos.length > 0 && (
                  <ul className={styles.importWarnings}>
                    {avisos.map((aviso) => (
                      <li key={aviso.code}><TriangleAlert aria-hidden="true" /> {aviso.message}</li>
                    ))}
                  </ul>
                )}

                {row.entry_id ? (
                  <p className={styles.importDone}>
                    <CheckCircle2 aria-hidden="true" /> Já virou lançamento.
                  </p>
                ) : gravada || cancelada ? (
                  <p className={styles.fieldHint}>
                    {row.resolution === "ignored" ? "Ignorada." : "Não gravada."}
                  </p>
                ) : (
                  <div className={styles.importDecision}>
                    <label>
                      Pessoa
                      <select
                        value={pessoa}
                        onChange={(event) => setPessoaPorLinha((atual) => ({ ...atual, [row.id]: event.target.value }))}
                      >
                        <option value="">Escolher…</option>
                        {people.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.name}{option.registrationNumber ? ` · ${option.registrationNumber}` : ""}
                          </option>
                        ))}
                      </select>
                    </label>

                    {propostas.length > 0 ? (
                      <label>
                        Lançamento
                        <select
                          value={String(indice)}
                          onChange={(event) => setPropostaPorLinha((atual) => ({
                            ...atual, [row.id]: Number(event.target.value),
                          }))}
                        >
                          {propostas.map((item, posicao) => (
                            <option key={`${row.id}-${posicao}`} value={posicao}>
                              {ledgerCategoryLabels[item.category as LedgerCategory] ?? item.category}
                              {item.totalAmount !== null ? ` · ${formatBRL(item.totalAmount)}` : " · recorrente"}
                              {item.installmentCount ? ` · ${item.installmentCount}×` : ""}
                              {item.firstCompetence ? ` · ${formatCompetence(item.firstCompetence)}` : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <p className={styles.fieldHint}>
                        Nenhuma proposta legível nesta linha. Ignore-a e lance à mão, se ela significar alguma coisa.
                      </p>
                    )}

                    <div className={styles.importActions}>
                      <button
                        type="button"
                        className={styles.primaryButton}
                        disabled={busy || !pessoa || !proposta}
                        onClick={() => onResolve(row.id, pessoa, proposta!)}
                      >
                        <CheckCircle2 aria-hidden="true" /> Resolver
                      </button>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        disabled={busy}
                        onClick={() => onIgnore(row.id)}
                      >
                        <X aria-hidden="true" /> Ignorar
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className={styles.formActions}>
        {!gravada && !cancelada && (
          <>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={busy || !totals?.resolved}
              onClick={onCommit}
            >
              {busy ? <Loader2 aria-hidden="true" className={styles.spin} /> : <CheckCircle2 aria-hidden="true" />}
              Gravar {totals?.resolved ?? 0} linha(s) resolvida(s)
            </button>
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onCancel}>
              Cancelar importação
            </button>
          </>
        )}
        <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onReset}>
          Importar outra planilha
        </button>
      </div>
    </div>
  );
}
