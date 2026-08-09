"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, BookOpenCheck, CheckCircle2, FilePlus2, ShieldCheck, X } from "lucide-react";
import type { Approval, Approver, Cycle, EditorState, EmployeeOption } from "./operations.types";
import styles from "./operations.module.css";

type DialogProps = {
  editor: NonNullable<EditorState>; cycle: Cycle | null; companyId: string; competence: string;
  employees: EmployeeOption[]; approvers: Approver[]; busy: boolean; onClose: () => void;
  onSubmit: (editor: NonNullable<EditorState>, data: FormData) => Promise<void>;
};

const movementTypes = [
  ["vacation", "Férias"], ["leave", "Afastamento"], ["salary_change", "Alteração salarial"],
  ["termination", "Desligamento"], ["transfer", "Transferência"], ["benefit_change", "Alteração de benefício"],
  ["registration_sync", "Conciliação cadastral"], ["other", "Outra movimentação"],
] as const;

function titleFor(editor: NonNullable<EditorState>) {
  if (editor.kind === "competence") return "Abrir competência";
  if (editor.kind === "movement") return editor.movement ? "Detalhe da movimentação" : "Nova movimentação";
  if (editor.kind === "approval") return "Decidir aprovação";
  if (editor.kind === "obligation") return "Nova obrigação";
  if (editor.kind === "pending") return "Registrar pendência";
  if (editor.kind === "pending-resolution") return editor.status === "resolved" ? "Resolver pendência" : "Dispensar pendência";
  if (editor.kind === "transition") return "Confirmar avanço do ciclo";
  if (editor.kind === "process") return "Novo processo";
  if (editor.kind === "process-version") return "Criar versão em rascunho";
  return "Publicar versão";
}

export function OperationDialog(props: DialogProps) {
  const { editor, busy, onClose, onSubmit } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy);
  const closeRef = useRef(onClose);
  useEffect(() => { busyRef.current = busy; closeRef.current = onClose; }, [busy, onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusableSelector = "button:not([disabled]), input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
    const focusables = () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
    const timer = window.setTimeout(() => {
      const formControl = panelRef.current?.querySelector<HTMLElement>("form input:not([disabled]):not([type='hidden']), form select:not([disabled]), form textarea:not([disabled])");
      (formControl ?? focusables()[0])?.focus();
    }, 20);
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

  const destructive = editor.kind === "approval" || editor.kind === "pending-resolution" || editor.kind === "transition" || editor.kind === "process-publish";
  return (
    <div className={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className={`${styles.dialog} ${destructive ? styles.dialogCompact : ""}`} ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="operation-dialog-title" tabIndex={-1}>
        <header>
          <div><span className={styles.eyebrow}>AÇÃO OPERACIONAL</span><h2 id="operation-dialog-title">{titleFor(editor)}</h2></div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Fechar"><X aria-hidden="true" /></button>
        </header>
        <form onSubmit={submit}>
          <div className={styles.dialogBody}>
            {editor.kind === "competence" && <CompetenceFields competence={props.competence} />}
            {editor.kind === "movement" && <MovementFields editor={editor} employees={props.employees} approvers={props.approvers} cycle={props.cycle} />}
            {editor.kind === "approval" && <ApprovalFields approval={editor.approval} />}
            {editor.kind === "obligation" && <ObligationFields approvers={props.approvers} />}
            {editor.kind === "pending" && <PendingFields approvers={props.approvers} />}
            {editor.kind === "pending-resolution" && <ResolutionFields editor={editor} />}
            {editor.kind === "transition" && <TransitionFields target={editor.target} />}
            {editor.kind === "process" && <ProcessFields />}
            {editor.kind === "process-version" && <VersionFields processName={editor.process.name} />}
            {editor.kind === "process-publish" && <PublishFields processName={editor.process.name} version={editor.version.version} />}
          </div>
          <footer>
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

function CompetenceFields({ competence }: { competence: string }) {
  return <div className={styles.formGrid}>
    <label><span>Competência</span><input name="competence" type="month" defaultValue={competence} required /></label>
    <label><span>Prazo de pré-fechamento</span><input name="preClosingDueDate" type="date" /></label>
    <label><span>Data de pagamento</span><input name="paymentDate" type="date" /></label>
    <label><span>Prazo de pós-fechamento</span><input name="postClosingDueDate" type="date" /></label>
    <label className={styles.spanTwo}><span>Nota operacional</span><textarea name="notes" placeholder="Contexto para o ciclo, sem dados pessoais ou remuneratórios." /></label>
  </div>;
}

function MovementFields({ editor, employees, approvers, cycle }: { editor: Extract<NonNullable<EditorState>, { kind: "movement" }>; employees: EmployeeOption[]; approvers: Approver[]; cycle: Cycle | null }) {
  const movement = editor.movement;
  const [movementType, setMovementType] = useState(movement?.movementType ?? "vacation");
  const detail = (key: string) => movement?.details?.[key] == null ? "" : String(movement.details[key]);
  return <>
    <div className={styles.safetyNote}><ShieldCheck aria-hidden="true" /><span><strong>Fronteira Sólides preservada</strong><small>Admissões não são iniciadas aqui. Use conciliação cadastral somente após a conclusão na Sólides.</small></span></div>
    <div className={styles.formGrid}>
      <label className={styles.spanTwo}><span>Colaborador</span><select name="employeeId" defaultValue={movement?.employeeId} required disabled={Boolean(movement)}><option value="">Selecione</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.registrationNumber || "sem matrícula"}</option>)}</select></label>
      <label><span>Tipo</span><select name="movementType" value={movementType} onChange={(event) => setMovementType(event.target.value as typeof movementType)}>{movementTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span>Vigência</span><input name="effectiveDate" type="date" defaultValue={movement?.effectiveDate} required /></label>
      <label className={styles.spanTwo}><span>Título operacional</span><input name="title" defaultValue={movement?.title} maxLength={180} placeholder="Ex.: Programação de férias — julho" required /></label>
      {movementType === "salary_change" && <><label><span>Novo salário</span><input name="newSalary" type="number" min="0" step="0.01" defaultValue={detail("newSalary")} required /></label><label><span>Percentual</span><input name="percentage" type="number" step="0.01" defaultValue={detail("percentage")} /></label><label className={styles.spanTwo}><span>Motivo</span><textarea name="reason" maxLength={300} defaultValue={detail("reason")} /></label></>}
      {movementType === "vacation" && <><label><span>Início das férias</span><input name="startDate" type="date" defaultValue={detail("startDate")} required /></label><label><span>Fim das férias</span><input name="endDate" type="date" defaultValue={detail("endDate")} required /></label><label><span>Dias</span><input name="days" type="number" min="1" max="90" defaultValue={detail("days") || "30"} /></label></>}
      {movementType === "leave" && <><label><span>Início do afastamento</span><input name="startDate" type="date" defaultValue={detail("startDate")} required /></label><label><span>Fim previsto</span><input name="endDate" type="date" defaultValue={detail("endDate")} /></label><label className={styles.spanTwo}><span>Código/motivo</span><input name="reasonCode" defaultValue={detail("reasonCode")} /></label></>}
      {movementType === "termination" && <><label><span>Tipo de desligamento</span><input name="terminationType" defaultValue={detail("terminationType")} required /></label><label><span>Último dia trabalhado</span><input name="lastWorkingDate" type="date" defaultValue={detail("lastWorkingDate")} required /></label></>}
      {movementType === "transfer" && <><label><span>ID da empresa de destino</span><input name="targetCompanyId" defaultValue={detail("targetCompanyId")} required /></label><label><span>ID do departamento</span><input name="departmentId" defaultValue={detail("departmentId")} /></label><label><span>ID do cargo</span><input name="positionId" defaultValue={detail("positionId")} /></label><label><span>ID do centro de custo</span><input name="costCenterId" defaultValue={detail("costCenterId")} /></label></>}
      {movementType === "benefit_change" && <><label><span>Benefício</span><input name="benefit" defaultValue={detail("benefit")} required /></label><label><span>Ação</span><select name="benefitAction" defaultValue={detail("action") || "include"}><option value="include">Incluir</option><option value="change">Alterar</option><option value="remove">Remover</option></select></label><label className={styles.spanTwo}><span>Referência</span><input name="reference" defaultValue={detail("reference")} /></label></>}
      {movementType === "registration_sync" && <><label><span>Origem concluída</span><input value="Sólides" readOnly aria-label="Origem da conciliação" /><input name="sourceSystem" type="hidden" value="solides" /></label><label><span>ID externo</span><input name="externalId" defaultValue={detail("externalId")} required /></label><label className={styles.spanTwo}><span>Campos conciliados</span><input name="fields" defaultValue={Array.isArray(movement?.details?.fields) ? movement.details.fields.join(", ") : ""} placeholder="cargo, departamento, contato" /></label></>}
      {movementType === "other" && <label className={styles.spanTwo}><span>Descrição objetiva</span><textarea name="description" maxLength={1000} defaultValue={detail("description")} placeholder="Registre somente o contexto necessário. Dados sensíveis permanecem fora desta tela." /></label>}
      {movement && movement.status !== "draft" && movement.status !== "rejected" && <div className={`${styles.inlineAlert} ${styles.spanTwo}`}><AlertTriangle aria-hidden="true" />Esta movimentação não pode mais ser editada no estado atual.</div>}
    </div>
    {movement && (movement.status === "draft" || movement.status === "rejected") && <label className={styles.approverField}><span>Aprovador para envio</span><select name="approverUserId"><option value="">Salvar sem enviar</option>{approvers.map((person) => <option key={person.id} value={person.id}>{person.name || person.email}</option>)}</select><small>Selecione para salvar e enviar à aprovação em uma única sequência.</small></label>}
    {!cycle && <div className={styles.inlineAlert}><AlertTriangle aria-hidden="true" />Abra a competência antes de vincular a movimentação ao ciclo.</div>}
  </>;
}

function ApprovalFields({ approval }: { approval: Approval }) {
  const sensitive = approval.movementTitle.toLocaleLowerCase("pt-BR").includes("salár") || approval.movementTitle.toLocaleLowerCase("pt-BR").includes("deslig");
  return <>
    <div className={styles.decisionHero}><ShieldCheck aria-hidden="true" /><div><strong>{approval.employeeName || "Colaborador"}</strong><span>{approval.movementTitle}</span></div></div>
    {sensitive && <div className={styles.inlineAlert}><AlertTriangle aria-hidden="true" />Alterações salariais e desligamentos nunca permitem autoaprovação.</div>}
    <fieldset className={styles.decisionChoice}><legend>Decisão</legend><label><input type="radio" name="decision" value="approved" required /><CheckCircle2 aria-hidden="true" /> Aprovar</label><label><input type="radio" name="decision" value="rejected" required /><X aria-hidden="true" /> Rejeitar</label></fieldset>
    <label className={styles.field}><span>Comentário</span><textarea name="comment" placeholder="Obrigatório para rejeição; recomendado para manter a trilha de decisão." /></label>
  </>;
}

function ObligationFields({ approvers }: { approvers: Approver[] }) {
  return <div className={styles.formGrid}>
    <label><span>Tipo</span><select name="obligationType" defaultValue="payroll"><option value="payroll">Folha</option><option value="social_security">Previdenciária</option><option value="tax">Tributária</option><option value="reporting">Declaração</option><option value="union">Sindical</option><option value="other">Outra</option></select></label>
    <label><span>Prazo legal</span><input name="dueDate" type="date" required /></label>
    <label className={styles.spanTwo}><span>Título</span><input name="title" required maxLength={180} placeholder="Ex.: Enviar DCTFWeb" /></label>
    <label><span>Responsável</span><select name="ownerUserId"><option value="">Não atribuído</option>{approvers.map((person) => <option key={person.id} value={person.id}>{person.name || person.email}</option>)}</select></label>
    <label><span>ID da demanda (opcional)</span><input name="cardId" /></label>
    <label className={styles.spanTwo}><span>Notas</span><textarea name="notes" /></label>
  </div>;
}

function PendingFields({ approvers }: { approvers: Approver[] }) {
  return <div className={styles.formGrid}>
    <label><span>Severidade</span><select name="severity" defaultValue="warning"><option value="info">Informativa</option><option value="warning">Atenção</option><option value="critical">Crítica</option></select></label>
    <label><span>Prazo</span><input name="dueDate" type="date" /></label>
    <label className={styles.spanTwo}><span>Título</span><input name="title" required maxLength={180} /></label>
    <label><span>Origem</span><select name="sourceType"><option value="cycle">Competência</option><option value="movement">Movimentação</option><option value="approval">Aprovação</option><option value="obligation">Obrigação</option><option value="card">Demanda</option></select></label>
    <label><span>Responsável</span><select name="ownerUserId"><option value="">Não atribuído</option>{approvers.map((person) => <option key={person.id} value={person.id}>{person.name || person.email}</option>)}</select></label>
    <label className={styles.blockingToggle}><input name="blocking" type="checkbox" /><span><strong>Bloqueia o fechamento</strong><small>O ciclo não poderá avançar enquanto estiver aberta.</small></span></label>
  </div>;
}

function ResolutionFields({ editor }: { editor: Extract<NonNullable<EditorState>, { kind: "pending-resolution" }> }) {
  return <><div className={styles.decisionHero}><AlertTriangle aria-hidden="true" /><div><strong>{editor.item.title}</strong><span>{editor.item.blocking ? "Bloqueador do ciclo" : "Pendência não bloqueante"}</span></div></div><label className={styles.field}><span>{editor.status === "waived" ? "Motivo da dispensa" : "Resolução aplicada"}</span><textarea name="resolution" required autoFocus maxLength={1000} /></label></>;
}
function TransitionFields({ target }: { target: Cycle["status"] }) {
  const labels: Record<Cycle["status"], string> = { open: "Aberta", pre_closing: "Pré-fechamento", processing: "Processamento", post_closing: "Pós-fechamento", closed: "Concluída" };
  return <><div className={styles.decisionHero}><ArrowRight aria-hidden="true" /><div><strong>Avançar para {labels[target]}</strong><span>Os gates serão verificados no servidor antes da transição.</span></div></div>{target === "closed" && <div className={styles.inlineAlert}><ShieldCheck aria-hidden="true" />Todos os checklists e obrigações precisam estar concluídos.</div>}</>;
}
function ProcessFields() { return <div className={styles.formGrid}><label><span>Código</span><input name="code" required maxLength={60} placeholder="FERIAS_MENSAL" /></label><label><span>Categoria</span><input name="category" defaultValue="rotina" /></label><label className={styles.spanTwo}><span>Nome do processo</span><input name="name" required maxLength={160} /></label><label className={styles.spanTwo}><span>Primeira etapa</span><input name="firstStep" required placeholder="Ex.: Receber informações" /></label></div>; }
function VersionFields({ processName }: { processName: string }) { return <><div className={styles.decisionHero}><FilePlus2 aria-hidden="true" /><div><strong>{processName}</strong><span>A versão publicada continuará ativa até a publicação deste rascunho.</span></div></div><label className={styles.field}><span>Nome da nova etapa</span><input name="firstStep" required placeholder="Ex.: Conferência do analista" /></label></>; }
function PublishFields({ processName, version }: { processName: string; version: number }) { return <><div className={styles.decisionHero}><BookOpenCheck aria-hidden="true" /><div><strong>{processName} · versão {version}</strong><span>A versão publicada atual será aposentada.</span></div></div><div className={styles.inlineAlert}><AlertTriangle aria-hidden="true" />Publicar altera o padrão operacional disponível para o workspace.</div></>; }

function submitLabel(editor: NonNullable<EditorState>) {
  if (editor.kind === "competence") return "Abrir competência";
  if (editor.kind === "movement") return editor.movement ? "Salvar alteração" : "Criar rascunho";
  if (editor.kind === "approval") return "Registrar decisão";
  if (editor.kind === "obligation") return "Criar obrigação";
  if (editor.kind === "pending") return "Registrar pendência";
  if (editor.kind === "pending-resolution") return editor.status === "resolved" ? "Marcar resolvida" : "Dispensar";
  if (editor.kind === "transition") return "Confirmar transição";
  if (editor.kind === "process") return "Criar processo";
  if (editor.kind === "process-version") return "Criar rascunho";
  return "Publicar versão";
}
