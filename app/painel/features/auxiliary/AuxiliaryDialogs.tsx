"use client";

import { FormEvent, useEffect, useRef } from "react";
import { AlertTriangle, ArrowRight, BadgeCheck, Building2, FilePenLine, LockKeyhole, Send, X } from "lucide-react";
import type { Approver, AuxiliaryEditor, AuxiliaryModule, Provider } from "./auxiliary.types";
import styles from "./auxiliary.module.css";

type Props = {
  editor: NonNullable<AuxiliaryEditor>; module: AuxiliaryModule; providers: Provider[]; approvers: Approver[];
  busy: boolean; onClose: () => void; onSubmit: (editor: NonNullable<AuxiliaryEditor>, data: FormData) => Promise<void>;
};

const titles: Record<NonNullable<AuxiliaryEditor>["kind"], string> = {
  execution: "Entrega da competência", revision: "Nova revisão", submit: "Enviar para aprovação",
  decision: "Decidir aprovação", close: "Fechar entrega", provider: "Cadastro de fornecedor",
};
const moduleLabels: Record<AuxiliaryModule, string> = { benefits: "Benefícios", psychology: "Psicologia", contractors: "Prestadores PJ" };
const get = (record: Record<string, unknown>, key: string) => String(record[key] ?? "");

export function AuxiliaryDialog({ editor, module, providers, approvers, busy, onClose, onSubmit }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
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
      const first = items[0]; const last = items.at(-1)!; const active = document.activeElement;
      if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (active === last || !panelRef.current?.contains(active))) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", keydown);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit(editor, new FormData(event.currentTarget));
  }

  const isWide = editor.kind === "execution" || editor.kind === "revision" || editor.kind === "provider";
  return (
    <div className={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className={`${styles.dialog} ${isWide ? styles.dialogWide : styles.dialogCompact}`} ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="auxiliary-dialog-title" tabIndex={-1}>
        <header className={styles.dialogHeader}>
          <div><span className={styles.eyebrow}>LEDGER · {moduleLabels[module].toUpperCase()}</span><h2 id="auxiliary-dialog-title">{dialogTitle(editor)}</h2></div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Fechar janela"><X aria-hidden="true" /></button>
        </header>
        <form onSubmit={submit}>
          <div className={styles.dialogBody}>
            {module === "psychology" && <PrivacyNotice />}
            {editor.kind === "execution" && <ExecutionFields module={module} providers={providers} execution={editor.execution} />}
            {editor.kind === "revision" && <RevisionFields module={module} execution={editor.execution} />}
            {editor.kind === "submit" && <SubmitFields title={editor.execution.title} approvers={approvers} />}
            {editor.kind === "decision" && <DecisionFields title={editor.execution.title} approver={editor.approval.approverName} />}
            {editor.kind === "close" && <CloseFields title={editor.execution.title} reference={editor.execution.referenceCode} />}
            {editor.kind === "provider" && <ProviderFields module={module} provider={editor.provider} />}
          </div>
          <footer className={styles.dialogFooter}>
            <button className={styles.secondaryButton} type="button" onClick={onClose} disabled={busy}>Cancelar</button>
            <button className={styles.primaryButton} type="submit" disabled={busy}>
              {busy ? "Processando…" : submitLabel(editor)} {!busy && <ArrowRight aria-hidden="true" />}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
function dialogTitle(editor: NonNullable<AuxiliaryEditor>) {
  if (editor.kind === "execution") return editor.execution ? "Editar entrega em rascunho" : "Nova entrega";
  if (editor.kind === "provider") return editor.provider ? "Editar fornecedor" : titles.provider;
  return titles[editor.kind];
}

function submitLabel(editor: NonNullable<AuxiliaryEditor>) {
  if (editor.kind === "execution") return editor.execution ? "Salvar rascunho" : "Criar rascunho";
  if (editor.kind === "revision") return "Criar revisão";
  if (editor.kind === "submit") return "Enviar entrega";
  if (editor.kind === "decision") return "Registrar decisão";
  if (editor.kind === "close") return "Fechar entrega";
  return editor.provider ? "Salvar fornecedor" : "Cadastrar fornecedor";
}

function PrivacyNotice() {
  return <aside className={styles.privacyNotice}><LockKeyhole aria-hidden="true" /><div><strong>Limite de privacidade permanente</strong><span>Registre somente totais e protocolos administrativos. Dados de pessoas, diagnóstico, CID, prontuário, medicação e notas clínicas são proibidos.</span></div></aside>;
}

function ExecutionFields({ module, providers, execution }: { module: AuxiliaryModule; providers: Provider[]; execution?: NonNullable<AuxiliaryEditor & { kind: "execution" }>["execution"] }) {
  const input = execution?.input ?? {}; const output = execution?.output ?? {};
  return <>
    <section className={styles.formSection}>
      <header><Building2 aria-hidden="true" /><div><strong>Identificação da entrega</strong><span>Dados comuns ao registro e à competência.</span></div></header>
      <div className={styles.formGrid}>
        <label><span>Referência</span><input name="referenceCode" defaultValue={execution?.referenceCode} placeholder="BEN-2026-08-01" required disabled={Boolean(execution)} /></label>
        <label className={styles.fieldWide}><span>Título</span><input name="title" defaultValue={execution?.title} placeholder="Processamento mensal" maxLength={180} required /></label>
        <label><span>Fornecedor</span><select name="providerId" defaultValue={execution?.providerId}><option value="">Sem fornecedor</option>{providers.filter((item) => item.status === "active" || item.id === execution?.providerId).map((item) => <option key={item.id} value={item.id}>{item.tradeName || item.legalName}</option>)}</select></label>
        <label><span>Valor da competência</span><input name="totalAmount" type="number" min="0" step="0.01" defaultValue={execution?.totalAmount ?? 0} /></label>
        <label><span>Vencimento</span><input name="dueDate" type="date" defaultValue={execution?.dueDate} /></label>
      </div>
    </section>
    <ModuleFields module={module} input={input} output={output} />
  </>;
}

function RevisionFields({ module, execution }: { module: AuxiliaryModule; execution: NonNullable<AuxiliaryEditor & { kind: "revision" }>["execution"] }) {
  return <>
    <div className={styles.contextStrip}><FilePenLine aria-hidden="true" /><span><small>ENTREGA</small><strong>{execution.referenceCode} · {execution.title}</strong></span><b>v{execution.currentRevision + 1}</b></div>
    <ModuleFields module={module} input={execution.input} output={execution.output} />
  </>;
}

function ModuleFields({ module, input, output }: { module: AuxiliaryModule; input: Record<string, unknown>; output: Record<string, unknown> }) {
  if (module === "benefits") return <div className={styles.dualForm}>
    <section className={styles.formSection}><header><span className={styles.stageNumber}>01</span><div><strong>Entrada</strong><span>Movimento recebido para processamento.</span></div></header><div className={styles.formGrid}>
      <label><span>Tipo de benefício</span><input name="benefitType" defaultValue={get(input, "benefitType")} placeholder="Plano de saúde" /></label>
      <label><span>Ação</span><select name="benefitAction" defaultValue={get(input, "action") || "billing"}><option value="include">Inclusão</option><option value="change">Alteração</option><option value="remove">Exclusão</option><option value="billing">Cobrança</option></select></label>
      <label><span>Participantes</span><input name="participantsCount" type="number" min="0" step="1" defaultValue={get(input, "participantsCount") || 0} /></label>
      <label><span>Referência de cobrança</span><input name="billingReference" defaultValue={get(input, "billingReference")} /></label>
    </div></section>
    <section className={styles.formSection}><header><span className={styles.stageNumber}>03</span><div><strong>Saída</strong><span>Retorno validado da operadora.</span></div></header><div className={styles.formGrid}>
      <label><span>Processados</span><input name="processedCount" type="number" min="0" step="1" defaultValue={get(output, "processedCount") || 0} /></label>
      <label><span>Rejeitados</span><input name="rejectedCount" type="number" min="0" step="1" defaultValue={get(output, "rejectedCount") || 0} /></label>
      <label><span>Protocolo</span><input name="operatorProtocol" defaultValue={get(output, "operatorProtocol")} /></label>
      <label><span>Vigência</span><input name="effectiveDate" type="date" defaultValue={get(output, "effectiveDate")} /></label>
    </div></section>
  </div>;
  if (module === "psychology") return <div className={styles.dualForm}>
    <section className={styles.formSection}><header><span className={styles.stageNumber}>01</span><div><strong>Entrada administrativa</strong><span>Apenas volume agregado e período.</span></div></header><div className={styles.formGrid}>
      <label><span>Modalidade</span><select name="serviceKind" defaultValue={get(input, "serviceKind") || "individual"}><option value="individual">Individual</option><option value="group">Grupo</option><option value="orientation">Orientação</option><option value="campaign">Campanha</option></select></label>
      <label><span>Sessões agendadas</span><input name="sessionsScheduled" type="number" min="0" step="1" defaultValue={get(input, "sessionsScheduled") || 0} /></label>
      <label><span>Início do período</span><input name="periodStart" type="date" defaultValue={get(input, "periodStart")} /></label>
      <label><span>Fim do período</span><input name="periodEnd" type="date" defaultValue={get(input, "periodEnd")} /></label>
    </div></section>
    <section className={styles.formSection}><header><span className={styles.stageNumber}>03</span><div><strong>Saída administrativa</strong><span>Totais consolidados, sem informação individual.</span></div></header><div className={styles.formGrid}>
      <label><span>Sessões realizadas</span><input name="sessionsDelivered" type="number" min="0" step="1" defaultValue={get(output, "sessionsDelivered") || 0} /></label>
      <label><span>Ausências</span><input name="absences" type="number" min="0" step="1" defaultValue={get(output, "absences") || 0} /></label>
      <label className={styles.fieldWide}><span>Protocolo administrativo</span><input name="administrativeProtocol" defaultValue={get(output, "administrativeProtocol")} /></label>
    </div></section>
  </div>;
  return <div className={styles.dualForm}>
    <section className={styles.formSection}><header><span className={styles.stageNumber}>01</span><div><strong>Entrada fiscal</strong><span>Serviço contratado e documento recebido.</span></div></header><div className={styles.formGrid}>
      <label className={styles.fieldWide}><span>Descrição do serviço</span><textarea name="serviceDescription" rows={3} defaultValue={get(input, "serviceDescription")} /></label>
      <label><span>Nota fiscal</span><input name="invoiceNumber" defaultValue={get(input, "invoiceNumber")} /></label>
      <label><span>Período</span><input name="servicePeriod" defaultValue={get(input, "servicePeriod")} placeholder="01/08 a 31/08" /></label>
      <label><span>Valor bruto</span><input name="grossAmount" type="number" min="0" step="0.01" defaultValue={get(input, "grossAmount") || 0} /></label>
    </div></section>
    <section className={styles.formSection}><header><span className={styles.stageNumber}>03</span><div><strong>Saída financeira</strong><span>Valor validado e referência de pagamento.</span></div></header><div className={styles.formGrid}>
      <label><span>Valor aprovado</span><input name="approvedAmount" type="number" min="0" step="0.01" defaultValue={get(output, "approvedAmount") || 0} /></label>
      <label><span>Vencimento</span><input name="paymentDueDate" type="date" defaultValue={get(output, "paymentDueDate")} /></label>
      <label className={styles.fieldWide}><span>Referência de pagamento</span><input name="paymentReference" defaultValue={get(output, "paymentReference")} /></label>
    </div></section>
  </div>;
}

function SubmitFields({ title, approvers }: { title: string; approvers: Approver[] }) {
  return <div className={styles.confirmBlock}><Send aria-hidden="true" /><strong>{title}</strong><p>A entrega será protegida contra edição até a decisão atribuída.</p><label><span>Aprovador responsável</span><select name="approverUserId" required><option value="">Selecione uma pessoa</option>{approvers.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.role}</option>)}</select></label></div>;
}
function DecisionFields({ title, approver }: { title: string; approver: string }) {
  return <div className={styles.confirmBlock}><BadgeCheck aria-hidden="true" /><strong>{title}</strong><p>Decisão atribuída a {approver || "você"}. Uma rejeição exige justificativa.</p><fieldset className={styles.decisionOptions}><legend>Decisão</legend><label><input type="radio" name="decision" value="approved" defaultChecked /> Aprovar</label><label><input type="radio" name="decision" value="rejected" /> Rejeitar</label></fieldset><label><span>Comentário da decisão</span><textarea name="comment" rows={4} maxLength={1000} placeholder="Obrigatório em caso de rejeição" /></label></div>;
}
function CloseFields({ title, reference }: { title: string; reference: string }) {
  return <div className={styles.confirmBlock}><BadgeCheck aria-hidden="true" /><strong>{title}</strong><p>A entrega {reference} foi aprovada. O fechamento encerra o ledger desta competência e fica registrado na auditoria.</p><div className={styles.finalWarning}><AlertTriangle aria-hidden="true" />Confirme somente após validar a saída e a referência de pagamento ou protocolo.</div></div>;
}

function ProviderFields({ module, provider }: { module: AuxiliaryModule; provider?: Provider }) {
  const noun = module === "benefits" ? "operadora" : module === "psychology" ? "profissional ou clínica" : "prestador";
  return <section className={styles.formSection}>
    <header><Building2 aria-hidden="true" /><div><strong>Identificação do {noun}</strong><span>Cadastro compartilhado no workspace e filtrado por lente.</span></div></header>
    <div className={styles.formGrid}>
      <label><span>Código</span><input name="code" defaultValue={provider?.code} required disabled={Boolean(provider)} placeholder="FORN-001" /></label>
      <label><span>Status</span><select name="status" defaultValue={provider?.status || "active"}><option value="active">Ativo</option><option value="inactive">Inativo</option></select></label>
      <label className={styles.fieldWide}><span>Razão social ou nome profissional</span><input name="legalName" defaultValue={provider?.legalName} required /></label>
      <label className={styles.fieldWide}><span>Nome de exibição</span><input name="tradeName" defaultValue={provider?.tradeName} /></label>
      <label><span>CPF/CNPJ</span><input name="taxId" defaultValue={provider?.taxId} inputMode="numeric" /></label>
      <label><span>Telefone</span><input name="phone" defaultValue={provider?.phone} type="tel" /></label>
      <label className={styles.fieldWide}><span>E-mail administrativo</span><input name="email" defaultValue={provider?.email} type="email" /></label>
    </div>
  </section>;
}
