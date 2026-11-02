"use client";

import { FormEvent, useState } from "react";
import dynamic from "next/dynamic";
import { ModuleLoading } from "../shared/ModuleLoading";
import { CalendarClock, CalendarDays, CheckCircle2, Clock3, Plus, Trash2, Upload, WalletCards } from "lucide-react";
import { formatDate } from "../overview/formatting";
import { DemandAreaFlow, formatReceived, processColors, slaLabel } from "../shared/demand-display";
import type { Card, InboxItem, WorkspaceSnapshot } from "@/lib/fila-dp-types";
import { contagem } from "../shared/plural";

// Importação e movimentos da folha: carregados quando a tela da Folha abre.
const PayrollImportDialog = dynamic(() => import("../payroll/PayrollImportDialog").then((module) => module.PayrollImportDialog), { loading: ModuleLoading });
const PayrollMovementsPanel = dynamic(() => import("../payroll/PayrollMovementsPanel").then((module) => module.PayrollMovementsPanel), { loading: ModuleLoading });

/*
 * Telas menores do painel: Folha, tabela de demandas, Planner e Inbox. Saíram de `WorkspaceApp.tsx`; recebem dados e
 * ações por props.
 */

export function PayrollView({ companies, metrics, busy, canEdit, onSaveMetric, onImportPayroll }: { companies: WorkspaceSnapshot["companies"]; metrics: WorkspaceSnapshot["hrMetrics"]; busy: boolean; canEdit: boolean; onSaveMetric: (payload: Record<string, unknown>) => Promise<WorkspaceSnapshot | null>; onImportPayroll: (body: FormData) => Promise<WorkspaceSnapshot | null> }) {
  const currentPeriod = new Date().toISOString().slice(0, 7);
  const [selectedPeriod, setSelectedPeriod] = useState(currentPeriod);
  const [importOpen, setImportOpen] = useState(false);
  const [form, setForm] = useState({
    companyId: companies.find((company) => company.status === "active")?.id ?? "", period: currentPeriod,
    headcountStart: "0", headcountEnd: "0", leavesCount: "0", admissions: "0", voluntaryTerminations: "0", involuntaryTerminations: "0",
    baseSalary: "0", variablePay: "0", overtimePay: "0", additionalPay: "0", vacationPay: "0", thirteenthPay: "0", terminationPay: "0",
    employeeInss: "0", employeeIrrf: "0", employeeOtherDeductions: "0",
    employerInss: "0", ratContribution: "0", thirdPartyContributions: "0", fgts: "0", fgtsPenalty: "0",
    benefitsCost: "0", provisionsCost: "0", otherCosts: "0", notes: "",
  });
  const companyName = new Map(companies.map((company) => [company.id, company.tradeName || company.legalName]));
  const periods = [...new Set([currentPeriod, ...metrics.map((metric) => metric.period)])].sort((a, b) => b.localeCompare(a));
  const selectedMetrics = metrics.filter((metric) => metric.period === selectedPeriod);
  const toNumber = (value: string | number) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const totalCost = selectedMetrics.reduce((total, metric) => total + metric.payrollCost, 0);
  const totalHeadcount = selectedMetrics.reduce((total, metric) => total + metric.headcount, 0);
  const totalAdmissions = selectedMetrics.reduce((total, metric) => total + metric.admissions, 0);
  const totalTerminations = selectedMetrics.reduce((total, metric) => total + metric.terminations, 0);
  const turnover = totalHeadcount ? ((totalAdmissions + totalTerminations) / 2 / totalHeadcount) * 100 : 0;
  const costPerEmployee = totalHeadcount ? totalCost / totalHeadcount : 0;
  const componentTotals = [
    { label: "Remuneração bruta", value: selectedMetrics.reduce((total, metric) => total + metric.grossPayroll, 0), color: "#62D5B2" },
    { label: "Encargos", value: selectedMetrics.reduce((total, metric) => total + metric.employerCharges, 0), color: "#73b8ff" },
    { label: "Benefícios", value: selectedMetrics.reduce((total, metric) => total + metric.benefitsCost, 0), color: "#b99cff" },
    { label: "Provisões e outros", value: selectedMetrics.reduce((total, metric) => total + metric.provisionsCost + metric.otherCosts, 0), color: "#F4A261" },
  ];
  const formHeadcount = (toNumber(form.headcountStart) + toNumber(form.headcountEnd)) / 2;
  const formTerminations = toNumber(form.voluntaryTerminations) + toNumber(form.involuntaryTerminations);
  const formGrossPayroll = toNumber(form.baseSalary) + toNumber(form.variablePay) + toNumber(form.overtimePay) + toNumber(form.additionalPay) + toNumber(form.vacationPay) + toNumber(form.thirteenthPay) + toNumber(form.terminationPay);
  const formDeductions = toNumber(form.employeeInss) + toNumber(form.employeeIrrf) + toNumber(form.employeeOtherDeductions);
  const formNetPay = Math.max(0, formGrossPayroll - formDeductions);
  const formEmployerCharges = toNumber(form.employerInss) + toNumber(form.ratContribution) + toNumber(form.thirdPartyContributions) + toNumber(form.fgts) + toNumber(form.fgtsPenalty);
  const formTotal = formGrossPayroll + formEmployerCharges + toNumber(form.benefitsCost) + toNumber(form.provisionsCost) + toNumber(form.otherCosts);
  const expectedHeadcount = Math.max(0, toNumber(form.headcountStart) + toNumber(form.admissions) - formTerminations);
  const money = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  type NumericFormKey = Exclude<keyof typeof form, "companyId" | "period" | "notes">;
  const numericField = (label: string, key: NumericFormKey, step = "1") => <label key={key}>{label}<input type="number" min="0" step={step} value={form[key]} disabled={busy} onChange={(event) => setForm({ ...form, [key]: event.target.value })} /></label>;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await onSaveMetric({ ...form, headcount: formHeadcount, terminations: formTerminations, grossPayroll: formGrossPayroll, employerCharges: formEmployerCharges, netPay: formNetPay, payrollCost: formTotal, source: "manual" });
    if (result) setForm((current) => ({ ...current, headcountStart: "0", headcountEnd: "0", leavesCount: "0", admissions: "0", voluntaryTerminations: "0", involuntaryTerminations: "0", baseSalary: "0", variablePay: "0", overtimePay: "0", additionalPay: "0", vacationPay: "0", thirteenthPay: "0", terminationPay: "0", employeeInss: "0", employeeIrrf: "0", employeeOtherDeductions: "0", employerInss: "0", ratContribution: "0", thirdPartyContributions: "0", fgts: "0", fgtsPenalty: "0", benefitsCost: "0", provisionsCost: "0", otherCosts: "0", notes: "" }));
  }

  return <div className="payroll-view">
    <section className="payroll-toolbar"><div><span>Competência</span><h2>Painel consolidado da folha</h2><p>Os indicadores são recalculados automaticamente a cada lançamento, importação ou sincronização.</p></div><div className="payroll-toolbar-actions">{canEdit && <button className="secondary-button" onClick={() => setImportOpen(true)}><Upload aria-hidden="true" /> Importar extrato PDF</button>}<label>Período<select value={selectedPeriod} onChange={(event) => setSelectedPeriod(event.target.value)}>{periods.map((period) => <option key={period}>{period}</option>)}</select></label></div></section>
    <section className="payroll-kpi-grid"><article><span>Custo total da folha</span><strong>{money(totalCost)}</strong><small>{contagem(selectedMetrics.length, "empresa", "empresas")} com competência</small></article><article><span>Headcount médio</span><strong>{totalHeadcount}</strong><small>{totalAdmissions} admissões · {totalTerminations} desligamentos</small></article><article><span>Turnover</span><strong>{turnover.toFixed(2)}%</strong><small>Movimentação ÷ headcount médio</small></article><article><span>Custo por colaborador</span><strong>{money(costPerEmployee)}</strong><small>Baseado no headcount médio</small></article></section>
    <div className="payroll-layout">
      <section className="payroll-composition"><header><div><strong>Composição do custo</strong><span>Distribuição da competência selecionada</span></div><b>{money(totalCost)}</b></header><div className="payroll-bars">{componentTotals.map((item) => <div key={item.label}><span><strong>{item.label}</strong><small>{money(item.value)}</small></span><i><b style={{ width: `${totalCost ? Math.min(100, (item.value / totalCost) * 100) : 0}%`, backgroundColor: item.color }} /></i></div>)}</div></section>
      <section className="payroll-company-breakdown"><header><div><strong>Folha por empresa</strong><span>{contagem(selectedMetrics.length, "lançamento", "lançamentos")} em {selectedPeriod}</span></div></header>{selectedMetrics.length === 0 && <div className="empty-view"><span><WalletCards aria-hidden="true" /></span><strong>Sem lançamentos nesta competência</strong><p>Registre os dados da folha para gerar os indicadores automaticamente.</p></div>}{selectedMetrics.map((metric) => <article key={metric.id}><div><strong>{companyName.get(metric.companyId) ?? "Empresa removida"}</strong><small>{metric.headcount} colaboradores · {metric.admissions} admissões · {metric.terminations} desligamentos · líquido {money(metric.netPay)}</small></div><span>{money(metric.payrollCost)}</span><b>{metric.source === "sankhya" ? "Sankhya" : metric.source === "pdf_import" ? "PDF" : "Manual"}</b></article>)}</section>
    </div>
    {importOpen && <PayrollImportDialog companies={companies} importing={busy} onClose={() => setImportOpen(false)} onImport={onImportPayroll} onImported={(period) => { setImportOpen(false); setSelectedPeriod(period); }} />}
    {/* Movimentos para o Sankhya: lança os eventos variáveis por colaborador e
        gera a planilha do Importador de Movimentos (docs/movimentos-para-o-sankhya.md). */}
    <PayrollMovementsPanel companies={companies} canEdit={canEdit} />
    {canEdit && <section className="payroll-entry-panel"><header><div><span>Novo lançamento</span><h2>Registrar dados da folha</h2><p>Informe os valores já apurados na folha ou no ERP.</p></div><b>Total calculado: {money(formTotal)}</b></header><form onSubmit={(event) => void submit(event)}>
      <label>Empresa<select value={form.companyId} required disabled={busy} onChange={(event) => setForm({ ...form, companyId: event.target.value })}><option value="" disabled>Selecione</option>{companies.filter((company) => company.status === "active").map((company) => <option value={company.id} key={company.id}>{company.tradeName || company.legalName}</option>)}</select></label>
      <label>Competência<input type="month" value={form.period} required disabled={busy} onChange={(event) => setForm({ ...form, period: event.target.value })} /></label>
      <fieldset className="payroll-form-section"><legend>Pessoas e movimentação</legend>{numericField("Headcount no início", "headcountStart")}{numericField("Headcount no fim", "headcountEnd")}{numericField("Afastados no período", "leavesCount")}{numericField("Admissões", "admissions")}{numericField("Desligamentos voluntários", "voluntaryTerminations")}{numericField("Desligamentos involuntários", "involuntaryTerminations")}<p>Headcount médio: <strong>{formHeadcount.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}</strong> · encerramento esperado: <strong>{expectedHeadcount.toLocaleString("pt-BR")}</strong></p></fieldset>
      <fieldset className="payroll-form-section"><legend>Proventos da competência</legend>{numericField("Salário-base", "baseSalary", "0.01")}{numericField("Variáveis / comissões", "variablePay", "0.01")}{numericField("Horas extras", "overtimePay", "0.01")}{numericField("Adicionais", "additionalPay", "0.01")}{numericField("Férias + 1/3", "vacationPay", "0.01")}{numericField("13º salário", "thirteenthPay", "0.01")}{numericField("Verbas rescisórias", "terminationPay", "0.01")}<p>Remuneração bruta calculada: <strong>{money(formGrossPayroll)}</strong></p></fieldset>
      <fieldset className="payroll-form-section"><legend>Descontos do colaborador</legend>{numericField("INSS do colaborador", "employeeInss", "0.01")}{numericField("IRRF", "employeeIrrf", "0.01")}{numericField("Outros descontos", "employeeOtherDeductions", "0.01")}<p>Descontos: <strong>{money(formDeductions)}</strong> · líquido calculado: <strong>{money(formNetPay)}</strong></p></fieldset>
      <fieldset className="payroll-form-section"><legend>Encargos do empregador</legend>{numericField("INSS patronal", "employerInss", "0.01")}{numericField("RAT", "ratContribution", "0.01")}{numericField("Terceiros", "thirdPartyContributions", "0.01")}{numericField("FGTS", "fgts", "0.01")}{numericField("Multa de FGTS", "fgtsPenalty", "0.01")}<p>Encargos patronais calculados: <strong>{money(formEmployerCharges)}</strong></p></fieldset>
      <fieldset className="payroll-form-section"><legend>Custos complementares</legend>{numericField("Benefícios", "benefitsCost", "0.01")}{numericField("Provisões", "provisionsCost", "0.01")}{numericField("Outros custos", "otherCosts", "0.01")}<p>Use provisões para férias, 13º e demais ajustes que sua operação acompanhar separadamente.</p></fieldset>
      <div className="payroll-live-totals" aria-live="polite"><span>Bruto<strong>{money(formGrossPayroll)}</strong></span><span>Descontos<strong>{money(formDeductions)}</strong></span><span>Líquido<strong>{money(formNetPay)}</strong></span><span>Encargos<strong>{money(formEmployerCharges)}</strong></span><span>Custo total<strong>{money(formTotal)}</strong></span></div>
      <label className="wide">Observações<textarea rows={3} maxLength={500} value={form.notes} disabled={busy} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Ex.: ajuste de competência, acordo coletivo ou variação relevante" /></label><button className="primary-button" disabled={busy || !form.companyId}><WalletCards aria-hidden="true" /> Salvar e atualizar painel</button>
    </form></section>}
  </div>;
}

export function DemandTableView({ cards, lists, areas, onOpen }: { cards: Card[]; lists: WorkspaceSnapshot["lists"]; areas: WorkspaceSnapshot["areas"]; onOpen: (card: Card) => void }) {
  const listNames = new Map(lists.map((list) => [list.id, list.name]));
  return (
    <section className="demand-table-view">
      <header><div><strong>Visão gerencial</strong><span>{contagem(cards.length, "demanda", "demandas")} nos filtros atuais</span></div><span>Selecione uma linha para abrir os detalhes.</span></header>
      <div className="demand-table-scroll">
        <table>
          <thead><tr><th>Demanda</th><th>Fluxo entre áreas</th><th>Processo</th><th>Status</th><th>Responsáveis</th><th>Prazo / SLA</th><th>Checklist</th></tr></thead>
          <tbody>{cards.map((card) => {
            const complete = card.checklist.filter((item) => item.completed).length;
            return <tr key={card.id} tabIndex={0} onClick={() => onOpen(card)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onOpen(card); }}><td><strong>{card.title}</strong><small>{card.company || "Sem empresa"}</small></td><td><DemandAreaFlow card={card} areas={areas} /></td><td><span className={`table-process ${processColors[card.processType] ?? "gray"}`}>{card.processType}</span></td><td>{listNames.get(card.listId) ?? "—"}</td><td>{card.assignees.map((item) => item.name).join(", ") || card.assigneeName || "Não atribuído"}</td><td><em className={card.slaStatus}>{slaLabel(card)}</em></td><td>{complete}/{card.checklist.length}</td></tr>;
          })}</tbody>
        </table>
        {cards.length === 0 && <div className="empty-view"><span>▤</span><strong>Nenhuma demanda encontrada</strong><p>Ajuste os filtros para ampliar a visão.</p></div>}
      </div>
    </section>
  );
}

export function InboxView({ items, busy, canEdit, onConvert, onNew }: { items: InboxItem[]; busy: boolean; canEdit: boolean; onConvert: (item: InboxItem) => Promise<void>; onNew: () => void }) {
  const pending = items.filter((item) => item.status === "new");
  const converted = items.filter((item) => item.status === "converted");
  const channelLabels: Record<string, string> = { whatsapp: "WhatsApp", email: "E-mail", teams: "Teams", manual: "Registro manual" };
  return (
    <div className="inbox-layout">
      <section className="inbox-list-panel">
        {/* O botão de criar fica só no cabeçalho da tela ("Nova solicitação"):
            o segundo, aqui dentro, fazia a mesma coisa com outro nome. */}
        <header><div><strong>Aguardando triagem</strong><span>{contagem(pending.length, "nova", "novas")} • {contagem(converted.length, "convertida", "convertidas")}</span></div></header>
        {pending.length === 0
          ? <div className="inbox-items"><div className="empty-view"><span><CheckCircle2 aria-hidden="true" /></span><strong>Nada aguardando triagem</strong><p>Solicitações recebidas por e-mail, Teams ou registro manual aparecem aqui.</p>{canEdit && <button className="secondary-button" onClick={onNew}><Plus aria-hidden="true" /> Registrar solicitação</button>}</div></div>
          : <div className="inbox-table-wrap"><table className="inbox-table">
            <thead><tr><th scope="col">Recebida</th><th scope="col">Canal</th><th scope="col">Remetente</th><th scope="col">Assunto</th>{canEdit && <th scope="col"><span className="sr-only">Ação</span></th>}</tr></thead>
            <tbody>{pending.map((item) => <tr key={item.id}>
              <td className="numeric">{formatReceived(item.receivedAt)}</td>
              <td>{channelLabels[item.channel] ?? item.channel}</td>
              <td>{item.senderName}</td>
              <td className="inbox-subject"><strong>{item.subject}</strong>{item.body && <span>{item.body}</span>}</td>
              {canEdit && <td><button className="secondary-button" disabled={busy} onClick={() => void onConvert(item)}>Transformar em demanda</button></td>}
            </tr>)}</tbody>
          </table></div>}
      </section>
    </div>
  );
}

export function PlannerView({ cards, blocks, connections, onOpen, onCreateBlock, onDeleteBlock, onSaveConnection }: { cards: Card[]; blocks: WorkspaceSnapshot["plannerBlocks"]; connections: WorkspaceSnapshot["calendarConnections"]; onOpen: (card: Card) => void; onCreateBlock: (payload: Record<string, unknown>) => Promise<WorkspaceSnapshot | null>; onDeleteBlock: (id: string) => Promise<WorkspaceSnapshot | null>; onSaveConnection: (payload: Record<string, unknown>) => Promise<WorkspaceSnapshot | null> }) {
  const scheduled = cards.filter((card) => card.dueAt && card.slaStatus !== "completed").sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  const grouped = scheduled.reduce<Record<string, Card[]>>((accumulator, card) => { const key = card.dueAt!.slice(0, 10); (accumulator[key] ??= []).push(card); return accumulator; }, {});
  const [showBlockForm, setShowBlockForm] = useState(false);
  const [blockTitle, setBlockTitle] = useState("");
  const [blockStart, setBlockStart] = useState("");
  const [blockEnd, setBlockEnd] = useState("");
  const [blockCardId, setBlockCardId] = useState("");
  const [blockError, setBlockError] = useState("");
  const [showConnectionForm, setShowConnectionForm] = useState(false);
  const [calendarProvider, setCalendarProvider] = useState("google");
  const [calendarId, setCalendarId] = useState("");
  async function createBlock(event: FormEvent) {
    event.preventDefault();
    const start = new Date(blockStart);
    const end = new Date(blockEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      setBlockError("O término precisa ser posterior ao início do bloco.");
      return;
    }
    setBlockError("");
    const next = await onCreateBlock({ title: blockTitle, startAt: start.toISOString(), endAt: end.toISOString(), cardId: blockCardId || null, blockType: "focus" });
    if (next) { setBlockTitle(""); setBlockStart(""); setBlockEnd(""); setBlockCardId(""); setShowBlockForm(false); }
  }
  async function saveConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = await onSaveConnection({ provider: calendarProvider, externalCalendarId: calendarId, config: { calendarLabel: calendarId || "Calendário principal" } });
    if (next) { setCalendarId(""); setShowConnectionForm(false); }
  }
  return (
    <div className="planner-layout">
      <section className="planner-calendar"><header><div><strong>Agenda por prazo</strong><span>{contagem(scheduled.length, "atividade programada", "atividades programadas")} • {contagem(blocks.length, "bloco", "blocos")} de foco</span></div><button className="secondary-button" onClick={() => { setShowBlockForm((value) => !value); setBlockError(""); }}><Plus aria-hidden="true" /> Bloco de tempo</button></header>{showBlockForm && <form className="planner-block-form" onSubmit={createBlock}><label>Título<input value={blockTitle} onChange={(event) => setBlockTitle(event.target.value)} placeholder="Ex.: Conferir admissões" required /></label><label>Início<input type="datetime-local" value={blockStart} onChange={(event) => setBlockStart(event.target.value)} required /></label><label>Fim<input type="datetime-local" value={blockEnd} onChange={(event) => setBlockEnd(event.target.value)} required /></label><label>Demanda<select value={blockCardId} onChange={(event) => setBlockCardId(event.target.value)}><option value="">Bloco geral</option>{cards.map((card) => <option key={card.id} value={card.id}>{card.title}</option>)}</select></label><button className="primary-button">Salvar bloco</button>{blockError && <p className="planner-form-error" role="alert">{blockError}</p>}</form>}{blocks.length > 0 && <div className="planner-block-list">{blocks.map((block) => <article key={block.id}><CalendarClock aria-hidden="true" /><div><strong>{block.title}</strong><small>{new Date(block.startAt).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} – {new Date(block.endAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</small></div><button onClick={() => void onDeleteBlock(block.id)} aria-label={`Excluir ${block.title}`}><Trash2 aria-hidden="true" /></button></article>)}</div>}{Object.keys(grouped).length === 0 && <div className="empty-view"><span><CalendarClock aria-hidden="true" /></span><strong>Nenhum prazo agendado</strong><p>Defina uma data nas demandas para montar o planner.</p></div>}{Object.entries(grouped).map(([date, dateCards]) => <div className="planner-day" key={date}><div><strong>{formatDate(date, true)}</strong><span>{contagem(dateCards.length, "demanda", "demandas")}</span></div><div>{dateCards.map((card) => <button key={card.id} onClick={() => onOpen(card)}><i className={processColors[card.processType] ?? "gray"} /><span><strong>{card.title}</strong><small>{card.assigneeName || "Sem responsável"} • {card.company || card.processType}</small></span><em className={card.slaStatus}><Clock3 aria-hidden="true" />{slaLabel(card)}</em></button>)}</div></div>)}</section>
      <aside className="planner-focus"><span>Foco do dia</span><h2>{scheduled.filter((card) => card.slaStatus === "warning" || card.slaStatus === "overdue").length}</h2><p>demanda(s) precisam de atenção imediata.</p><div><i /><span><strong>Priorize atrasos</strong><small>Comece pelos SLAs vencidos antes de assumir novas atividades.</small></span></div><section className="planner-connections"><header><strong>Calendários externos</strong><button onClick={() => setShowConnectionForm((value) => !value)}>{showConnectionForm ? "Cancelar" : "Configurar"}</button></header>{connections.length === 0 && <p>Conecte Google ou Microsoft Calendar para preparar a sincronização da agenda.</p>}{connections.map((connection) => <article key={connection.id}><CalendarDays aria-hidden="true" /><span><strong>{connection.provider === "microsoft" ? "Microsoft Calendar" : "Google Calendar"}</strong><small>{connection.externalCalendarId || "Calendário principal"} · {connection.status === "connected" ? "conectado" : "aguardando OAuth"}</small></span></article>)}{showConnectionForm && <form onSubmit={saveConnection}><select value={calendarProvider} onChange={(event) => setCalendarProvider(event.target.value)}><option value="google">Google Calendar</option><option value="microsoft">Microsoft Calendar</option></select><input value={calendarId} onChange={(event) => setCalendarId(event.target.value)} placeholder="ID ou nome do calendário (opcional)" /><button className="secondary-button">Salvar configuração</button></form>}</section></aside>
    </div>
  );
}
