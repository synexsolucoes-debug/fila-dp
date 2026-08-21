"use client";

import { useMemo, useState } from "react";
import { CalendarClock, Plus, Users } from "lucide-react";
import { AnimatedModal } from "../shared";
import type { Contractor } from "./payments.types";
import styles from "./payments.module.css";

/**
 * O lançamento de crédito e desconto do PJ, nas duas formas em que a operação
 * de fato lança.
 *
 * Antes havia dois formulários com objetivos diferentes: um para o lançamento
 * da competência e outro para o valor recorrente, cada um com a sua janela e o
 * seu vocabulário. Mas quem lança não pensa em "componente" e "item fixo" —
 * pensa em "quanto e para quem", e depois em "isso repete?".
 *
 * Então a janela é uma só, com duas escolhas explícitas:
 *
 *  - **Forma.** Por prestador, quando é uma pessoa e um valor. Por rubrica,
 *    quando é a mesma rubrica para várias pessoas com valores diferentes —
 *    numa competência com trinta PJ e um reajuste de plano de saúde, a
 *    diferença é entre trinta formulários e um.
 *
 *  - **Natureza.** Mensal vale só nesta competência. Fixo repete até alguém
 *    encerrar. Determinado repete até a competência final informada. As três
 *    já existiam no banco; o que não existia era poder escolher entre elas na
 *    hora de lançar, que é quando a pessoa sabe qual é.
 */

type Nature = "mensal" | "fixo" | "determinado";
type Mode = "prestador" | "rubrica";

const creditLabels: Array<[string, string]> = [
  ["commission", "Comissão"], ["bonus", "Bônus"], ["award", "Prêmio"],
  ["reimbursement", "Reembolso"], ["additional", "Adicional"],
  ["positive_adjustment", "Ajuste positivo"], ["other_credit", "Outro provento"],
];

const debitLabels: Array<[string, string]> = [
  ["health_plan", "Plano de saúde"], ["dental_plan", "Plano odontológico"],
  ["benefit", "Convênio ou benefício"], ["coparticipation", "Coparticipação"],
  ["equipment", "Equipamento"], ["advance", "Adiantamento"], ["absence", "Falta"],
  ["loan", "Empréstimo"], ["negative_adjustment", "Ajuste negativo"], ["other_debit", "Outro desconto"],
];

const natureHelp: Record<Nature, string> = {
  mensal: "Vale só nesta competência. É o lançamento avulso do mês.",
  fixo: "Repete em toda competência, a partir desta, até alguém encerrar.",
  determinado: "Repete a partir desta competência até a competência final informada.",
};

export type EntrySubmission = {
  nature: Nature;
  componentType: string;
  description: string;
  effectiveTo: string;
  entries: Array<{ providerId: string; amount: number }>;
};

export function ContractorEntryDialog({
  open, contractors, competence, competenceLabel, initialNature, busy, error, onClose, onSubmit,
}: {
  open: boolean;
  contractors: readonly Contractor[];
  competence: string;
  competenceLabel: string;
  /** A natureza que o botão de origem sugere — quem abre por "Novo recorrente"
   *  já quer um fixo, e ter de escolher de novo seria repetir a escolha. */
  initialNature: Nature;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (submission: EntrySubmission) => void;
}) {
  const [mode, setMode] = useState<Mode>("prestador");
  const [nature, setNature] = useState<Nature>(initialNature);
  const [componentType, setComponentType] = useState("health_plan");
  const [description, setDescription] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [providerId, setProviderId] = useState("");
  const [singleAmount, setSingleAmount] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  /* O formulário reinicia a cada abertura.
     A janela fica montada mesmo fechada — quem devolve `null` é o modal por
     dentro —, então sem isto a natureza sugerida pelo botão não chegaria (o
     `useState` só lê o valor inicial uma vez) e os valores da vez anterior
     reapareceriam. Um formulário que abre com trinta valores digitados ontem é
     um convite a lançar duas vezes.
     O ajuste é feito no render, e não num efeito: é o caminho que o React
     recomenda para estado derivado de prop, e evita o quadro em que a janela
     aparece com o conteúdo velho antes de se corrigir. */
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setMode("prestador");
      setNature(initialNature);
      setComponentType("health_plan");
      setDescription("");
      setEffectiveTo("");
      setProviderId("");
      setSingleAmount("");
      setAmounts({});
    }
  }

  const ativos = useMemo(() => contractors.filter((item) => item.status === "active"), [contractors]);

  const preenchidos = useMemo(
    () => Object.entries(amounts).filter(([, value]) => Number(value.replace(",", ".")) > 0).length,
    [amounts],
  );

  const podeEnviar = mode === "prestador"
    ? Boolean(providerId) && Number(singleAmount.replace(",", ".")) > 0
    : preenchidos > 0;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!podeEnviar || busy) return;
    const entries = mode === "prestador"
      ? [{ providerId, amount: Number(singleAmount.replace(",", ".")) }]
      : Object.entries(amounts)
        .map(([id, value]) => ({ providerId: id, amount: Number(value.replace(",", ".")) }))
        .filter((entry) => entry.amount > 0);
    onSubmit({ nature, componentType, description, effectiveTo, entries });
  }

  return (
    <AnimatedModal open={open} onClose={onClose} label="Novo lançamento de pagamento PJ" width={640} stickyFooter className={styles.paymentTokens}>
      <form className={styles.modalForm} onSubmit={submit}>
        <header className={styles.dialogHeader}>
          <div>
            <span className={styles.eyebrow}>PAGAMENTO PJ</span>
            <h2>Novo lançamento</h2>
            <p className={styles.dialogSummary}>Crédito ou desconto para a competência de {competenceLabel}.</p>
          </div>
        </header>
        <div className={styles.dialogBody}>

        {/* A forma primeiro: ela muda o resto da janela, e escolher depois de
            preencher faria o trabalho ser jogado fora. */}
        <fieldset className={styles.choiceGroup}>
          <legend>Forma do lançamento</legend>
          <label data-selected={mode === "prestador"}>
            <input type="radio" name="mode" checked={mode === "prestador"} onChange={() => setMode("prestador")} />
            <span><Plus aria-hidden="true" /> Por prestador</span>
            <small>Uma pessoa, um valor.</small>
          </label>
          <label data-selected={mode === "rubrica"}>
            <input type="radio" name="mode" checked={mode === "rubrica"} onChange={() => setMode("rubrica")} />
            <span><Users aria-hidden="true" /> Por rubrica</span>
            <small>A mesma rubrica para vários prestadores, com valores diferentes.</small>
          </label>
        </fieldset>

        <fieldset className={styles.choiceGroup}>
          <legend>Natureza</legend>
          {(["mensal", "fixo", "determinado"] as const).map((item) => (
            <label key={item} data-selected={nature === item}>
              <input type="radio" name="nature" checked={nature === item} onChange={() => setNature(item)} />
              <span>
                {item === "determinado" ? <CalendarClock aria-hidden="true" /> : null}
                {item === "mensal" ? "Mensal" : item === "fixo" ? "Fixo" : "Determinado"}
              </span>
              <small>{natureHelp[item]}</small>
            </label>
          ))}
        </fieldset>

        <label>Rubrica
          <select value={componentType} onChange={(event) => setComponentType(event.target.value)} required>
            <optgroup label="Proventos">
              {creditLabels.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </optgroup>
            <optgroup label="Descontos">
              {debitLabels.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </optgroup>
          </select>
        </label>

        <label>Descrição
          <input value={description} onChange={(event) => setDescription(event.target.value)}
            maxLength={180} required placeholder="Ex.: Plano de saúde — reajuste de agosto" />
        </label>

        {nature === "determinado" && (
          <label>Competência final
            <input type="month" value={effectiveTo} onChange={(event) => setEffectiveTo(event.target.value)}
              min={competence} required />
          </label>
        )}

        {mode === "prestador" ? (
          <div className={styles.fieldRow}>
            <label>Prestador
              <select value={providerId} onChange={(event) => setProviderId(event.target.value)} required>
                <option value="" disabled>Selecione</option>
                {ativos.map((item) => <option key={item.id} value={item.id}>{item.legalName}</option>)}
              </select>
            </label>
            <label>Valor (R$)
              <input type="number" min="0.01" step="0.01" required
                value={singleAmount} onChange={(event) => setSingleAmount(event.target.value)} />
            </label>
          </div>
        ) : (
          <div className={styles.batchList}>
            <p className={styles.dialogSummary}>
              Preencha só quem recebe esta rubrica. Linha em branco não vira lançamento.
              {preenchidos > 0 ? ` ${preenchidos} prestador(es) com valor.` : ""}
            </p>
            {ativos.length === 0
              ? <p className={styles.noteLine}>Nenhum prestador ativo nesta empresa.</p>
              : ativos.map((item) => (
                <label key={item.id} className={styles.batchRow}>
                  <span>{item.legalName}<small>{item.code}</small></span>
                  <input type="number" min="0" step="0.01" placeholder="0,00"
                    value={amounts[item.id] ?? ""}
                    onChange={(event) => setAmounts((current) => ({ ...current, [item.id]: event.target.value }))} />
                </label>
              ))}
          </div>
        )}

        {error && <p className={styles.warningState} role="alert">{error}</p>}
        </div>

        <footer className={styles.dialogFooter}>
          <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className={styles.primaryButton} disabled={!podeEnviar || busy}>
            {busy ? "Lançando…" : mode === "rubrica" && preenchidos > 0 ? `Lançar para ${preenchidos} prestador(es)` : "Lançar"}
          </button>
        </footer>
      </form>
    </AnimatedModal>
  );
}
