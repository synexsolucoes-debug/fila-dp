"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  AlertTriangle, BarChart3, CalendarClock, CheckCircle2, ClipboardCheck, HardHat,
  PackageCheck, Pencil, Plus, RefreshCw, ShieldCheck, Users, XCircle,
} from "lucide-react";
import { epiComplianceStatusLabels, type EpiComplianceStatus } from "@/lib/epi-compliance";
import { EmptyState, PanelHeader, StatusPill } from "../shared";
import { currency, dateLabel } from "./epi.api";
import type {
  EmployeeOption, EpiCatalogOption, EpiDashboard, EpiEmployeeCompliance, EpiProduct, EpiRequirement,
} from "./epi.types";
import styles from "./epi.module.css";

const statusTone: Record<EpiComplianceStatus, string> = {
  missing: "danger", expired: "danger", overdue: "warning", due_soon: "warning", compliant: "active", unconfigured: "neutral",
};

function CompliancePill({ status }: { status: EpiComplianceStatus }) {
  return <StatusPill status={statusTone[status]} label={epiComplianceStatusLabels[status]} />;
}

export function EpiDashboardPanel({ dashboard, month, onMonth, onPeople, onRequirements, onReport }: {
  dashboard: EpiDashboard | null;
  month: string;
  onMonth: (value: string) => void;
  onPeople: (status?: EpiComplianceStatus) => void;
  onRequirements: () => void;
  onReport: () => void;
}) {
  if (!dashboard) return <EmptyState icon={BarChart3} title="Dashboard ainda não carregado" text="Selecione uma empresa para acompanhar cobertura, trocas e utilização mensal." />;
  const summary = dashboard.summary;
  const maxUsage = Math.max(...dashboard.utilization.map((item) => item.delivered), 1);
  const coveredPercent = summary.activeEmployees ? Math.round(summary.employeesWithRequiredEpi / summary.activeEmployees * 100) : 0;
  const statusCount = (status: EpiComplianceStatus) => dashboard.employees.filter((item) => item.status === status).length;

  return <div className={styles.dashboardStack}>
    <PanelHeader eyebrow="CONFORMIDADE E UTILIZAÇÃO" title="Dashboard de EPI"
      description="Cobertura atual dos colaboradores e movimentação da competência selecionada."
      action={<div className={styles.monthActions}>
        <label><span>COMPETÊNCIA</span><input type="month" value={month} onChange={(event) => onMonth(event.target.value)} /></label>
        <button type="button" className={styles.secondaryButton} onClick={onReport}><ClipboardCheck aria-hidden="true" /> Relatório mensal</button>
      </div>} />

    <div className={styles.summaryGrid}>
      <button className={styles.summaryCard} data-tone={coveredPercent === 100 ? "safe" : "neutral"} onClick={() => onPeople()}>
        <span><Users aria-hidden="true" />Colaboradores ativos</span><strong>{summary.activeEmployees}</strong>
        <small>{coveredPercent}% com todos os EPIs obrigatórios</small>
      </button>
      <button className={styles.summaryCard} data-tone={summary.missingEmployees ? "danger" : "safe"} onClick={() => onPeople("missing")}>
        <span><XCircle aria-hidden="true" />Sem EPI obrigatório</span><strong>{summary.missingEmployees}</strong>
        <small>Precisam de entrega</small>
      </button>
      <button className={styles.summaryCard} data-tone={summary.expiredEmployees ? "danger" : "safe"} onClick={() => onPeople("expired")}>
        <span><AlertTriangle aria-hidden="true" />Vencidos</span><strong>{summary.expiredEmployees}</strong>
        <small>Produto ou CA vencido</small>
      </button>
      <button className={styles.summaryCard} data-tone={summary.overdueEmployees ? "warning" : "safe"} onClick={() => onPeople("overdue")}>
        <span><CalendarClock aria-hidden="true" />Trocas atrasadas</span><strong>{summary.overdueEmployees}</strong>
        <small>{summary.dueSoonEmployees} troca(s) próxima(s)</small>
      </button>
      <article className={styles.summaryCard} data-tone={summary.stockShortages ? "danger" : "safe"}>
        <span><HardHat aria-hidden="true" />Rupturas previstas</span><strong>{summary.stockShortages}</strong>
        <small>EPIs sem saldo para cobrir faltas</small>
      </article>
      <article className={styles.summaryCard}>
        <span><PackageCheck aria-hidden="true" />Entregas no mês</span><strong>{summary.monthlyDeliveries}</strong>
        <small>{summary.monthlyEmployeesServed} colaborador(es) · {currency(summary.monthlyDeliveredValue)}</small>
      </article>
    </div>

    <section className={styles.coveragePanel} aria-label="Distribuição da conformidade">
      <div className={styles.coverageHeader}>
        <div><span>COBERTURA ATUAL</span><strong>{summary.compliantEmployees} em dia</strong></div>
        <button className={styles.ghostButton} onClick={onRequirements}><ShieldCheck aria-hidden="true" /> Configurar obrigatoriedade</button>
      </div>
      <div className={styles.coverageBar} aria-label={`${coveredPercent}% com EPIs obrigatórios`}>
        <span data-tone="safe" style={{ width: `${summary.activeEmployees ? statusCount("compliant") / summary.activeEmployees * 100 : 0}%` }} />
        <span data-tone="warning" style={{ width: `${summary.activeEmployees ? (statusCount("due_soon") + statusCount("overdue")) / summary.activeEmployees * 100 : 0}%` }} />
        <span data-tone="danger" style={{ width: `${summary.activeEmployees ? (statusCount("missing") + statusCount("expired")) / summary.activeEmployees * 100 : 0}%` }} />
        <span data-tone="neutral" style={{ width: `${summary.activeEmployees ? statusCount("unconfigured") / summary.activeEmployees * 100 : 0}%` }} />
      </div>
      <div className={styles.coverageLegend}>
        <button onClick={() => onPeople("compliant")}><i data-tone="safe" />Em dia <b>{summary.compliantEmployees}</b></button>
        <button onClick={() => onPeople("due_soon")}><i data-tone="warning" />Troca próxima <b>{summary.dueSoonEmployees}</b></button>
        <button onClick={() => onPeople("missing")}><i data-tone="danger" />Em falta <b>{summary.missingEmployees}</b></button>
        <button onClick={() => onPeople("unconfigured")}><i data-tone="neutral" />Sem regra <b>{summary.unconfiguredEmployees}</b></button>
      </div>
    </section>

    <div className={styles.dashboardColumns}>
      <section className={styles.chartPanel}>
        <header><div><span>UTILIZAÇÃO EM {month}</span><h3>EPIs mais entregues</h3></div><BarChart3 aria-hidden="true" /></header>
        {dashboard.utilization.length ? <div className={styles.usageList}>
          {dashboard.utilization.map((item) => <div key={item.productId} className={styles.usageRow}>
            <div><strong>{item.productName}</strong><small>{item.delivered} entregue(s) · {item.returned} devolvido(s) · saldo {item.availableQuantity}</small></div>
            <div className={styles.usageBar}><span style={{ width: `${item.delivered / maxUsage * 100}%` }} /></div>
            <b>{currency(item.deliveredValue)}</b>
          </div>)}
        </div> : <EmptyState icon={BarChart3} size="compact" title="Sem utilização nesta competência" text="As entregas registradas no mês aparecerão aqui." />}
      </section>
      <section className={styles.chartPanel}>
        <header><div><span>PLANEJAMENTO DE ESTOQUE</span><h3>Falta para cobrir colaboradores</h3></div><AlertTriangle aria-hidden="true" /></header>
        {dashboard.shortages.length ? <div className={styles.shortageList}>
          {dashboard.shortages.map((item) => <div key={item.productId}>
            <span><strong>{item.productName}</strong><small>{item.missing} necessário(s) · {item.available} disponível(is)</small></span>
            <StatusPill status="danger" label={`Faltam ${item.shortage}`} />
          </div>)}
        </div> : <div className={styles.allGood}><CheckCircle2 aria-hidden="true" /><span><strong>Saldo suficiente para as faltas atuais</strong><small>Não há ruptura calculada a partir das regras cadastradas.</small></span></div>}
      </section>
    </div>
  </div>;
}

export function EpiPeoplePanel({ employees, initialStatus, products, onDeliver }: {
  employees: EpiEmployeeCompliance[];
  initialStatus: string;
  products: EpiProduct[];
  onDeliver: (employee: EmployeeOption, product?: EpiProduct) => void;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const filtered = useMemo(() => employees.filter((employee) => {
    const haystack = `${employee.name} ${employee.registrationNumber} ${employee.departmentName} ${employee.positionName}`.toLocaleLowerCase("pt-BR");
    const matchesSearch = !search || haystack.includes(search.toLocaleLowerCase("pt-BR"));
    const matchesStatus = !status || employee.status === status || employee.items.some((item) => item.status === status);
    return matchesSearch && matchesStatus;
  }), [employees, search, status]);

  return <>
    <PanelHeader eyebrow="MAPA POR COLABORADOR" title="Quem tem EPI e quem precisa de atendimento"
      description="A situação compara os EPIs em poder do colaborador com a regra do cargo e departamento." />
    <div className={styles.filterBar}>
      <label><span>BUSCAR</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome, matrícula, cargo…" /></label>
      <label><span>SITUAÇÃO</span><select value={status} onChange={(event) => setStatus(event.target.value)}>
        <option value="">Todas</option>
        {Object.entries(epiComplianceStatusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      {(search || status) && <button className={styles.ghostButton} onClick={() => { setSearch(""); setStatus(""); }}>Limpar filtros</button>}
    </div>
    {filtered.length ? <div className={styles.tableWrap}>
      <table className={styles.dataTable}>
        <thead><tr><th>Colaborador</th><th>Lotação</th><th>Em poder</th><th>Em falta / atenção</th><th>Próxima troca</th><th>Situação</th><th /></tr></thead>
        <tbody>{filtered.map((employee) => {
          const attention = employee.items.filter((item) => item.status !== "compliant");
          const actionItem = attention.find((item) => ["missing", "expired", "overdue"].includes(item.status));
          const product = actionItem ? products.find((item) => item.id === actionItem.productId) : undefined;
          return <tr key={employee.id}>
            <td><strong>{employee.name}</strong><small>Matrícula {employee.registrationNumber || "não informada"}</small></td>
            <td><strong>{employee.departmentName || "Sem departamento"}</strong><small>{employee.positionName || "Sem cargo"}</small></td>
            <td>{employee.holdings.length ? <div className={styles.compactList}>{employee.holdings.map((item) => <span key={item.productId}>{item.productName} <b>{item.quantity}</b></span>)}</div> : <small>Nenhum EPI em poder</small>}</td>
            <td>{attention.length ? <div className={styles.compactList}>{attention.slice(0, 3).map((item) => <span key={item.requirementId} data-tone={item.status}>{item.productName} · {epiComplianceStatusLabels[item.status]}</span>)}</div> : <small>Nenhuma pendência</small>}</td>
            <td>{employee.nextExchangeOn ? dateLabel(employee.nextExchangeOn) : "—"}</td>
            <td><CompliancePill status={employee.status} /></td>
            <td>{actionItem && <button className={styles.rowActionPrimary} onClick={() => onDeliver({
              id: employee.id, name: employee.name, registrationNumber: employee.registrationNumber,
              departmentName: employee.departmentName, positionName: employee.positionName,
            }, product)}><PackageCheck aria-hidden="true" /> Entregar</button>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div> : <EmptyState icon={Users} title="Nenhum colaborador neste filtro" text="Mude a busca ou a situação para ver outros colaboradores." />}
  </>;
}

export function EpiRequirementsPanel({ companyId, requirements, departments, positions, products, canManage, busy, onCreate, onUpdate, onReload }: {
  companyId: string;
  requirements: EpiRequirement[];
  departments: EpiCatalogOption[];
  positions: EpiCatalogOption[];
  products: EpiProduct[];
  canManage: boolean;
  busy: boolean;
  onCreate: (payload: Record<string, unknown>) => Promise<void>;
  onUpdate: (id: string, payload: Record<string, unknown>) => Promise<void>;
  onReload: () => void;
}) {
  const [editing, setEditing] = useState<EpiRequirement | null>(null);
  return <div className={styles.requirementsStack}>
    <PanelHeader eyebrow="REGRAS DE COBERTURA" title="EPIs obrigatórios por lotação"
      description="Defina por empresa, departamento e/ou cargo. Deixe cargo ou departamento em branco para aplicar a todos daquele recorte."
      action={<button className={styles.secondaryButton} onClick={onReload}><RefreshCw aria-hidden="true" /> Atualizar</button>} />
    {canManage ? <RequirementEditor key={editing?.id ?? "new"} companyId={companyId} requirement={editing}
      departments={departments} positions={positions} products={products} busy={busy}
      onCancel={() => setEditing(null)} onSave={async (payload) => {
        if (editing) await onUpdate(editing.id, payload); else await onCreate(payload);
        setEditing(null);
      }} /> : <p className={styles.fieldHint}>A criação e edição destas regras exige a permissão epi.edit.</p>}

    {requirements.length ? <div className={styles.tableWrap}>
      <table className={styles.dataTable}>
        <thead><tr><th>Aplicação</th><th>EPI obrigatório</th><th>Qtd.</th><th>Ciclo de troca</th><th>Alerta</th><th>Status</th><th /></tr></thead>
        <tbody>{requirements.map((item) => <tr key={item.id}>
          <td><strong>{item.departmentName || "Todos os departamentos"}</strong><small>{item.positionName || "Todos os cargos"}</small></td>
          <td><strong>{item.productName}</strong><small>{item.caNumber ? `CA ${item.caNumber}` : "CA não informado"}</small></td>
          <td>{item.quantity}</td>
          <td>{item.replacementDays ? `A cada ${item.replacementDays} dias` : "Sem ciclo automático"}</td>
          <td>{item.replacementDays ? `${item.warningDays} dias antes` : "—"}</td>
          <td><StatusPill status={item.active ? "active" : "inactive"} label={item.active ? "Ativa" : "Inativa"} /></td>
          <td><div className={styles.rowActions}>
            {canManage && <button onClick={() => setEditing(item)}><Pencil aria-hidden="true" /> Editar</button>}
            {canManage && <button disabled={busy} onClick={() => void onUpdate(item.id, { active: !item.active })}>{item.active ? "Inativar" : "Ativar"}</button>}
          </div></td>
        </tr>)}</tbody>
      </table>
    </div> : <EmptyState icon={ShieldCheck} title="Nenhuma regra obrigatória cadastrada"
      text="Cadastre o primeiro EPI por cargo ou departamento. Até lá, os colaboradores aparecem como “Sem regra definida”." />}
  </div>;
}

function RequirementEditor({ companyId, requirement, departments, positions, products, busy, onSave, onCancel }: {
  companyId: string; requirement: EpiRequirement | null; departments: EpiCatalogOption[]; positions: EpiCatalogOption[];
  products: EpiProduct[]; busy: boolean; onSave: (payload: Record<string, unknown>) => Promise<void>; onCancel: () => void;
}) {
  const [departmentId, setDepartmentId] = useState(requirement?.departmentId ?? "");
  const [positionId, setPositionId] = useState(requirement?.positionId ?? "");
  const [productId, setProductId] = useState(requirement?.productId ?? products.find((item) => item.status !== "inactive")?.id ?? "");
  const [quantity, setQuantity] = useState(String(requirement?.quantity ?? 1));
  const [replacementDays, setReplacementDays] = useState(String(requirement?.replacementDays ?? 180));
  const [warningDays, setWarningDays] = useState(String(requirement?.warningDays ?? 30));
  const [notes, setNotes] = useState(requirement?.notes ?? "");
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await onSave({ companyId, departmentId: departmentId || null, positionId: positionId || null, productId,
        quantity: Number(quantity), replacementDays: Number(replacementDays), warningDays: Number(warningDays), notes });
    } catch { /* o banner do módulo preserva a edição e mostra o erro do servidor */ }
  }
  return <form className={styles.requirementEditor} onSubmit={(event) => void submit(event)}>
    <header><div><span>{requirement ? "EDITAR REGRA" : "NOVA REGRA"}</span><h3>{requirement ? requirement.productName : "Definir EPI obrigatório"}</h3></div>{requirement && <button type="button" className={styles.closeButton} onClick={onCancel} aria-label="Cancelar edição"><XCircle aria-hidden="true" /></button>}</header>
    <div className={styles.stockOperationForm}>
      <label><span>DEPARTAMENTO</span><select value={departmentId} onChange={(event) => setDepartmentId(event.target.value)} disabled={Boolean(requirement)}><option value="">Todos</option>{departments.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label><span>CARGO</span><select value={positionId} onChange={(event) => setPositionId(event.target.value)} disabled={Boolean(requirement)}><option value="">Todos</option>{positions.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label><span>EPI *</span><select required value={productId} onChange={(event) => setProductId(event.target.value)} disabled={Boolean(requirement)}><option value="">Selecione</option>{products.filter((item) => item.status !== "inactive").map((item) => <option key={item.id} value={item.id}>{item.name} · {item.size}</option>)}</select></label>
      <label><span>QUANTIDADE *</span><input required type="number" min="1" max="100" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
      <label><span>TROCAR A CADA (DIAS)</span><input type="number" min="0" max="3650" value={replacementDays} onChange={(event) => setReplacementDays(event.target.value)} /></label>
      <label><span>ALERTAR ANTES (DIAS)</span><input type="number" min="0" max="365" value={warningDays} onChange={(event) => setWarningDays(event.target.value)} /></label>
      <label className={styles.formWide}><span>OBSERVAÇÃO</span><input maxLength={1000} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Ex.: obrigatório em atividades com risco de queda" /></label>
      <div className={styles.commandActions}>{requirement && <button type="button" className={styles.secondaryButton} onClick={onCancel}>Cancelar</button>}<button className={styles.primaryButton} disabled={busy || !productId}><Plus aria-hidden="true" /> {busy ? "Salvando…" : requirement ? "Salvar regra" : "Adicionar regra"}</button></div>
    </div>
  </form>;
}
