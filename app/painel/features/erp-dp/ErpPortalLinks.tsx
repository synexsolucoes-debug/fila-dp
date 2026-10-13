"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Link2, LoaderCircle, Trash2 } from "lucide-react";
import { ErrorBanner, StatusPill } from "../shared";
import styles from "./erp-record.module.css";

/**
 * Links do portal do colaborador (§4.37): gerar um link com prazo para a
 * pessoa ver os holerites e as férias e pedir férias, e revogar quando
 * precisar. O endereço completo só aparece na hora de gerar.
 */

type Link = { id: string; expiresAt: string; openedCount: number; lastOpenedAt: string | null; createdAt: string; status: "active" | "revoked" | "expired" };

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json" } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.error || payload.message || "Não foi possível concluir a operação.");
  return payload;
}
const br = (date: string) => new Intl.DateTimeFormat("pt-BR").format(new Date(date));
const statusLabels = { active: "Ativo", revoked: "Revogado", expired: "Vencido" } as const;
const statusTone = { active: "active", revoked: "neutral", expired: "warning" } as const;

export function ErpPortalLinks({ employeeId, canManage }: { employeeId: string; canManage: boolean }) {
  const [links, setLinks] = useState<Link[] | null>(null);
  const [created, setCreated] = useState("");
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try { setLinks((await requestJson<{ links: Link[] }>(`/api/erp-dp/portal-links?employeeId=${encodeURIComponent(employeeId)}`)).links); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao carregar."); }
  }, [employeeId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  async function create() {
    setBusy(true); setCopied(false);
    try {
      const payload = await requestJson<{ link: { url: string } }>("/api/erp-dp/portal-links", { method: "POST", body: JSON.stringify({ employeeId, days: Number(days) }) });
      setCreated(payload.link.url);
      setError("");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível gerar."); }
    finally { setBusy(false); }
  }

  async function revoke(id: string) {
    setBusy(true);
    try { await requestJson(`/api/erp-dp/portal-links/${encodeURIComponent(id)}`, { method: "DELETE" }); setError(""); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível revogar."); }
    finally { setBusy(false); }
  }

  return <section className={styles.requirementEditor} aria-labelledby="portal-links-title">
    <header><div><span>AUTOATENDIMENTO (ESS)</span><h3 id="portal-links-title">Portal do colaborador</h3></div></header>
    <p className={styles.fieldHint}>Um link sem senha para a pessoa baixar os holerites das folhas fechadas, ver o saldo de férias e pedir férias ao DP.</p>
    {error && <ErrorBanner title="Atenção" message={error} />}
    {created && <p className={styles.infoNote}><Link2 aria-hidden="true" /><span><strong>Link gerado — envie para a pessoa</strong>
      <small>{created}</small>
      <span className={styles.chips}><button type="button" className={styles.secondaryButton}
        onClick={() => { void navigator.clipboard?.writeText(created).then(() => setCopied(true)); }}><Copy aria-hidden="true" /> {copied ? "Copiado" : "Copiar link"}</button></span>
    </span></p>}
    {canManage && <div className={styles.chips}>
      <label className={styles.fieldHint}>Vale por <select value={days} onChange={(event) => setDays(event.target.value)}>
        <option value="7">7 dias</option><option value="30">30 dias</option><option value="90">90 dias</option><option value="365">1 ano</option></select></label>
      <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void create()}>
        {busy ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : <Link2 aria-hidden="true" />} Gerar link do portal</button>
    </div>}
    {links && links.length > 0 && <div className={styles.tableWrap}><table className={styles.table}>
      <caption className="sr-only">Links do portal</caption>
      <thead><tr><th>Gerado em</th><th>Vale até</th><th>Aberturas</th><th>Situação</th><th /></tr></thead>
      <tbody>{links.map((link) => <tr key={link.id}>
        <td data-label="Gerado em">{br(link.createdAt)}</td>
        <td data-label="Vale até">{br(link.expiresAt)}</td>
        <td data-label="Aberturas">{link.openedCount}</td>
        <td data-label="Situação"><StatusPill status={statusTone[link.status]} label={statusLabels[link.status]} /></td>
        <td>{canManage && link.status === "active" && <button type="button" className={styles.secondaryButton} disabled={busy}
          aria-label="Revogar link" onClick={() => void revoke(link.id)}><Trash2 aria-hidden="true" /> Revogar</button>}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
