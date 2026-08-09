"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertOctagon, ArrowRight, CheckCircle2, LoaderCircle, RefreshCw } from "lucide-react";
import type { ActionItem, ActionTarget } from "@/lib/action-center";
import styles from "./action-center.module.css";

type Payload = {
  items?: ActionItem[];
  pendingTotal?: number;
  criticalTotal?: number;
  generatedAt?: string;
  notCovered?: string[];
  error?: string;
};

const money = (value: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);

function dueLabel(value: string | null) {
  if (!value) return "";
  const today = new Date().toISOString().slice(0, 10);
  const formatted = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(new Date(`${value}T12:00:00`));
  if (value < today) return `venceu em ${formatted}`;
  if (value === today) return "vence hoje";
  return `vence em ${formatted}`;
}

/**
 * Central de ação do painel.
 *
 * Cada indicador é clicável e leva ao módulo responsável — nenhum número
 * decorativo. Indicadores zerados são mantidos fora da lista para que a tela
 * responda de fato "o que precisa ser feito agora?".
 */
export function ActionCenter({ onNavigate }: { onNavigate: (target: ActionTarget) => void }) {
  const [items, setItems] = useState<ActionItem[]>([]);
  const [pendingTotal, setPendingTotal] = useState(0);
  const [criticalTotal, setCriticalTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true); else setLoading(true);
    try {
      const response = await fetch("/api/dashboard/action-center", { cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as Payload;
      if (!response.ok) throw new Error(payload.error || "Não foi possível carregar as pendências.");
      setItems(payload.items ?? []);
      setPendingTotal(payload.pendingTotal ?? 0);
      setCriticalTotal(payload.criticalTotal ?? 0);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar as pendências.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const active = items.filter((item) => item.count > 0);

  return (
    <section className={styles.actionCenter} aria-labelledby="action-center-title" aria-busy={loading}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>O QUE PRECISA SER FEITO AGORA</span>
          <h2 id="action-center-title">Central de ação</h2>
          <p aria-live="polite">
            {loading
              ? "Consultando pendências da operação…"
              : active.length === 0
                ? "Nenhuma pendência aberta nos módulos que você acompanha."
                : `${pendingTotal} pendência(s) em aberto${criticalTotal ? `, ${criticalTotal} crítica(s)` : ""}.`}
          </p>
        </div>
        <button className={styles.refresh} type="button" onClick={() => void load(true)} disabled={refreshing || loading}>
          <RefreshCw aria-hidden="true" className={refreshing ? styles.spin : undefined} />
          {refreshing ? "Atualizando…" : "Atualizar"}
        </button>
      </header>

      {error && <p className={styles.error} role="alert"><AlertOctagon aria-hidden="true" /> {error}</p>}

      {loading && (
        <p className={styles.loading}><LoaderCircle aria-hidden="true" className={styles.spin} /> Carregando indicadores…</p>
      )}

      {!loading && !error && active.length === 0 && (
        <p className={styles.empty}>
          <CheckCircle2 aria-hidden="true" />
          Tudo em dia por aqui. Novas pendências aparecem assim que surgirem em competências, movimentações, pagamentos ou integrações.
        </p>
      )}

      {!loading && active.length > 0 && (
        <ul className={styles.grid}>
          {active.map((item) => (
            <li key={item.key}>
              <button type="button" data-tone={item.tone} onClick={() => onNavigate(item.target)}>
                <span className={styles.count}>{item.count}</span>
                <span className={styles.label}>{item.label}</span>
                <span className={styles.description}>
                  {item.amount !== null && item.amount > 0 ? `${money(item.amount)} · ` : ""}
                  {item.earliestDueDate ? dueLabel(item.earliestDueDate) : item.description}
                </span>
                <span className={styles.cta} aria-hidden="true">Abrir <ArrowRight /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
