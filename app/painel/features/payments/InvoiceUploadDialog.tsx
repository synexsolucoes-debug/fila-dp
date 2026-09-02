"use client";

import { useState } from "react";
import { AlertTriangle, Paperclip, Upload } from "lucide-react";
import { fromCents, toCents } from "@/lib/payments";
import { AnimatedModal } from "../shared";
import type { InvoiceRow } from "./payments.types";
import styles from "./payments.module.css";

/**
 * O envio da nota, com os dados que a conferência vai precisar.
 *
 * O formulário pede mais do que o número e o valor porque é aqui que os dados
 * entram uma vez só: CNPJ do emissor, série e razão social são exatamente o
 * que quem confere procura na nota depois, e digitá-los na conferência
 * significaria digitá-los trinta vezes por competência.
 *
 * O valor esperado aparece ao lado do campo de valor — não como aviso depois
 * de enviar. Quem está digitando é quem pode corrigir na hora, e a divergência
 * descoberta na conferência custa uma rodada de conversa com o prestador.
 */
export function InvoiceUploadDialog({ open, row, competenceLabel, money, busy, error, duplicateWarning, onClose, onSubmit }: {
  open: boolean;
  row: InvoiceRow | null;
  competenceLabel: string;
  money: (value: number) => string;
  busy: boolean;
  error: string;
  /** Aviso de possível duplicidade devolvido pelo servidor no envio anterior. */
  duplicateWarning: string;
  onClose: () => void;
  onSubmit: (form: FormData, confirmDuplicate: boolean) => void;
}) {
  const [amount, setAmount] = useState("");
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);

  if (!row) return null;
  const replacing = row.hasInvoice;
  /* O valor digitado é interpretado pela mesma regra do servidor.
     "5.800,00" e "5800.00" são a mesma quantia e chegam das duas formas — o
     `inputMode="decimal"` do celular manda a primeira, o teclado numérico manda
     a segunda. Uma leitura própria aqui mostraria divergência onde não há, que
     é pior do que não mostrar dica nenhuma. */
  const informed = readMoney(amount);
  const difference = informed > 0 ? fromCents(toCents(informed) - toCents(row.expectedAmount)) : 0;

  return (
    <AnimatedModal open={open} onClose={onClose} label="Anexar nota fiscal" width={620} stickyFooter
      className={styles.paymentTokens}>
      <form
        className={styles.modalForm}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(new FormData(event.currentTarget), confirmDuplicate);
        }}
      >
        <header className={styles.dialogHeader}>
          <div>
            <span className={styles.eyebrow}>{replacing ? "SUBSTITUIR NOTA" : "ANEXAR NOTA FISCAL"}</span>
            <h2>{row.providerName}</h2>
            <p className={styles.dialogSummary}>
              {competenceLabel} · valor esperado de <strong>{money(row.expectedAmount)}</strong>
              {row.invoiceLimitAmount === null ? "" : ` · limite de nota de ${money(row.invoiceLimitAmount)}`}
            </p>
          </div>
        </header>

        <div className={styles.dialogBody}>
          {replacing && (
            <p className={styles.invoiceReplaceNote}>
              <AlertTriangle aria-hidden="true" />
              A NF {row.invoiceNumber || "atual"} não será apagada: ela passa a constar como substituída no
              histórico deste pagamento, e a nova entra para conferência.
            </p>
          )}
          {duplicateWarning && (
            <div className={styles.invoiceDuplicateWarning} role="alert">
              <AlertTriangle aria-hidden="true" />
              <div>
                <strong>Possível nota fiscal duplicada</strong>
                <p>{duplicateWarning}</p>
                <label>
                  <input type="checkbox" checked={confirmDuplicate}
                    onChange={(event) => setConfirmDuplicate(event.target.checked)} />
                  Confirmo que esta nota é diferente e deve ser registrada mesmo assim.
                </label>
              </div>
            </div>
          )}

          <div className={styles.fieldRow}>
            <label>Número da NF
              <input name="invoiceNumber" required maxLength={80} autoComplete="off" />
            </label>
            <label>Série
              <input name="series" maxLength={20} autoComplete="off" placeholder="Opcional" />
            </label>
            <label>Data de emissão
              <input name="issueDate" type="date" required />
            </label>
          </div>

          <div className={styles.fieldRow}>
            <label>Valor da nota
              <input name="amount" inputMode="decimal" required autoComplete="off"
                value={amount} onChange={(event) => setAmount(event.target.value)} />
            </label>
            <label>CNPJ/CPF do emissor
              <input name="issuerDocument" maxLength={20} autoComplete="off"
                defaultValue={row.providerDocument} />
            </label>
            <label>Razão social do emissor
              <input name="issuerName" maxLength={200} autoComplete="off" defaultValue={row.providerName} />
            </label>
          </div>

          {/* A comparação aparece enquanto se digita: descobrir a divergência
              depois do envio custa uma rodada de conversa com o prestador. */}
          {informed > 0 && (
            <p className={styles.invoiceComparison} data-tone={difference === 0 ? "match" : "divergent"} aria-live="polite">
              {difference === 0
                ? `Valor confere com o esperado de ${money(row.expectedAmount)}.`
                : `Divergência de ${difference > 0 ? "+" : "−"}${money(Math.abs(difference))} em relação ao esperado de ${money(row.expectedAmount)}.`}
            </p>
          )}

          <div className={styles.fieldRow}>
            <label>CNPJ do tomador
              <input name="receiverDocument" maxLength={20} autoComplete="off" defaultValue={row.companyDocument} />
            </label>
            <label>Descrição do serviço
              <input name="serviceDescription" maxLength={400} autoComplete="off" placeholder="Opcional" />
            </label>
          </div>

          <label>Arquivo da nota
            <input name="invoiceFile" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.xml" />
          </label>
          <p className={styles.hint}>
            PDF, imagem ou XML, até 20 MB. O arquivo fica guardado no grupo, vinculado a este prestador e a
            esta competência, e só é aberto por quem tem permissão de leitura de notas.
          </p>

          <label>Observação
            <textarea name="notes" maxLength={500} placeholder="Opcional — visível na conferência" />
          </label>

          {error && <p className={styles.invoiceFormError} role="alert">{error}</p>}
        </div>

        <footer className={styles.dialogFooter}>
          <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className={styles.primaryButton} disabled={busy}>
            {replacing ? <Upload aria-hidden="true" /> : <Paperclip aria-hidden="true" />}
            {busy ? "Registrando…" : replacing ? "Substituir nota" : "Registrar nota"}
          </button>
        </footer>
      </form>
    </AnimatedModal>
  );
}

/** Centavos do que foi digitado, ou 0 enquanto o valor ainda não é um número. */
function readMoney(value: string) {
  if (!value.trim()) return 0;
  try {
    return fromCents(toCents(value));
  } catch {
    return 0;
  }
}
