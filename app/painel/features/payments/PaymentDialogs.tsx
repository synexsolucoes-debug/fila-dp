"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { ArrowRight, ShieldCheck, X } from "lucide-react";
import type { PaymentDialog } from "./payments.types";
import styles from "./payments.module.css";

type Props = {
  dialog: NonNullable<PaymentDialog>;
  busy: boolean;
  onClose: () => void;
  onSubmit: (dialog: NonNullable<PaymentDialog>, data: FormData) => Promise<void>;
};

const titles: Record<NonNullable<PaymentDialog>["kind"], string> = {
  psychologist: "Cadastro do psicólogo",
  session: "Lançar consulta para pagamento",
  adjustment: "Ajuste do fechamento",
  "psychology-payment": "Pagamento ao psicólogo",
  contractor: "Cadastro do prestador PJ",
  component: "Crédito ou desconto da competência",
  "fixed-item": "Lançamento fixo do prestador",
  invoice: "Nota fiscal recebida",
  complement: "Valor complementar (cartão de benefício)",
  limit: "Política de limite da nota",
  reopen: "Reabrir fechamento",
};

const money = (value: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);

export function PaymentDialog({ dialog, busy, onClose, onSubmit }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [fixedTerm, setFixedTerm] = useState<"indefinite" | "determined">("indefinite");
  const busyRef = useRef(busy);
  const closeRef = useRef(onClose);
  useEffect(() => { busyRef.current = busy; closeRef.current = onClose; }, [busy, onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const selector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
    const focusables = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(selector) ?? []).filter((item) => item.getClientRects().length > 0);
    const timer = window.setTimeout(() => (panelRef.current?.querySelector<HTMLElement>("input:not([type='hidden']), select, textarea") ?? focusables()[0])?.focus(), 30);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) { event.preventDefault(); panelRef.current?.focus(); return; }
      const first = items[0];
      const last = items.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !panelRef.current?.contains(active))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", keydown);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit(dialog, new FormData(event.currentTarget));
  }

  return (
    <div className={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className={styles.dialog} ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="payment-dialog-title" tabIndex={-1}>
        <header className={styles.dialogHeader}>
          <div>
            <span className={styles.eyebrow}>CONTROLE DE PAGAMENTO</span>
            <h2 id="payment-dialog-title">{titles[dialog.kind]}</h2>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Fechar janela"><X aria-hidden="true" /></button>
        </header>
        <form onSubmit={submit}>
          <div className={styles.dialogBody}>
            {(dialog.kind === "psychologist" || dialog.kind === "session" || dialog.kind === "adjustment" || dialog.kind === "psychology-payment") && (
              <p className={styles.privacyNotice}>
                <ShieldCheck aria-hidden="true" />
                <span>Controle financeiro do pagamento das consultas. Não registre diagnóstico, motivo, evolução ou qualquer conteúdo clínico.</span>
              </p>
            )}

            {dialog.kind === "psychologist" && (
              <>
                <label>Nome do psicólogo<input name="legalName" required maxLength={180} /></label>
                <label>CPF/CNPJ<input name="taxId" maxLength={20} inputMode="numeric" /></label>
                <div className={styles.fieldRow}>
                  <label>E-mail<input name="email" type="email" maxLength={180} /></label>
                  <label>Telefone<input name="phone" maxLength={40} /></label>
                </div>
                <label>Valor padrão por consulta (R$)<input name="defaultSessionAmount" type="number" min="0" step="0.01" required /></label>
                <label>Chave Pix<input name="pixKey" maxLength={140} autoComplete="off" /></label>
                <div className={styles.fieldRow}>
                  <label>Banco<input name="bankCode" maxLength={20} /></label>
                  <label>Agência<input name="bankBranch" maxLength={20} /></label>
                  <label>Conta<input name="bankAccount" maxLength={30} /></label>
                </div>
                <label>Observações administrativas<textarea name="administrativeNotes" rows={2} maxLength={500} /></label>
                <p className={styles.hint}>Pix e conta são gravados criptografados e nunca voltam em claro para a interface.</p>
              </>
            )}

            {dialog.kind === "session" && (
              <>
                <label>Psicólogo
                  <select name="psychologistId" required defaultValue="">
                    <option value="" disabled>Selecione</option>
                    {dialog.psychologists.filter((item) => item.status === "active").map((item) => (
                      <option key={item.id} value={item.id}>{item.legalName} — padrão {money(item.defaultSessionAmount)}</option>
                    ))}
                  </select>
                </label>
                <label>Colaborador
                  <select name="employeeId" required defaultValue="">
                    <option value="" disabled>Selecione</option>
                    {dialog.employees.map((item) => (
                      <option key={item.id} value={item.id}>{item.registrationNumber ? `${item.registrationNumber} — ` : ""}{item.name}</option>
                    ))}
                  </select>
                </label>
                <div className={styles.fieldRow}>
                  <label>Data da consulta<input name="sessionDate" type="date" required /></label>
                  <label>Quantidade<input name="quantity" type="number" min="1" step="1" defaultValue={1} required /></label>
                  <label>Valor unitário (R$)<input name="unitAmount" type="number" min="0" step="0.01" placeholder="Padrão do psicólogo" /></label>
                </div>
                <label>Observação administrativa<input name="administrativeNote" maxLength={300} /></label>
                <p className={styles.hint}>O valor unitário fica congelado no lançamento: alterações futuras na tabela do psicólogo não mudam consultas já registradas.</p>
              </>
            )}

            {dialog.kind === "adjustment" && (
              <>
                <p className={styles.dialogSummary}>{dialog.closing.psychologistName} · líquido atual {money(dialog.closing.netAmount)}</p>
                <label>Tipo de ajuste
                  <select name="kind" defaultValue="correction">
                    <option value="inclusion">Inclusão</option>
                    <option value="cancellation">Cancelamento administrativo</option>
                    <option value="correction">Correção</option>
                    <option value="discount">Desconto</option>
                    <option value="complement">Complemento</option>
                  </select>
                </label>
                <label>Valor (R$)<input name="amount" type="number" min="0" step="0.01" required /></label>
                <label>Motivo<textarea name="reason" rows={3} required minLength={5} maxLength={500} /></label>
                <p className={styles.hint}>Cancelamento e desconto reduzem o valor a pagar; os demais aumentam. O ajuste é permanente e auditado.</p>
              </>
            )}

            {dialog.kind === "psychology-payment" && (
              <>
                <p className={styles.dialogSummary}>{dialog.closing.psychologistName} · apurado {money(dialog.closing.netAmount)}</p>
                <div className={styles.fieldRow}>
                  <label>Valor do pagamento (R$)<input name="amount" type="number" min="0" step="0.01" defaultValue={dialog.closing.netAmount} required /></label>
                  <label>Forma
                    <select name="method" defaultValue="pix">
                      <option value="pix">Pix</option>
                      <option value="bank_transfer">Transferência</option>
                      <option value="invoice_payment">Pagamento de nota</option>
                      <option value="other">Outra</option>
                    </select>
                  </label>
                </div>
                <div className={styles.fieldRow}>
                  <label>Data prevista<input name="scheduledDate" type="date" /></label>
                  <label>Data realizada<input name="paidDate" type="date" /></label>
                  <label>Status
                    <select name="status" defaultValue="scheduled">
                      <option value="pending">Pendente</option>
                      <option value="scheduled">Programado</option>
                      <option value="paid">Pago</option>
                      <option value="canceled">Cancelado</option>
                    </select>
                  </label>
                </div>
                <div className={styles.fieldRow}>
                  <label>Número da nota<input name="invoiceNumber" maxLength={80} /></label>
                  <label>Valor da nota (R$)<input name="invoiceAmount" type="number" min="0" step="0.01" /></label>
                  <label>Emissão<input name="invoiceIssueDate" type="date" /></label>
                </div>
                <label>Comprovante (referência)<input name="receiptReference" maxLength={200} /></label>
              </>
            )}

            {dialog.kind === "contractor" && (
              <>
                <label>Razão social<input name="legalName" required maxLength={180} /></label>
                <div className={styles.fieldRow}>
                  <label>CNPJ<input name="taxId" maxLength={20} inputMode="numeric" /></label>
                  <label>Referência do contrato<input name="contractReference" maxLength={80} /></label>
                </div>
                <div className={styles.fieldRow}>
                  <label>Função<input name="roleTitle" maxLength={120} /></label>
                  <label>Início<input name="contractStart" type="date" /></label>
                  <label>Encerramento<input name="contractEnd" type="date" /></label>
                </div>
                <div className={styles.fieldRow}>
                  <label>Valor base/contratual (R$)<input name="baseAmount" type="number" min="0" step="0.01" required /></label>
                  <label>Limite da nota deste prestador (R$)<input name="invoiceLimitOverride" type="number" min="0" step="0.01" placeholder="Herda a política" /></label>
                </div>
                <div className={styles.fieldRow}>
                  <label>Meio complementar
                    <select name="complementMethod" defaultValue="none">
                      <option value="none">Não utiliza</option>
                      <option value="caju_saldo_livre">Caju Saldo Livre</option>
                      <option value="other_benefit_card">Outro cartão de benefício</option>
                      <option value="manual_transfer">Transferência manual</option>
                    </select>
                  </label>
                  <label>Identificador na plataforma<input name="complementExternalId" maxLength={160} /></label>
                </div>
                <label>Chave Pix<input name="pixKey" maxLength={140} autoComplete="off" /></label>
                <p className={styles.hint}>O limite em branco herda a política vigente: prestador → contrato → empresa → workspace.</p>
              </>
            )}

            {dialog.kind === "component" && (
              <>
                <label>Prestador
                  <select name="contractorId" required defaultValue="">
                    <option value="" disabled>Selecione</option>
                    {dialog.contractors.filter((item) => item.status === "active").map((item) => (
                      <option key={item.id} value={item.id}>{item.legalName}</option>
                    ))}
                  </select>
                </label>
                <label>Componente
                  <select name="componentType" required defaultValue="commission">
                    <optgroup label="Créditos">
                      <option value="commission">Comissão</option>
                      <option value="bonus">Bônus</option>
                      <option value="award">Prêmio</option>
                      <option value="reimbursement">Reembolso</option>
                      <option value="additional">Adicional</option>
                      <option value="positive_adjustment">Ajuste positivo</option>
                      <option value="other_credit">Outro crédito</option>
                    </optgroup>
                    <optgroup label="Descontos">
                      <option value="health_plan">Plano de saúde</option>
                      <option value="dental_plan">Plano odontológico</option>
                      <option value="benefit">Benefício</option>
                      <option value="coparticipation">Coparticipação</option>
                      <option value="equipment">Equipamento</option>
                      <option value="advance">Adiantamento</option>
                      <option value="absence">Falta</option>
                      <option value="loan">Empréstimo</option>
                      <option value="negative_adjustment">Ajuste negativo</option>
                      <option value="other_debit">Outro desconto</option>
                    </optgroup>
                  </select>
                </label>
                <div className={styles.fieldRow}>
                  <label>Valor (R$)<input name="amount" type="number" min="0.01" step="0.01" required /></label>
                  <label>Documento<input name="documentReference" maxLength={160} /></label>
                </div>
                <label>Descrição<input name="description" maxLength={240} /></label>
                <p className={styles.hint}>Créditos e descontos entram no líquido devido antes de aplicar o limite da nota.</p>
              </>
            )}

            {dialog.kind === "fixed-item" && (
              <>
                <p className={styles.dialogSummary}>
                  Cadastre uma vez e o lançamento entrará automaticamente em cada competência dentro da vigência.
                </p>
                <label>Prestador
                  <select name="providerId" required defaultValue="">
                    <option value="" disabled>Selecione</option>
                    {dialog.contractors.filter((item) => item.status === "active").map((item) => (
                      <option key={item.id} value={item.id}>{item.legalName}</option>
                    ))}
                  </select>
                </label>
                <label>Rubrica
                  <select name="componentType" required defaultValue="health_plan">
                    <optgroup label="Proventos">
                      <option value="commission">Comissão</option>
                      <option value="bonus">Bônus</option>
                      <option value="award">Prêmio</option>
                      <option value="reimbursement">Reembolso</option>
                      <option value="additional">Adicional</option>
                      <option value="positive_adjustment">Ajuste positivo</option>
                      <option value="other_credit">Outro provento</option>
                    </optgroup>
                    <optgroup label="Descontos">
                      <option value="health_plan">Plano de saúde</option>
                      <option value="dental_plan">Plano odontológico</option>
                      <option value="benefit">Convênio ou benefício</option>
                      <option value="coparticipation">Coparticipação</option>
                      <option value="equipment">Equipamento</option>
                      <option value="advance">Adiantamento</option>
                      <option value="absence">Falta</option>
                      <option value="loan">Empréstimo</option>
                      <option value="negative_adjustment">Ajuste negativo</option>
                      <option value="other_debit">Outro desconto</option>
                    </optgroup>
                  </select>
                </label>
                <label>Descrição<input name="description" required maxLength={180} placeholder="Ex.: Plano de saúde mensal" /></label>
                <div className={styles.fieldRow}>
                  <label>Valor mensal (R$)<input name="amount" type="number" min="0.01" step="0.01" required /></label>
                  <label>Primeira competência<input name="effectiveFrom" type="month" required defaultValue={dialog.competence} /></label>
                </div>
                <label>Vigência
                  <select value={fixedTerm} onChange={(event) => setFixedTerm(event.target.value as "indefinite" | "determined")}>
                    <option value="indefinite">Sem término</option>
                    <option value="determined">Com término determinado</option>
                  </select>
                </label>
                {fixedTerm === "determined" ? (
                  <label>Última competência
                    <input name="effectiveTo" type="month" min={dialog.competence} required />
                    <span className={styles.hint}>O lançamento ainda será aplicado nessa competência e sairá automaticamente no mês seguinte.</span>
                  </label>
                ) : null}
                <label>Observação<textarea name="note" rows={2} maxLength={300} /></label>
                <p className={styles.hint}>Plano de saúde, convênios e demais descontos reduzem o líquido antes do cálculo da nota e da Caju.</p>
              </>
            )}

            {dialog.kind === "invoice" && (
              <>
                <p className={styles.dialogSummary}>
                  {dialog.closing.contractorName} · nota esperada <strong>{money(dialog.closing.invoiceExpectedAmount)}</strong>
                </p>
                <div className={styles.fieldRow}>
                  <label>Número da nota<input name="invoiceNumber" required maxLength={80} /></label>
                  <label>Valor recebido (R$)<input name="receivedAmount" type="number" min="0" step="0.01" defaultValue={dialog.closing.invoiceExpectedAmount} required /></label>
                  <label>Emissão<input name="issueDate" type="date" /></label>
                </div>
                <label>Arquivo/referência<input name="attachmentReference" maxLength={200} /></label>
                <p className={styles.hint}>Valor diferente do esperado gera divergência e bloqueia o pagamento até a conferência.</p>
              </>
            )}

            {dialog.kind === "complement" && (
              <>
                <p className={styles.dialogSummary}>
                  {dialog.closing.contractorName} · complemento apurado <strong>{money(dialog.closing.complementAmount)}</strong>
                </p>
                <label>Status do envio
                  <select name="status" defaultValue="pending">
                    <option value="pending">Pendente</option>
                    <option value="approved">Aprovado</option>
                    <option value="sent">Enviado</option>
                    <option value="processed">Processado</option>
                    <option value="error">Erro</option>
                    <option value="canceled">Cancelado</option>
                  </select>
                </label>
                <div className={styles.fieldRow}>
                  <label>Lote<input name="batchReference" maxLength={120} /></label>
                  <label>Identificador externo<input name="externalId" maxLength={160} /></label>
                  <label>Valor pago (R$)<input name="paidAmount" type="number" min="0" step="0.01" defaultValue={dialog.closing.complementAmount} /></label>
                </div>
                <label>Erro retornado<input name="error" maxLength={300} /></label>
                <p className={styles.hint}>Controle assistido: não há integração oficial implementada com a plataforma de benefício.</p>
              </>
            )}

            {dialog.kind === "limit" && (
              <>
                <label>Escopo
                  <select name="scope" defaultValue="workspace">
                    <option value="workspace">Workspace</option>
                    <option value="company">Empresa</option>
                    <option value="contract">Contrato</option>
                    <option value="provider">Prestador</option>
                  </select>
                </label>
                <label>Prestador (escopo prestador)
                  <select name="providerId" defaultValue="">
                    <option value="">—</option>
                    {dialog.contractors.map((item) => <option key={item.id} value={item.id}>{item.legalName}</option>)}
                  </select>
                </label>
                <label>Referência do contrato (escopo contrato)<input name="contractReference" maxLength={80} /></label>
                <div className={styles.fieldRow}>
                  <label>Limite (R$)<input name="amount" type="number" min="0" step="0.01" required /></label>
                  <label>Vigente a partir de<input name="effectiveFrom" type="date" required /></label>
                </div>
                <label>Observação<input name="note" maxLength={300} /></label>
                <p className={styles.hint}>A política anterior do mesmo alvo é encerrada, não apagada: competências já apuradas mantêm o limite usado.</p>
              </>
            )}

            {dialog.kind === "reopen" && (
              <>
                <p className={styles.dialogSummary}>A reabertura é registrada em auditoria e libera novas alterações na competência.</p>
                <label>Justificativa<textarea name="reason" rows={3} required minLength={5} maxLength={500} /></label>
              </>
            )}
          </div>
          <footer className={styles.dialogFooter}>
            <button className={styles.secondaryButton} type="button" onClick={onClose} disabled={busy}>Cancelar</button>
            <button className={styles.primaryButton} type="submit" disabled={busy}>
              {busy ? "Processando…" : "Confirmar"} {!busy && <ArrowRight aria-hidden="true" />}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
