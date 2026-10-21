"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, FileDown, Landmark, LoaderCircle, Settings } from "lucide-react";
import { ErrorBanner, LoadingState } from "../shared";
import { brl } from "@/lib/payroll-calc";
import {
  defaultAccounts, employerContributionLabels,
  type AccountingAccounts, type CompanyPayrollSettings, type EmployerContribution, type Guide,
} from "@/lib/payroll-obligations";
import styles from "./erp-record.module.css";

/**
 * Obrigações e pagamento da folha fechada (§4.40): guias com vencimento,
 * encargos do empregador e os arquivos — CNAB 240, rubricas no formato do
 * S-1200 e lançamentos contábeis. A transmissão continua com quem tem o
 * certificado digital.
 */

type Summary = {
  guides: Guide[]; notes: string[];
  charges: { base: number; cpp: number; rat: number; thirdParties: number; total: number };
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json" } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}
const br = (date: string) => { const [y, m, d] = date.split("-"); return `${d}/${m}/${y}`; };

export function ErpObligationsPanel({ runId, canManage }: { runId: string; canManage: boolean }) {
  const [data, setData] = useState<{ summary: Summary; missingBank: number; settings: CompanyPayrollSettings } | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setData(await requestJson(`/api/erp-dp/payroll-runs/${encodeURIComponent(runId)}/obligations`)); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao carregar as obrigações."); }
  }, [runId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  if (error) return <ErrorBanner title="Obrigações indisponíveis" message={error} />;
  if (!data) return <LoadingState size="compact" title="Calculando guias" />;
  const { summary } = data;
  const file = (kind: string) => `/api/erp-dp/payroll-runs/${encodeURIComponent(runId)}/exports?kind=${kind}`;

  return <section className={styles.requirementEditor} aria-labelledby="obligations-title">
    <header><div><span>FGTS DIGITAL · DCTFWEB · CNAB 240</span><h3 id="obligations-title">Obrigações e pagamento</h3></div></header>
    <div className={styles.tableWrap}><table className={styles.table}>
      <caption className="sr-only">Guias e pagamentos da folha</caption>
      <thead><tr><th>Guia</th><th>Onde</th><th className={styles.num}>Valor</th><th>Vencimento</th><th>Detalhe</th></tr></thead>
      <tbody>{summary.guides.map((guide) => <tr key={guide.code}>
        <td data-label="Guia"><strong>{guide.label}</strong></td>
        <td data-label="Onde">{guide.system}</td>
        <td data-label="Valor" className={styles.num}>{brl(guide.amountCents)}</td>
        <td data-label="Vencimento">{br(guide.dueDate)}</td>
        <td data-label="Detalhe">{guide.detail}</td>
      </tr>)}</tbody>
    </table></div>
    <div className={styles.historySnapshot} aria-label="Encargos do empregador">
      <article><small>Base patronal</small><strong>{brl(summary.charges.base)}</strong><span>{employerContributionLabels[data.settings.employerContribution]}</span></article>
      <article><small>CPP 20%</small><strong>{brl(summary.charges.cpp)}</strong><span>Cota patronal</span></article>
      <article><small>RAT × FAP</small><strong>{brl(summary.charges.rat)}</strong><span>{data.settings.ratPercent}% × {data.settings.fap}</span></article>
      <article><small>Terceiros</small><strong>{brl(summary.charges.thirdParties)}</strong><span>{data.settings.thirdPartiesPercent}%</span></article>
    </div>
    <ul className={styles.notes}>{summary.notes.map((note) => <li key={note}>{note}</li>)}</ul>
    {data.missingBank > 0 && <p className={styles.infoNote}><AlertTriangle aria-hidden="true" /><span>
      <strong>{data.missingBank} pessoa(s) sem conta de salário</strong>
      <small>Ficam fora do CNAB. Cadastre em Ficha funcional › Remuneração › Conta de salário.</small></span></p>}
    {canManage && <div className={styles.chips}>
      <a className={styles.primaryButton} href={file("cnab")} download><Landmark aria-hidden="true" /> Pagamento CNAB 240</a>
      <a className={styles.secondaryButton} href={file("s1200")} download><FileDown aria-hidden="true" /> Rubricas S-1200 (CSV)</a>
      <a className={styles.secondaryButton} href={file("accounting")} download><FileDown aria-hidden="true" /> Lançamentos contábeis (CSV)</a>
    </div>}
  </section>;
}

const accountLabels: Record<keyof AccountingAccounts, string> = {
  salaryExpense: "Despesa com salários", inssExpense: "Despesa com INSS patronal", fgtsExpense: "Despesa com FGTS",
  salariesPayable: "Salários a pagar", inssPayable: "INSS a recolher", irrfPayable: "IRRF a recolher", fgtsPayable: "FGTS a recolher",
  otherDeductions: "Descontos a repassar",
};

/** Configuração de folha da empresa: encargos, banco do CNAB e plano de contas. */
export function ErpPayrollSettingsForm({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<CompanyPayrollSettings | null>(null);
  const [bank, setBank] = useState({ code: "", agency: "", agencyDigit: "", account: "", accountDigit: "", agreement: "" });
  const [floor, setFloor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void requestJson<{ settings: CompanyPayrollSettings }>(`/api/erp-dp/payroll-settings?companyId=${encodeURIComponent(companyId)}`)
      .then((payload) => {
        if (!active) return;
        setSettings(payload.settings);
        if (payload.settings.bank) setBank(payload.settings.bank);
        if (payload.settings.salaryFloorCents) setFloor((payload.settings.salaryFloorCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }));
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Erro ao carregar."); });
    return () => { active = false; };
  }, [open, companyId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setBusy(true); setSaved(false);
    try {
      await requestJson("/api/erp-dp/payroll-settings", { method: "PUT", body: JSON.stringify({ companyId, ...settings, salaryFloorCents: undefined, salaryFloor: floor, bank }) });
      setSaved(true); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar."); }
    finally { setBusy(false); }
  }

  if (!open) return <div><button type="button" className={styles.secondaryButton} onClick={() => setOpen(true)}><Settings aria-hidden="true" /> Configuração da folha da empresa</button></div>;
  return <form className={styles.requirementEditor} onSubmit={(event) => void submit(event)}>
    <header><div><span>ENCARGOS · BANCO · CONTAS</span><h3>Configuração da folha da empresa</h3></div></header>
    {error && <ErrorBanner title="Não salvo" message={error} />}
    {saved && <p className={styles.infoNote}><Check aria-hidden="true" /><span><strong>Configuração salva</strong></span></p>}
    {!settings ? <LoadingState size="compact" title="Carregando" /> : <div className={styles.formGrid}>
      <label className={styles.spanTwo}><span>Contribuição patronal</span>
        <select value={settings.employerContribution} onChange={(event) => setSettings({ ...settings, employerContribution: event.target.value as EmployerContribution })}>
          {(Object.keys(employerContributionLabels) as EmployerContribution[]).map((key) => <option key={key} value={key}>{employerContributionLabels[key]}</option>)}
        </select></label>
      <label><span>RAT (%)</span>
        <select value={settings.ratPercent} onChange={(event) => setSettings({ ...settings, ratPercent: Number(event.target.value) })}>
          <option value={1}>1% (risco leve)</option><option value={2}>2% (risco médio)</option><option value={3}>3% (risco grave)</option>
        </select></label>
      <label><span>FAP (0,5 a 2)</span><input inputMode="decimal" value={String(settings.fap).replace(".", ",")}
        onChange={(event) => setSettings({ ...settings, fap: Number(event.target.value.replace(",", ".")) || 0 })} /></label>
      <label><span>Terceiros (%)</span><input inputMode="decimal" value={String(settings.thirdPartiesPercent).replace(".", ",")}
        onChange={(event) => setSettings({ ...settings, thirdPartiesPercent: Number(event.target.value.replace(",", ".")) || 0 })} /></label>
      <label><span>Piso salarial da convenção (R$)</span><input inputMode="decimal" placeholder="0,00"
        value={floor} onChange={(event) => setFloor(event.target.value)} /></label>
      <label><span>Banco pagador (código)</span><input inputMode="numeric" maxLength={3} value={bank.code} onChange={(event) => setBank({ ...bank, code: event.target.value })} /></label>
      <label><span>Agência</span><input inputMode="numeric" maxLength={5} value={bank.agency} onChange={(event) => setBank({ ...bank, agency: event.target.value })} /></label>
      <label><span>Dígito da agência</span><input maxLength={1} value={bank.agencyDigit} onChange={(event) => setBank({ ...bank, agencyDigit: event.target.value })} /></label>
      <label><span>Conta</span><input inputMode="numeric" maxLength={12} value={bank.account} onChange={(event) => setBank({ ...bank, account: event.target.value })} /></label>
      <label><span>Dígito da conta</span><input maxLength={1} value={bank.accountDigit} onChange={(event) => setBank({ ...bank, accountDigit: event.target.value })} /></label>
      <label><span>Convênio CNAB</span><input maxLength={20} value={bank.agreement} onChange={(event) => setBank({ ...bank, agreement: event.target.value })} /></label>
      {(Object.keys(defaultAccounts) as Array<keyof AccountingAccounts>).map((key) => <label key={key}><span>Conta: {accountLabels[key]}</span>
        <input value={settings.accounts[key]} onChange={(event) => setSettings({ ...settings, accounts: { ...settings.accounts, [key]: event.target.value } })} /></label>)}
    </div>}
    <footer><button type="button" className={styles.secondaryButton} onClick={() => setOpen(false)}>Fechar</button><span />
      <button className={styles.primaryButton} disabled={busy || !settings}>{busy ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : <Check aria-hidden="true" />} Salvar configuração</button></footer>
  </form>;
}

/** Conta de salário do colaborador (infotipo 0009). */
export function ErpBankAccountForm({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const [account, setAccount] = useState({ bankCode: "", agency: "", agencyDigit: "", account: "", accountDigit: "", accountType: "checking", pixKey: "" });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    void requestJson<{ account: typeof account | null }>(`/api/employees/${encodeURIComponent(employeeId)}/bank-account`)
      .then((payload) => { if (!active) return; if (payload.account) setAccount(payload.account); setLoaded(true); })
      .catch((cause) => { if (active) { setError(cause instanceof Error ? cause.message : "Erro ao carregar."); setLoaded(true); } });
    return () => { active = false; };
  }, [employeeId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setSaved(false);
    try {
      await requestJson(`/api/employees/${encodeURIComponent(employeeId)}/bank-account`, { method: "PUT", body: JSON.stringify(account) });
      setSaved(true); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar."); }
    finally { setBusy(false); }
  }

  const field = (key: keyof typeof account, label: string, props: Record<string, unknown> = {}) => <label><span>{label}</span>
    <input value={account[key]} disabled={!canManage} onChange={(event) => setAccount({ ...account, [key]: event.target.value })} {...props} /></label>;

  return <form className={styles.requirementEditor} onSubmit={(event) => void submit(event)}>
    <header><div><span>INFOTIPO 0009</span><h3>Conta de salário</h3></div></header>
    {error && <ErrorBanner title="Atenção" message={error} />}
    {saved && <p className={styles.infoNote}><Check aria-hidden="true" /><span><strong>Conta salva</strong><small>Entra no próximo arquivo CNAB.</small></span></p>}
    {!loaded ? <LoadingState size="compact" title="Carregando" /> : <div className={styles.formGrid}>
      {field("bankCode", "Banco (código) *", { inputMode: "numeric", maxLength: 3, required: true })}
      {field("agency", "Agência *", { inputMode: "numeric", maxLength: 5, required: true })}
      {field("agencyDigit", "Dígito da agência", { maxLength: 1 })}
      {field("account", "Conta *", { inputMode: "numeric", maxLength: 12, required: true })}
      {field("accountDigit", "Dígito da conta", { maxLength: 1 })}
      <label><span>Tipo</span><select value={account.accountType} disabled={!canManage} onChange={(event) => setAccount({ ...account, accountType: event.target.value })}>
        <option value="checking">Conta corrente</option><option value="savings">Poupança</option><option value="salary">Conta salário</option></select></label>
      {field("pixKey", "Chave Pix (opcional)", { maxLength: 77 })}
    </div>}
    {canManage && <footer><span /><button className={styles.primaryButton} disabled={busy || !loaded}>
      {busy ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : <Check aria-hidden="true" />} Salvar conta</button></footer>}
  </form>;
}
