"use client";

import { useMemo, useState } from "react";
import { Info, Loader2 } from "lucide-react";
import {
  formatBRL, formatCompetence, fromCents, ledgerCategories, ledgerCategoryFields,
  ledgerCategoryLabels, planInstallments, toCents,
} from "@/lib/payroll-ledger";
import type { LedgerCategory, LedgerModality } from "@/lib/payroll-ledger";
import styles from "./ledger.module.css";
import type {
  LedgerAreaOption, LedgerCompanyOption, LedgerEntryDraft, LedgerPersonOption,
} from "./ledger.types";

const modalityLabels: Record<LedgerModality, string> = {
  single: "Único — desconta em uma competência",
  installments: "Parcelado — valor total dividido em parcelas",
  recurring: "Recorrente — repete todo mês enquanto a regra valer",
};

function currentCompetence() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function emptyDraft(companyId: string): LedgerEntryDraft {
  return {
    companyId,
    subjectKind: "employee",
    employeeId: "",
    providerId: "",
    category: "loan",
    title: "",
    description: "",
    reason: "",
    occurredOn: "",
    requestedOn: new Date().toISOString().slice(0, 10),
    unitLabel: "",
    operationLabel: "",
    requesterAreaId: "",
    modality: "installments",
    totalAmount: "",
    installmentCount: "",
    firstCompetence: currentCompetence(),
    recurrenceEndCompetence: "",
    details: {},
  };
}

/**
 * O formulário de um lançamento.
 *
 * Duas decisões de tela, e as duas existem por causa da planilha que este
 * módulo substitui:
 *
 *  1. **os campos extras são da categoria.** A multa pede placa e auto de
 *     infração; o desconto genérico não pede nada. Mostrar os trinta campos
 *     para todo mundo é como a célula de texto livre nasceu — o formulário
 *     longo demais empurra a pessoa para escrever tudo numa observação;
 *
 *  2. **a prévia do parcelamento aparece antes de salvar.** R$ 1.000,00 em 3×
 *     mostra 333,34 + 333,33 + 333,33 na tela, com a competência de cada uma.
 *     Quem lança confere a divisão do centavo agora, e não quando o
 *     colaborador reclamar da última parcela.
 */
export function LedgerEntryDialog({
  draft, companies, people, areas, busy, error, onChange, onCancel, onSubmit,
}: {
  draft: LedgerEntryDraft;
  companies: LedgerCompanyOption[];
  people: LedgerPersonOption[];
  areas: LedgerAreaOption[];
  busy: boolean;
  error: string;
  onChange: (next: LedgerEntryDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const [touched, setTouched] = useState(false);
  const set = <K extends keyof LedgerEntryDraft>(key: K, value: LedgerEntryDraft[K]) =>
    onChange({ ...draft, [key]: value });

  const categoryFields = ledgerCategoryFields[draft.category];

  /**
   * A prévia. Só aparece quando os três números existem e fazem sentido — um
   * parcelamento impossível (mais parcelas que centavos) mostra a recusa aqui,
   * em vez de deixar o servidor recusar depois de a pessoa clicar em salvar.
   */
  const preview = useMemo(() => {
    if (draft.modality === "recurring") return null;
    const count = draft.modality === "single" ? 1 : Number(draft.installmentCount);
    if (!draft.totalAmount || !Number.isInteger(count) || count < 1) return null;
    let cents: number;
    try { cents = toCents(draft.totalAmount); } catch { return null; }
    if (cents <= 0) return null;
    try {
      return planInstallments({ totalCents: cents, count, firstCompetence: draft.firstCompetence });
    } catch (issue) {
      return { error: issue instanceof Error ? issue.message : "Parcelamento inválido." };
    }
  }, [draft.modality, draft.installmentCount, draft.totalAmount, draft.firstCompetence]);

  const previewRows = Array.isArray(preview) ? preview : [];
  const previewError = preview && !Array.isArray(preview) ? preview.error : "";

  const missing = !draft.companyId
    || (draft.subjectKind === "employee" ? !draft.employeeId : !draft.providerId)
    || !draft.title
    || (draft.modality !== "recurring" && (!draft.totalAmount || (draft.modality === "installments" && !draft.installmentCount)));

  return (
    <div className={styles.drawerBackdrop} role="dialog" aria-modal="true" aria-label="Novo lançamento">
      <form
        className={styles.drawer}
        onSubmit={(event) => { event.preventDefault(); setTouched(true); if (!missing && !previewError) onSubmit(); }}
      >
        <div className={styles.drawerHead}>
          <div>
            <h2>Novo lançamento</h2>
            <p>Um registro por obrigação. Uma pessoa pode ter vários ao mesmo tempo, cada um com o próprio saldo.</p>
          </div>
        </div>

        {error && <p className={styles.notice} data-tone="warning"><Info aria-hidden="true" />{error}</p>}

        <div className={styles.formGrid}>
          <label>
            Empresa
            <select value={draft.companyId} onChange={(event) => onChange({ ...draft, companyId: event.target.value, employeeId: "" })}>
              <option value="">Selecione</option>
              {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </label>

          <label>
            Tipo de vínculo
            <select
              value={draft.subjectKind}
              onChange={(event) => onChange({
                ...draft,
                subjectKind: event.target.value as "employee" | "provider",
                employeeId: "", providerId: "",
              })}
            >
              <option value="employee">Colaborador</option>
              <option value="provider">Prestador PJ</option>
            </select>
          </label>

          {draft.subjectKind === "employee" ? (
            <label className={styles.fullWidth}>
              Colaborador
              <select value={draft.employeeId} onChange={(event) => set("employeeId", event.target.value)} disabled={!draft.companyId}>
                <option value="">{draft.companyId ? "Selecione" : "Escolha a empresa primeiro"}</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}{person.registrationNumber ? ` — matrícula ${person.registrationNumber}` : ""}
                    {person.employmentStatus === "terminated" ? " (desligado)" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className={styles.fullWidth}>
              Identificador do prestador
              <input
                value={draft.providerId}
                onChange={(event) => set("providerId", event.target.value)}
                placeholder="Identificador do prestador PJ"
              />
              <span className={styles.fieldHint}>
                O desconto do prestador é liquidado no fechamento PJ da competência, não na folha.
              </span>
            </label>
          )}

          <label>
            Categoria
            <select
              value={draft.category}
              onChange={(event) => onChange({ ...draft, category: event.target.value as LedgerCategory, details: {} })}
            >
              {ledgerCategories.map((category) => (
                <option key={category} value={category}>{ledgerCategoryLabels[category]}</option>
              ))}
            </select>
          </label>

          <label>
            Modalidade
            <select value={draft.modality} onChange={(event) => set("modality", event.target.value as LedgerModality)}>
              {(Object.keys(modalityLabels) as LedgerModality[]).map((modality) => (
                <option key={modality} value={modality}>{modalityLabels[modality]}</option>
              ))}
            </select>
          </label>

          <label className={styles.fullWidth}>
            Descrição curta
            <input value={draft.title} onChange={(event) => set("title", event.target.value)} maxLength={180} placeholder="Ex.: Empréstimo para conserto do veículo" />
          </label>

          {draft.modality !== "recurring" && (
            <label>
              Valor total
              <input value={draft.totalAmount} onChange={(event) => set("totalAmount", event.target.value)} inputMode="decimal" placeholder="2.000,00" />
            </label>
          )}

          {draft.modality === "installments" && (
            <label>
              Quantidade de parcelas
              <input value={draft.installmentCount} onChange={(event) => set("installmentCount", event.target.value)} inputMode="numeric" placeholder="10" />
            </label>
          )}

          <label>
            Primeira competência
            <input value={draft.firstCompetence} onChange={(event) => set("firstCompetence", event.target.value)} placeholder="2026-09" />
          </label>

          {draft.modality === "recurring" && (
            <label>
              Fim da vigência (opcional)
              <input value={draft.recurrenceEndCompetence} onChange={(event) => set("recurrenceEndCompetence", event.target.value)} placeholder="2027-06" />
            </label>
          )}

          <label>
            Data da ocorrência
            <input type="date" value={draft.occurredOn} onChange={(event) => set("occurredOn", event.target.value)} />
          </label>

          <label>
            Data da solicitação
            <input type="date" value={draft.requestedOn} onChange={(event) => set("requestedOn", event.target.value)} />
          </label>

          <label>
            Unidade
            <input value={draft.unitLabel} onChange={(event) => set("unitLabel", event.target.value)} placeholder="Ex.: unidade operacional" />
          </label>

          <label>
            Operação ou marca
            <input value={draft.operationLabel} onChange={(event) => set("operationLabel", event.target.value)} />
          </label>

          <label className={styles.fullWidth}>
            Área que solicitou
            <select value={draft.requesterAreaId} onChange={(event) => set("requesterAreaId", event.target.value)}>
              <option value="">Nenhuma</option>
              {areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
            </select>
            <span className={styles.fieldHint}>
              A área que pede não é o departamento de quem sofre o desconto: o SESMT solicita, a pessoa é da Técnica Interna.
            </span>
          </label>

          {categoryFields.length > 0 && (
            <p className={`${styles.fullWidth} ${styles.sectionTitle}`}>Campos de {ledgerCategoryLabels[draft.category].toLowerCase()}</p>
          )}
          {categoryFields.map((field) => (
            <label key={field.key}>
              {field.label}
              <input
                type={field.kind === "date" ? "date" : "text"}
                inputMode={field.kind === "amount" ? "decimal" : undefined}
                value={draft.details[field.key] ?? ""}
                onChange={(event) => onChange({ ...draft, details: { ...draft.details, [field.key]: event.target.value } })}
              />
            </label>
          ))}

          <label className={styles.fullWidth}>
            Motivo
            <textarea value={draft.reason} onChange={(event) => set("reason", event.target.value)} maxLength={1000} />
          </label>

          <label className={styles.fullWidth}>
            Observações
            <textarea value={draft.description} onChange={(event) => set("description", event.target.value)} maxLength={1000} />
          </label>
        </div>

        {draft.modality === "recurring" && (
          <p className={styles.notice}>
            <Info aria-hidden="true" />
            Desconto recorrente não tem valor total: ele tem um valor por competência e uma vigência. O saldo devedor
            não é somado para o futuro, porque ele não existe enquanto a regra continuar valendo.
          </p>
        )}

        {previewError && (
          <p className={styles.notice} data-tone="warning"><Info aria-hidden="true" />{previewError}</p>
        )}

        {previewRows.length > 0 && (
          <div className={styles.preview}>
            <strong>
              {previewRows.length} parcela(s) · total {formatBRL(fromCents(previewRows.reduce((sum, part) => sum + part.plannedCents, 0)))}
            </strong>
            <ol>
              {previewRows.slice(0, 12).map((part) => (
                <li key={part.number}>
                  {part.number}/{part.totalCount} · {formatCompetence(part.competence)} · {formatBRL(fromCents(part.plannedCents))}
                </li>
              ))}
            </ol>
            {previewRows.length > 12 && <small>e mais {previewRows.length - 12} parcela(s) até {formatCompetence(previewRows.at(-1)!.competence)}.</small>}
            <small>Nenhuma delas nasce descontada. Programar não é descontar.</small>
          </div>
        )}

        {touched && missing && (
          <p className={styles.notice} data-tone="warning">
            <Info aria-hidden="true" />
            Preencha empresa, pessoa, descrição e, fora do recorrente, valor e parcelas.
          </p>
        )}

        <div className={styles.formActions}>
          <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>Cancelar</button>
          <button type="submit" className={styles.primaryButton} disabled={busy || Boolean(previewError)}>
            {busy && <Loader2 aria-hidden="true" className={styles.spin} />}
            Criar rascunho
          </button>
        </div>
      </form>
    </div>
  );
}
