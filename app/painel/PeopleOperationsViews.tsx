"use client";

import { FormEvent, useMemo, useState } from "react";
import { BadgeDollarSign, Building2, CircleAlert, FileSpreadsheet, HeartHandshake, Plus, Search, UserRound, Users, WalletCards } from "lucide-react";
import type { WorkspaceSnapshot } from "@/lib/fila-dp-types";
import { calculatePjClosing, calculatePjContractAmount } from "@/lib/fila-dp-money";

type SnapshotMutation = (url: string, options: RequestInit, message?: string) => Promise<WorkspaceSnapshot | null>;

function money(value: number) {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function currentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function companyLabel(snapshot: WorkspaceSnapshot, companyId: string) {
  const company = snapshot.companies.find((item) => item.id === companyId);
  return company?.tradeName || company?.legalName || "Empresa removida";
}

function employmentLabel(snapshot: WorkspaceSnapshot, employmentId: string) {
  const employment = snapshot.employments.find((item) => item.id === employmentId);
  return employment?.preferredName || employment?.fullName || "Vínculo removido";
}

export function EmployeesView({ snapshot, busy, canEdit, isAdmin, onMutate }: { snapshot: WorkspaceSnapshot; busy: boolean; canEdit: boolean; isAdmin: boolean; onMutate: SnapshotMutation }) {
  const [query, setQuery] = useState("");
  const [regime, setRegime] = useState("all");
  const [showForm, setShowForm] = useState(false);
  const visible = useMemo(() => snapshot.employments.filter((employment) => {
    const matchesRegime = regime === "all" || employment.regime === regime;
    const term = query.trim().toLowerCase();
    const matchesQuery = !term || [employment.fullName, employment.preferredName, employment.email, employment.employeeCode, employment.jobTitle, employment.department, companyLabel(snapshot, employment.companyId)].some((value) => value.toLowerCase().includes(term));
    return matchesRegime && matchesQuery;
  }), [query, regime, snapshot]);
  const active = snapshot.employments.filter((item) => item.status === "active");
  const imported = snapshot.employments.filter((item) => item.source === "opyt_employee_workbook");

  async function importWorkbook(file: File) {
    const form = new FormData();
    form.append("file", file);
    form.append("createCompanies", "true");
    await onMutate("/api/employees/import", { method: "POST", body: form });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await onMutate("/api/employees", { method: "POST", body: JSON.stringify(Object.fromEntries(form.entries())) }, "Funcionário e vínculo cadastrados.");
    if (result) { event.currentTarget.reset(); setShowForm(false); }
  }

  return <div className="people-module">
    <section className="people-kpis">
      <article><i><Users aria-hidden="true" /></i><span>Vínculos ativos</span><strong>{active.length}</strong><small>Todos os regimes</small></article>
      <article><i><UserRound aria-hidden="true" /></i><span>Funcionários CLT</span><strong>{active.filter((item) => item.regime === "clt").length}</strong><small>Vínculos trabalhistas ativos</small></article>
      <article><i><BadgeDollarSign aria-hidden="true" /></i><span>Prestadores PJ</span><strong>{active.filter((item) => item.regime === "pj").length}</strong><small>Fechamento por competência</small></article>
      <article><i><CircleAlert aria-hidden="true" /></i><span>Afastados</span><strong>{snapshot.employments.filter((item) => item.status === "on_leave").length}</strong><small>Acompanhamento cadastral</small></article>
    </section>

    <section className="people-toolbar"><div><span>CENTRAL DE FUNCIONÁRIOS</span><h2>Pessoas e vínculos</h2><p>Uma pessoa pode ter vínculos CLT, PJ ou históricos em empresas diferentes do grupo.</p></div>{canEdit && <button className="primary-button" onClick={() => setShowForm((current) => !current)}><Plus aria-hidden="true" /> {showForm ? "Fechar" : "Cadastrar funcionário"}</button>}</section>

    <section className="employee-source-card">
      <i><FileSpreadsheet aria-hidden="true" /></i>
      <div><span>FONTE CADASTRAL</span><strong>Funcionários GRUPO OPYT.xlsx</strong><p>A aba “GRUPO OPYT” alimenta pessoas, vínculos CLT/PJ, empresas, cargos, salários, VA e VT. O arquivo não é armazenado no sistema.</p></div>
      <aside><strong>{imported.length}</strong><span>vínculo(s) sincronizado(s)</span><small>{snapshot.importSummary ? `Última execução: ${snapshot.importSummary.created} criado(s) e ${snapshot.importSummary.updated} atualizado(s).` : "Envie a versão atualizada para sincronizar novamente."}</small></aside>
      {isAdmin && <label className={`secondary-button employee-source-upload ${busy ? "disabled" : ""}`}><FileSpreadsheet aria-hidden="true" /> {busy ? "Sincronizando…" : "Sincronizar planilha"}<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void importWorkbook(file); event.target.value = ""; }} /></label>}
    </section>

    {showForm && canEdit && <section className="people-form-panel"><header><div><span>NOVO CADASTRO</span><h2>Identidade e vínculo profissional</h2></div></header><form onSubmit={submit}>
      <label>Nome completo<input name="fullName" required maxLength={180} /></label>
      <label>Nome preferido<input name="preferredName" maxLength={120} /></label>
      <label>E-mail<input name="email" type="email" maxLength={180} /></label>
      <label>Telefone<input name="phone" maxLength={40} /></label>
      <label>Empresa<select name="companyId" required defaultValue=""><option value="" disabled>Selecione</option>{snapshot.companies.filter((company) => company.status === "active").map((company) => <option key={company.id} value={company.id}>{company.tradeName || company.legalName}</option>)}</select></label>
      <label>Regime<select name="regime" defaultValue="clt"><option value="clt">CLT</option><option value="pj">PJ</option><option value="intern">Estágio</option><option value="temporary">Temporário</option></select></label>
      <label>Matrícula / código<input name="employeeCode" maxLength={80} /></label>
      <label>Cargo<input name="jobTitle" maxLength={140} /></label>
      <label>Departamento<input name="department" maxLength={140} /></label>
      <label>Centro de custo<input name="costCenter" maxLength={100} /></label>
      <label>Gestor<input name="managerName" maxLength={140} /></label>
      <label>Data de início<input name="startDate" type="date" /></label>
      <label>Valor mensal contratual<input name="monthlyValue" type="number" min="0" step="0.01" defaultValue="0" /></label>
      <label>Status<select name="status" defaultValue="active"><option value="active">Ativo</option><option value="on_leave">Afastado</option><option value="inactive">Inativo</option></select></label>
      <button className="primary-button" type="submit" disabled={busy}>Salvar funcionário</button>
    </form></section>}

    <section className="people-directory">
      <header><div><strong>Diretório</strong><span>{visible.length} vínculo(s) encontrado(s)</span></div><div className="people-filters"><label><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nome, matrícula, cargo ou empresa" /></label><select value={regime} onChange={(event) => setRegime(event.target.value)}><option value="all">Todos os regimes</option><option value="clt">CLT</option><option value="pj">PJ</option><option value="intern">Estágio</option><option value="temporary">Temporário</option></select></div></header>
      {visible.length === 0 && <div className="people-empty"><UserRound aria-hidden="true" /><strong>Nenhum vínculo encontrado</strong><p>Cadastre o primeiro funcionário ou ajuste os filtros.</p></div>}
      <div className="people-table">{visible.map((employment) => <article key={employment.id}><i>{(employment.preferredName || employment.fullName).split(" ").slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</i><div><strong>{employment.preferredName || employment.fullName}</strong><small>{employment.fullName}{employment.employeeCode ? ` • ${employment.employeeCode}` : ""}</small></div><span><small>Empresa</small><b>{companyLabel(snapshot, employment.companyId)}</b></span><span><small>Cargo / área</small><b>{employment.jobTitle || "Não informado"}</b><em>{employment.department || "Sem departamento"}</em></span><b className={`employment-regime ${employment.regime}`}>{employment.regime === "clt" ? "CLT" : employment.regime === "pj" ? "PJ" : employment.regime === "intern" ? "Estágio" : "Temporário"}</b><b className={`employment-status ${employment.status}`}>{employment.status === "active" ? "Ativo" : employment.status === "on_leave" ? "Afastado" : "Inativo"}</b></article>)}</div>
    </section>
  </div>;
}

export function BenefitsView({ snapshot, busy, canEdit, isAdmin, onMutate }: { snapshot: WorkspaceSnapshot; busy: boolean; canEdit: boolean; isAdmin: boolean; onMutate: SnapshotMutation }) {
  const [showPolicyForm, setShowPolicyForm] = useState(false);
  const [showMovementForm, setShowMovementForm] = useState(false);
  const [period, setPeriod] = useState(currentPeriod());
  const movements = snapshot.benefitMovements.filter((item) => item.period === period && item.status !== "cancelled");
  const gross = movements.reduce((total, item) => total + item.amount, 0);
  const discounts = movements.reduce((total, item) => total + item.employeeDiscount, 0);

  async function submitPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await onMutate("/api/benefits/policies", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) }, "Política de benefício criada.");
    if (result) { event.currentTarget.reset(); setShowPolicyForm(false); }
  }

  async function submitMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await onMutate("/api/benefits/movements", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) }, "Benefício lançado na competência.");
    if (result) { event.currentTarget.reset(); setShowMovementForm(false); }
  }

  return <div className="people-module">
    <section className="people-kpis benefit-kpis"><article><i><HeartHandshake aria-hidden="true" /></i><span>Políticas ativas</span><strong>{snapshot.benefitPolicies.filter((item) => item.active).length}</strong><small>Regras configuradas</small></article><article><i><Users aria-hidden="true" /></i><span>Beneficiários</span><strong>{new Set(movements.map((item) => item.employmentId)).size}</strong><small>Na competência {period}</small></article><article><i><WalletCards aria-hidden="true" /></i><span>Custo líquido</span><strong>{money(Math.max(0, gross - discounts))}</strong><small>Valor menos coparticipações</small></article><article><i><BadgeDollarSign aria-hidden="true" /></i><span>Desconto colaborador</span><strong>{money(discounts)}</strong><small>Sem dupla contagem no custo</small></article></section>
    <section className="people-toolbar"><div><span>BENEFÍCIOS</span><h2>Políticas e lançamentos</h2><p>Controle elegibilidade, valor, canal e movimentação individual por competência.</p></div><div>{isAdmin && <button className="secondary-button" onClick={() => setShowPolicyForm((current) => !current)}><Plus aria-hidden="true" /> Nova política</button>}{canEdit && <button className="primary-button" onClick={() => setShowMovementForm((current) => !current)}><Plus aria-hidden="true" /> Lançar benefício</button>}</div></section>
    {showPolicyForm && isAdmin && <section className="people-form-panel"><header><div><span>POLÍTICA</span><h2>Configurar benefício</h2></div></header><form onSubmit={submitPolicy}><label>Empresa<select name="companyId" required defaultValue=""><option value="" disabled>Selecione</option>{snapshot.companies.map((company) => <option key={company.id} value={company.id}>{company.tradeName || company.legalName}</option>)}</select></label><label>Nome<input name="name" required placeholder="Ex.: Vale-alimentação" /></label><label>Tipo<select name="benefitType" defaultValue="meal"><option value="meal">VA / VR</option><option value="transport">Vale-transporte</option><option value="health">Plano de saúde</option><option value="pharmacy">Farmácia / convênio</option><option value="psychology">Psicologia</option><option value="advance">Adiantamento</option><option value="other">Outro</option></select></label><label>Regime elegível<select name="eligibleRegime" defaultValue="all"><option value="all">Todos</option><option value="clt">CLT</option><option value="pj">PJ</option><option value="intern">Estágio</option><option value="temporary">Temporário</option></select></label><label>Valor mensal<input name="monthlyValue" type="number" min="0" step="0.01" defaultValue="0" /></label><label>Desconto do colaborador<input name="employeeDiscount" type="number" min="0" step="0.01" defaultValue="0" /></label><label>Canal<select name="channel" defaultValue="payroll"><option value="payroll">Folha / ERP</option><option value="caju">Caju</option><option value="direct">Pagamento direto</option><option value="reimbursement">Reembolso</option></select></label><label>Início da vigência<input name="effectiveFrom" type="date" /></label><button className="primary-button" type="submit" disabled={busy}>Salvar política</button></form></section>}
    {showMovementForm && canEdit && <section className="people-form-panel"><header><div><span>COMPETÊNCIA</span><h2>Lançar benefício individual</h2></div></header><form onSubmit={submitMovement}><label>Funcionário / vínculo<select name="employmentId" required defaultValue=""><option value="" disabled>Selecione</option>{snapshot.employments.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.preferredName || item.fullName} • {item.regime.toUpperCase()}</option>)}</select></label><label>Política<select name="policyId" required defaultValue=""><option value="" disabled>Selecione</option>{snapshot.benefitPolicies.filter((item) => item.active).map((item) => <option key={item.id} value={item.id}>{item.name} • {companyLabel(snapshot, item.companyId)}</option>)}</select></label><label>Competência<input name="period" type="month" required defaultValue={period} /></label><label>Valor<input name="amount" type="number" min="0" step="0.01" placeholder="Usa a política se vazio" /></label><label>Coparticipação / desconto<input name="employeeDiscount" type="number" min="0" step="0.01" placeholder="Usa a política se vazio" /></label><label>Status<select name="status" defaultValue="calculated"><option value="calculated">Calculado</option><option value="approved">Aprovado</option><option value="exported">Exportado</option></select></label><label className="wide">Observação<input name="notes" maxLength={500} /></label><button className="primary-button" type="submit" disabled={busy}>Salvar lançamento</button></form></section>}
    <section className="people-directory benefits-directory"><header><div><strong>Movimentações da competência</strong><span>{movements.length} lançamento(s)</span></div><label className="period-filter">Competência<input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} /></label></header>{movements.length === 0 && <div className="people-empty"><HeartHandshake aria-hidden="true" /><strong>Sem benefícios lançados</strong><p>Crie uma política e registre os valores da competência.</p></div>}<div className="people-table">{movements.map((movement) => { const policy = snapshot.benefitPolicies.find((item) => item.id === movement.policyId); return <article key={movement.id}><i><HeartHandshake aria-hidden="true" /></i><div><strong>{employmentLabel(snapshot, movement.employmentId)}</strong><small>{policy?.name || "Política removida"}</small></div><span><small>Empresa</small><b>{companyLabel(snapshot, movement.companyId)}</b></span><span><small>Valor / desconto</small><b>{money(movement.amount)}</b><em>- {money(movement.employeeDiscount)}</em></span><b className="employment-regime clt">{policy?.benefitType || "benefício"}</b><b className={`employment-status ${movement.status === "cancelled" ? "inactive" : "active"}`}>{movement.status}</b></article>; })}</div></section>
  </div>;
}

export function PjClosingsView({ snapshot, busy, canEdit, onMutate }: { snapshot: WorkspaceSnapshot; busy: boolean; canEdit: boolean; onMutate: SnapshotMutation }) {
  const [showForm, setShowForm] = useState(false);
  const [period, setPeriod] = useState(currentPeriod());
  const [selectedEmploymentId, setSelectedEmploymentId] = useState("");
  const [closingPeriod, setClosingPeriod] = useState(period);
  const [preview, setPreview] = useState(() => calculatePjClosing({ contractAmount: 0, variableAmount: 0, reimbursementAmount: 0, deductionsAmount: 0, invoiceLimit: 0 }));
  const pjEmployments = snapshot.employments.filter((item) => item.regime === "pj" && item.status === "active");
  const closings = snapshot.pjClosings.filter((item) => item.period === period);
  const pending = closings.filter((item) => !["paid"].includes(item.status)).length;
  const selectedEmployment = pjEmployments.find((item) => item.id === selectedEmploymentId);
  const suggestedContractAmount = calculatePjContractAmount(selectedEmployment?.monthlyValue ?? 0, selectedEmployment?.startDate, closingPeriod);

  function updatePreview(form: HTMLFormElement, selection?: { employmentId?: string; period?: string }) {
    const values = Object.fromEntries(new FormData(form).entries());
    const employment = pjEmployments.find((item) => item.id === (selection?.employmentId ?? values.employmentId));
    const calculatedContractAmount = calculatePjContractAmount(employment?.monthlyValue ?? 0, employment?.startDate, selection?.period ?? values.period);
    setPreview(calculatePjClosing({ contractAmount: calculatedContractAmount, variableAmount: values.variableAmount, reimbursementAmount: values.reimbursementAmount, deductionsAmount: values.deductionsAmount, invoiceLimit: values.invoiceLimit, invoiceAmount: values.invoiceAmount }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await onMutate("/api/pj-closings", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget).entries())) }, "Fechamento PJ calculado e salvo.");
    if (result) { event.currentTarget.reset(); setSelectedEmploymentId(""); setClosingPeriod(period); setShowForm(false); }
  }

  return <div className="people-module">
    <section className="people-kpis pj-kpis"><article><i><BadgeDollarSign aria-hidden="true" /></i><span>PJs ativos</span><strong>{pjEmployments.length}</strong><small>Prestadores cadastrados</small></article><article><i><CircleAlert aria-hidden="true" /></i><span>Pendentes</span><strong>{pending}</strong><small>Na competência {period}</small></article><article><i><WalletCards aria-hidden="true" /></i><span>Líquido calculado</span><strong>{money(closings.reduce((total, item) => total + item.netAmount, 0))}</strong><small>Créditos menos descontos</small></article><article><i><HeartHandshake aria-hidden="true" /></i><span>Excedente Caju</span><strong>{money(closings.reduce((total, item) => total + item.cajuExcess, 0))}</strong><small>Fora do limite da nota</small></article></section>
    <section className="people-toolbar"><div><span>FECHAMENTO PJ</span><h2>Competência dos prestadores</h2><p>Calcule contrato, variáveis, descontos, nota e excedente sem misturar canal e natureza.</p></div>{canEdit && <button className="primary-button" disabled={!pjEmployments.length} onClick={() => setShowForm((current) => !current)}><Plus aria-hidden="true" /> Novo fechamento</button>}</section>
    {showForm && canEdit && <section className="people-form-panel pj-closing-form"><header><div><span>NOVA COMPETÊNCIA</span><h2>Calcular fechamento PJ</h2></div><aside><span>Líquido previsto</span><strong>{money(preview.netAmount)}</strong><small>Nota esperada {money(preview.expectedInvoiceAmount)} • Caju {money(preview.cajuExcess)}</small></aside></header><form onSubmit={submit} onInput={(event) => updatePreview(event.currentTarget)}><label>Prestador PJ<select name="employmentId" required value={selectedEmploymentId} onChange={(event) => { setSelectedEmploymentId(event.target.value); if (event.currentTarget.form) updatePreview(event.currentTarget.form, { employmentId: event.target.value, period: closingPeriod }); }}><option value="" disabled>Selecione</option>{pjEmployments.map((item) => <option key={item.id} value={item.id}>{item.preferredName || item.fullName} • {companyLabel(snapshot, item.companyId)}</option>)}</select></label><label>Competência<input name="period" type="month" required value={closingPeriod} onChange={(event) => { setClosingPeriod(event.target.value); if (event.currentTarget.form) updatePreview(event.currentTarget.form, { employmentId: selectedEmploymentId, period: event.target.value }); }} /></label><label>Contrato <small>{selectedEmployment?.startDate ? "Calculado pela data de início" : "30 dias (sem data de início)"}</small><input name="contractAmount" type="number" step="0.01" value={String(suggestedContractAmount)} readOnly aria-readonly="true" /></label><label>Comissão / variável<input name="variableAmount" type="number" min="0" step="0.01" defaultValue="0" /></label><label>Reembolso<input name="reimbursementAmount" type="number" min="0" step="0.01" defaultValue="0" /></label><label>Descontos autorizados<input name="deductionsAmount" type="number" min="0" step="0.01" defaultValue="0" /></label><label>Limite da nota<input name="invoiceLimit" type="number" min="0" step="0.01" defaultValue="0" /></label><label>Valor da nota recebida<input name="invoiceAmount" type="number" min="0" step="0.01" defaultValue="0" /></label><label>Status<select name="status" defaultValue="review"><option value="draft">Rascunho</option><option value="review">Em conferência</option><option value="approved">Aprovado</option><option value="paid">Pago</option></select></label><label className="wide">Observação<input name="notes" maxLength={500} /></label><button className="primary-button" type="submit" disabled={busy}>Calcular e salvar</button></form></section>}
    <section className="people-directory pj-directory"><header><div><strong>Fechamentos</strong><span>{closings.length} registro(s)</span></div><label className="period-filter">Competência<input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} /></label></header>{closings.length === 0 && <div className="people-empty"><Building2 aria-hidden="true" /><strong>Sem fechamento nesta competência</strong><p>Cadastre um vínculo PJ e gere o primeiro cálculo.</p></div>}<div className="people-table">{closings.map((closing) => <article key={closing.id}><i><BadgeDollarSign aria-hidden="true" /></i><div><strong>{employmentLabel(snapshot, closing.employmentId)}</strong><small>{companyLabel(snapshot, closing.companyId)} • {closing.period}</small></div><span><small>Líquido</small><b>{money(closing.netAmount)}</b></span><span><small>Nota / Caju</small><b>{money(closing.invoiceAmount)}</b><em>{money(closing.cajuExcess)} excedente</em></span><b className="employment-regime pj">PJ</b><b className={`employment-status ${closing.status === "blocked" ? "inactive" : closing.status === "paid" ? "active" : "on_leave"}`}>{closing.status === "blocked" ? "Divergente" : closing.status === "paid" ? "Pago" : closing.status === "approved" ? "Aprovado" : "Pendente"}</b></article>)}</div></section>
  </div>;
}
