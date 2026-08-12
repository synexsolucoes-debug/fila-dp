"use client";

import { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, LoaderCircle, RefreshCw, X } from "lucide-react";
import styles from "../platform.module.css";

export type Row = Record<string, unknown>;
export type FeatureProps = { params: URLSearchParams; updateQuery: (updates: Record<string, string | null>) => void };
export const text = (value: unknown) => value == null ? "" : String(value);
export const number = (value: unknown) => Number(value) || 0;
export const bool = (value: unknown) => value === true || value === 1 || value === "1" || value === "t" || value === "true";
export const date = (value: unknown) => {
  const source = text(value); if (!source) return "—"; const parsed = new Date(source);
  return Number.isNaN(parsed.getTime()) ? source : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(parsed);
};
export const money = (cents: unknown, currency = "BRL") => new Intl.NumberFormat("pt-BR", { style: "currency", currency, maximumFractionDigits: 0 }).format(number(cents) / 100);

export async function platformRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `A operação falhou (${response.status}).`);
  return payload;
}

export function usePlatformResource<T>(url: string) {
  const [data, setData] = useState<T | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [version, setVersion] = useState(0);
  useEffect(() => { const controller = new AbortController();
    void Promise.resolve().then(() => { if (!controller.signal.aborted) { setLoading(true); setError(""); } return platformRequest<T>(url, { signal: controller.signal }); }).then(setData).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Falha ao carregar."); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [url, version]);
  return { data, loading, error, refresh: () => setVersion((current) => current + 1) };
}

export function FeatureHeader({ eyebrow, title, description, loading, onRefresh, actions }: { eyebrow: string; title: string; description: string; loading?: boolean; onRefresh?: () => void; actions?: ReactNode }) {
  return <><header className={styles.featureHeader}><div><span>{eyebrow}</span><h1>{title}</h1><p>{description}</p></div><div>{actions}{onRefresh && <button type="button" onClick={onRefresh} disabled={loading}><RefreshCw className={loading ? styles.spin : ""} aria-hidden="true" />Atualizar</button>}</div></header><div className={styles.scopeStrip}><AlertTriangle aria-hidden="true" /><span><strong>Dados de múltiplos clientes</strong> · ações são autorizadas e auditadas no servidor.</span></div></>;
}

export function Loading({ label = "Carregando dados globais…" }: { label?: string }) { return <div className={styles.featureState}><LoaderCircle className={styles.spin} aria-hidden="true" /><p>{label}</p></div>; }
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) { return <div className={`${styles.featureState} ${styles.dangerState}`} role="alert"><AlertTriangle aria-hidden="true" /><strong>Não foi possível carregar</strong><p>{message}</p>{retry && <button type="button" onClick={retry}>Tentar novamente</button>}</div>; }
export function Empty({ children = "Nenhum registro encontrado." }: { children?: ReactNode }) { return <div className={styles.compactEmpty}>{children}</div>; }
export function Notice({ children }: { children: ReactNode }) { return <div className={styles.notice} role="status"><CheckCircle2 aria-hidden="true" />{children}</div>; }
export function Status({ value }: { value: string }) { const tone = ["active", "connected", "completed", "ok", "ready", "paid", "success"].includes(value) ? "safe" : ["past_due", "partial", "paused", "trialing", "queued", "outdated"].includes(value) ? "warning" : ["failed", "error", "blocked", "dead_letter", "degraded", "uncollectible"].includes(value) ? "danger" : "neutral"; return <span className={styles.status} data-tone={tone}>{value || "—"}</span>; }
export function MetricCard({ label, value, note, tone = "neutral" }: { label: string; value: ReactNode; note?: string; tone?: string }) { return <article className={styles.metricCard} data-tone={tone}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</article>; }
export function Panel({ title, subtitle, children, className = "" }: { title: string; subtitle?: string; children: ReactNode; className?: string }) { return <section className={`${styles.featurePanel} ${className}`}><header><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></header>{children}</section>; }

export type AdminAction = {
  title: string;
  consequence: string;
  confirmLabel: string;
  reasonMinLength?: number;
  typedConfirmation?: string;
  credentialInput?: boolean;
  jsonInput?: { label: string; hint?: string; defaultValue?: string };
  extraInput?: { label: string; hint?: string; placeholder?: string; type?: "text" | "email"; defaultValue?: string };
  run: (input: { reason: string; confirmation: string; credentials?: unknown; jsonValue?: unknown; value: string }) => Promise<void>;
};
export function AdminActionDialog({ action, onClose }: { action: AdminAction | null; onClose: () => void }) {
  if (!action) return null;
  return <AdminActionForm key={`${action.title}:${action.typedConfirmation ?? ""}`} action={action} onClose={onClose} />;
}

function AdminActionForm({ action, onClose }: { action: AdminAction; onClose: () => void }) {
  const [reason, setReason] = useState(""); const [confirmation, setConfirmation] = useState(""); const [credentials, setCredentials] = useState(""); const [jsonValue, setJsonValue] = useState(action.jsonInput?.defaultValue ?? ""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const closeRef = useRef<HTMLButtonElement>(null); const dialogRef = useRef<HTMLFormElement>(null);
  const [value, setValue] = useState(action.extraInput?.defaultValue ?? "");
  useEffect(() => { const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null; closeRef.current?.focus(); return () => previous?.focus(); }, []);
  const reasonMinLength = action.reasonMinLength ?? 5;
  const valid = reason.trim().length >= reasonMinLength && (!action.typedConfirmation || confirmation === action.typedConfirmation) && (!action.credentialInput || credentials.trim().length > 1) && (!action.jsonInput || jsonValue.trim().length > 1) && (!action.extraInput || value.trim().length > 0);
  async function submit(event: FormEvent) { event.preventDefault(); if (!valid) return; setBusy(true); setError(""); try { let parsedCredentials: unknown; let parsedJson: unknown; if (action.credentialInput) { try { parsedCredentials = JSON.parse(credentials); } catch { throw new Error("Informe a credencial como um objeto JSON válido."); } } if (action.jsonInput) { try { parsedJson = JSON.parse(jsonValue); } catch { throw new Error("Informe um objeto JSON válido."); } } await action.run({ reason: reason.trim(), confirmation, credentials: parsedCredentials, jsonValue: parsedJson, value: value.trim() }); onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha na ação."); } finally { setBusy(false); } }
  function keyDown(event: ReactKeyboardEvent<HTMLFormElement>) { if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); return; } if (event.key !== "Tab") return; const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])]; if (!focusable.length) return; const first = focusable[0]; const last = focusable.at(-1)!; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
  return <div className={styles.dialogBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><form ref={dialogRef} className={styles.actionDialog} role="dialog" aria-modal="true" aria-labelledby="action-title" onSubmit={submit} onKeyDown={keyDown}>
    <header><div><span>AÇÃO ADMINISTRATIVA</span><h2 id="action-title">{action.title}</h2></div><button ref={closeRef} type="button" onClick={onClose} disabled={busy} aria-label="Fechar"><X aria-hidden="true" /></button></header>
    <div><div className={styles.consequence}><AlertTriangle aria-hidden="true" /><p><strong>Impacto</strong>{action.consequence}</p></div><label>Motivo obrigatório <small>mínimo de {reasonMinLength} caracteres; será incluído na auditoria</small><textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} autoFocus /></label>
      {action.typedConfirmation && <label>Confirme digitando <code>{action.typedConfirmation}</code><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>}
      {action.extraInput && <label>{action.extraInput.label}{action.extraInput.hint && <small>{action.extraInput.hint}</small>}<input type={action.extraInput.type ?? "text"} value={value} placeholder={action.extraInput.placeholder} onChange={(event) => setValue(event.target.value)} autoComplete="off" /></label>}
      {action.jsonInput && <label>{action.jsonInput.label}{action.jsonInput.hint && <small>{action.jsonInput.hint}</small>}<textarea rows={8} value={jsonValue} onChange={(event) => setJsonValue(event.target.value)} spellCheck={false} autoComplete="off" /></label>}
      {action.credentialInput && <label>Nova credencial do provedor <small>objeto JSON; o valor será cifrado no servidor e nunca retornado</small><textarea rows={5} value={credentials} onChange={(event) => setCredentials(event.target.value)} spellCheck={false} autoComplete="off" /></label>}
      {error && <p className={styles.dialogError} role="alert">{error}</p>}
    </div><footer><button type="button" onClick={onClose} disabled={busy}>Cancelar</button><button type="submit" disabled={!valid || busy}>{busy && <LoaderCircle className={styles.spin} aria-hidden="true" />}{action.confirmLabel}</button></footer>
  </form></div>;
}
