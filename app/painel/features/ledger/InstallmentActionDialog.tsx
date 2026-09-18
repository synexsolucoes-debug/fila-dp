"use client";

import { useState } from "react";
import { Info, Loader2 } from "lucide-react";
import { formatBRL, formatCompetence } from "@/lib/payroll-ledger";
import styles from "./ledger.module.css";
import type { InstallmentAction } from "./InstallmentsPanel";

type Payload = {
  amount: string;
  competence: string;
  justification: string;
  reference: string;
};

/**
 * O diálogo das cinco ações sobre uma parcela.
 *
 * Um só componente, porque as cinco fazem a mesma pergunta em ordens
 * diferentes — e cinco diálogos quase iguais divergiriam no primeiro ajuste. O
 * que muda entre elas está escrito em `copy`: o título, o que precisa ser
 * digitado e a frase que explica a consequência.
 *
 * As três frases de consequência são o ponto desta tela. Quem confirma um
 * desconto precisa ler, antes de clicar, que está afirmando que o dinheiro
 * saiu do salário de alguém — e não que "vai sair".
 */
const copy: Record<InstallmentAction["kind"], {
  title: string;
  consequence: string;
  needsAmount: boolean;
  needsJustification: boolean;
  needsCompetence: boolean;
  submit: string;
}> = {
  confirm: {
    title: "Confirmar desconto",
    consequence: "Confirmar registra que este valor **já foi descontado** da pessoa na folha. Se ainda não foi processado, não confirme: a parcela continua em aberto e ninguém a perde de vista.",
    needsAmount: true, needsJustification: false, needsCompetence: true, submit: "Confirmar desconto",
  },
  override: {
    title: "Ajuste autorizado acima do saldo",
    consequence: "Este é o único caminho para descontar mais do que a parcela prevê. Só use com autorização registrada — o que você escrever aqui fica no histórico como a razão da cobrança a mais.",
    needsAmount: true, needsJustification: true, needsCompetence: true, submit: "Registrar ajuste",
  },
  reverse: {
    title: "Estornar confirmação",
    consequence: "O estorno devolve o saldo e **não apaga nada**: a confirmação original continua no histórico, com a sua ao lado. É assim que uma correção fica auditável.",
    needsAmount: true, needsJustification: true, needsCompetence: true, submit: "Estornar",
  },
  reschedule: {
    title: "Reprogramar parcela",
    consequence: "A parcela muda de competência. O valor não muda e nada é descontado por isso.",
    needsAmount: false, needsJustification: true, needsCompetence: true, submit: "Reprogramar",
  },
  skip: {
    title: "Pular a parcela desta competência",
    consequence: "Pular tira a parcela da programação deste mês. O valor **não** é somado à parcela seguinte: se ele precisar ser cobrado, alguém decide isso explicitamente, renegociando o saldo.",
    needsAmount: false, needsJustification: true, needsCompetence: false, submit: "Pular parcela",
  },
};

/** Negrito em `**texto**`, para a consequência poder destacar a palavra que importa. */
function Consequence({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => (
        part.startsWith("**") && part.endsWith("**")
          ? <strong key={index}>{part.slice(2, -2)}</strong>
          : <span key={index}>{part}</span>
      ))}
    </>
  );
}

export function InstallmentActionDialog({
  action, busy, error, onCancel, onSubmit,
}: {
  action: InstallmentAction;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onSubmit: (payload: Payload) => void;
}) {
  const { installment } = action;
  const spec = copy[action.kind];
  const sugestao = action.kind === "reverse" ? installment.discountedAmount : installment.remainingAmount;

  const [payload, setPayload] = useState<Payload>({
    amount: spec.needsAmount ? String(sugestao.toFixed(2)).replace(".", ",") : "",
    competence: installment.competence,
    justification: "",
    reference: "",
  });

  const set = <K extends keyof Payload>(key: K, value: Payload[K]) => setPayload({ ...payload, [key]: value });
  const faltando = (spec.needsAmount && !payload.amount.trim())
    || (spec.needsJustification && payload.justification.trim().length < 5)
    || (spec.needsCompetence && !payload.competence.trim());

  return (
    <div className={styles.drawerBackdrop} role="dialog" aria-modal="true" aria-label={spec.title}>
      <form
        className={styles.drawer}
        onSubmit={(event) => { event.preventDefault(); if (!faltando) onSubmit(payload); }}
      >
        <div className={styles.drawerHead}>
          <div>
            <h2>{spec.title}</h2>
            <p>
              {installment.employeeName || installment.providerName} · {installment.entryTitle}
              {" · "}parcela {installment.number}{installment.totalCount ? `/${installment.totalCount}` : ""}
              {" de "}{formatCompetence(installment.competence)}
            </p>
          </div>
        </div>

        <dl className={styles.definitionList}>
          <div><dt>Previsto</dt><dd>{formatBRL(installment.plannedAmount)}</dd></div>
          <div><dt>Já descontado</dt><dd>{formatBRL(installment.discountedAmount)}</dd></div>
          <div><dt>Saldo</dt><dd>{formatBRL(installment.remainingAmount)}</dd></div>
        </dl>

        <p className={styles.notice} data-tone={action.kind === "override" ? "warning" : undefined}>
          <Info aria-hidden="true" />
          <span><Consequence text={spec.consequence} /></span>
        </p>

        {error && <p className={styles.notice} data-tone="warning"><Info aria-hidden="true" />{error}</p>}

        <div className={styles.formGrid}>
          {spec.needsAmount && (
            <label>
              Valor
              <input
                value={payload.amount}
                onChange={(event) => set("amount", event.target.value)}
                inputMode="decimal"
                autoFocus
              />
              <span className={styles.fieldHint}>
                {action.kind === "confirm"
                  ? "Menos que o previsto é desconto parcial, e o saldo continua visível."
                  : action.kind === "reverse"
                    ? `No máximo ${formatBRL(installment.discountedAmount)}, que é o confirmado nesta parcela.`
                    : "Acima do saldo previsto. Exige a autorização descrita abaixo."}
              </span>
            </label>
          )}

          {spec.needsCompetence && (
            <label>
              {action.kind === "reschedule" ? "Nova competência" : "Competência"}
              <input value={payload.competence} onChange={(event) => set("competence", event.target.value)} placeholder="2026-10" />
            </label>
          )}

          {action.kind === "confirm" && (
            <label className={styles.fullWidth}>
              Referência (opcional)
              <input
                value={payload.reference}
                onChange={(event) => set("reference", event.target.value)}
                placeholder="Nº do lote, arquivo de retorno ou recibo"
              />
            </label>
          )}

          {spec.needsJustification && (
            <label className={styles.fullWidth}>
              Justificativa
              <textarea
                value={payload.justification}
                onChange={(event) => set("justification", event.target.value)}
                maxLength={1000}
                placeholder="Obrigatória, no mínimo 5 caracteres."
              />
            </label>
          )}
        </div>

        <div className={styles.formActions}>
          <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>Cancelar</button>
          <button type="submit" className={styles.primaryButton} disabled={busy || faltando}>
            {busy && <Loader2 aria-hidden="true" className={styles.spin} />}
            {spec.submit}
          </button>
        </div>
      </form>
    </div>
  );
}
