"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ErrorBanner, LoadingState } from "../shared";
import { dpRequest, errorText, weekdayShort } from "./dp.api";
import styles from "./dp.module.css";

type Template = {
  id: string; code: string; name: string; frequency: "monthly" | "weekly"; dayStart: number; dayEnd: number; weekday: number | null;
  scope: "company" | "cnpj_root" | "tenant"; companyIds: string[] | null; processType: string; listWeekMovements: boolean; active: boolean;
};
type Rule = { code: string; name: string; processTypes: string[]; kind: string; kindLabel: string; value: number; monthDayLimit: number | null; description: string; status: string };
type Member = { id: string; name: string };

const scopeLabels: Record<Template["scope"], string> = { company: "Por empresa", cnpj_root: "Por raiz de CNPJ", tenant: "Uma para o grupo" };
const emptyForm = { code: "", name: "", frequency: "monthly", dayStart: "1", dayEnd: "15", weekday: "5", scope: "company", processType: "ROTINA DP" };

/** Rotinas recorrentes, regras de corte e o responsável pelas rotinas do grupo. */
export function SettingsTab({ canManage }: { canManage: boolean }) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [settings, setSettings] = useState<{ tenantTaskOwnerUserId: string | null; reportRecipients: string }>({ tenantTaskOwnerUserId: null, reportRecipients: "" });
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [templateData, ruleData, portfolio, settingsData] = await Promise.all([
        dpRequest<{ templates: Template[] }>("/api/dp/templates"),
        dpRequest<{ rules: Rule[] }>("/api/dp/cutoff-rules"),
        dpRequest<{ members: Member[] }>("/api/portfolio"),
        dpRequest<{ tenantTaskOwnerUserId: string | null; reportRecipients: string }>("/api/dp/settings"),
      ]);
      setTemplates(templateData.templates); setRules(ruleData.rules); setMembers(portfolio.members); setSettings(settingsData);
      setError("");
    } catch (cause) { setError(errorText(cause, "Não foi possível carregar a configuração.")); }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(); });
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    try { await action(); setNotice(done); await load(); }
    catch (cause) { setError(errorText(cause, "Não foi possível salvar.")); }
    finally { setBusy(false); }
  }

  function create(event: FormEvent) {
    event.preventDefault();
    void run(() => dpRequest("/api/dp/templates", { method: "POST", body: JSON.stringify({
      ...form, dayStart: Number(form.dayStart), dayEnd: Number(form.dayEnd), weekday: Number(form.weekday),
    }) }).then(() => setForm(emptyForm)), "Rotina criada.");
  }

  if (!templates) return error ? <ErrorBanner message={error} onDismiss={() => setError("")} /> : <LoadingState title="Carregando a configuração" size="compact" />;
  return <div className={styles.root}>
    {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}
    {notice && <p className={styles.notice} role="status">{notice}</p>}

    <section className={styles.card}>
      <header className={styles.cardHeader}><div><h3>Rotinas recorrentes</h3><p>Geradas pelo job diário: a competência seguinte a partir do dia 25 e a semana toda segunda. Prazo em dia não útil antecipa.</p></div></header>
      <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>Rotina</th><th>Janela</th><th>Escopo</th><th>Empresas</th><th>Tipo</th><th>Ativa</th></tr></thead>
        <tbody>{templates.map((template) => <tr key={template.id}>
          <td>{template.name}{template.listWeekMovements ? " · lista admissões e desligamentos da semana" : ""}</td>
          <td>{template.frequency === "weekly" ? `Toda ${weekdayShort[template.weekday ?? 5]}` : `Dia ${template.dayStart} a ${template.dayEnd === 31 ? "último" : template.dayEnd}`}</td>
          <td>{scopeLabels[template.scope]}</td>
          <td>{template.companyIds ? `${template.companyIds.length} selecionada(s)` : "Todas internas"}</td>
          <td>{template.processType}</td>
          <td>{canManage
            ? <input type="checkbox" className={styles.checkbox} aria-label={`Rotina ${template.name} ativa`} checked={template.active} disabled={busy}
              onChange={(event) => void run(() => dpRequest(`/api/dp/templates/${encodeURIComponent(template.id)}`, { method: "PATCH", body: JSON.stringify({ active: event.target.checked }) }),
                event.target.checked ? "Rotina ativada." : "Rotina desativada.")} />
            : template.active ? "Sim" : "Não"}</td>
        </tr>)}</tbody>
      </table></div>
      {canManage && <form className={styles.form} onSubmit={create}>
        <label>Código<input required value={form.code} maxLength={40} placeholder="minha-rotina" onChange={(event) => setForm({ ...form, code: event.target.value.toLowerCase() })} /></label>
        <label className={styles.grow}>Nome<input required value={form.name} maxLength={160} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label>Frequência<select value={form.frequency} onChange={(event) => setForm({ ...form, frequency: event.target.value })}><option value="monthly">Mensal</option><option value="weekly">Semanal</option></select></label>
        {form.frequency === "monthly"
          ? <><label>Do dia<input type="number" min={1} max={31} value={form.dayStart} onChange={(event) => setForm({ ...form, dayStart: event.target.value })} /></label>
            <label>Ao dia<input type="number" min={1} max={31} value={form.dayEnd} onChange={(event) => setForm({ ...form, dayEnd: event.target.value })} /></label></>
          : <label>Dia da semana<select value={form.weekday} onChange={(event) => setForm({ ...form, weekday: event.target.value })}>{weekdayShort.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}
        <label>Escopo<select value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value })}>{Object.entries(scopeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Tipo<input value={form.processType} maxLength={40} onChange={(event) => setForm({ ...form, processType: event.target.value.toUpperCase() })} /></label>
        <button type="submit" className={styles.primaryButton} disabled={busy}>Criar rotina</button>
      </form>}
      {canManage && <div className={styles.form}>
        <label className={styles.grow}>Responsável pelas rotinas de escopo “uma para o grupo”<select value={settings.tenantTaskOwnerUserId ?? ""} disabled={busy}
          onChange={(event) => void run(() => dpRequest("/api/dp/settings", { method: "PATCH", body: JSON.stringify({ ...settings, tenantTaskOwnerUserId: event.target.value || null }) }), "Responsável atualizado.")}>
          <option value="">Ninguém (fica em Sem responsável)</option>
          {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select></label>
      </div>}
    </section>

    <section className={styles.card}>
      <header className={styles.cardHeader}><div><h3>Regras de corte</h3><p>Só regra aprovada ou divulgada vale. Mudar a regra vale para as demandas novas; o veredito das antigas não muda.</p></div></header>
      <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>Processo</th><th>Regra</th><th className={styles.num}>Valor</th><th>Tipos de demanda</th><th>Situação</th></tr></thead>
        <tbody>{rules.map((rule) => <tr key={rule.code}>
          <td><strong>{rule.name}</strong><br /><small>{rule.description}</small></td>
          <td>{rule.kindLabel}{rule.monthDayLimit ? ` · janela até o dia ${rule.monthDayLimit}` : ""}</td>
          <td className={styles.num}>{canManage
            ? <input type="number" min={0} max={366} aria-label={`Valor da regra ${rule.name}`} defaultValue={rule.value} disabled={busy} className={styles.numberInput}
              onBlur={(event) => Number(event.target.value) !== rule.value && void run(() => dpRequest(`/api/dp/cutoff-rules/${encodeURIComponent(rule.code)}`, { method: "PATCH", body: JSON.stringify({ value: Number(event.target.value) }) }), "Regra atualizada.")} />
            : rule.value}</td>
          <td>{rule.processTypes.join(", ")}</td>
          <td>{canManage
            ? <select aria-label={`Situação da regra ${rule.name}`} value={rule.status} disabled={busy}
              onChange={(event) => void run(() => dpRequest(`/api/dp/cutoff-rules/${encodeURIComponent(rule.code)}`, { method: "PATCH", body: JSON.stringify({ status: event.target.value }) }), "Regra atualizada.")}>
              <option value="proposta">Proposta</option><option value="aprovada">Aprovada</option><option value="divulgada">Divulgada</option>
            </select>
            : rule.status}</td>
        </tr>)}</tbody>
      </table></div>
      {!rules.length && <p className={styles.hint} style={{ padding: "12px 16px" }}>Nenhuma regra cadastrada. Aplique a semente do grupo (scripts/seed-dp-carteira.mjs).</p>}
    </section>
  </div>;
}
