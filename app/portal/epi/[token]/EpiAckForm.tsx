"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, LoaderCircle, PenLine, ShieldCheck } from "lucide-react";
import styles from "./portal.module.css";

/**
 * O formulário de ciência de EPI.
 *
 * Mesmos quatro estados de `PortalInvoiceForm`: carregando, pedido em aberto,
 * pedido já resolvido (confirmado, revogado ou vencido) e confirmação
 * concluída — nenhum deles é uma página de erro anônima.
 */

type Portal = {
  employeeName: string; productName: string; caNumber: string; size: string;
  quantity: number; deliveredOn: string; expiresAt: string;
};
type Status = "active" | "acknowledged" | "revoked" | "expired";

const dayLabel = (value: string) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(date);
};

const resolvedNote: Record<Exclude<Status, "active">, string> = {
  acknowledged: "Este recebimento já foi confirmado. Se algo estiver errado, procure o DP.",
  revoked: "Este link foi cancelado pela empresa. Peça um novo ao DP.",
  expired: "O prazo deste link terminou. Peça um novo ao DP.",
};

export function EpiAckForm({ token }: { token: string }) {
  const [portal, setPortal] = useState<Portal | null>(null);
  const [status, setStatus] = useState<Status>("active");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [done, setDone] = useState<{ signatureName: string } | null>(null);

  const endpoint = `/api/portal/epi/${encodeURIComponent(token)}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as
        { portal?: Portal; status?: Status; message?: string };
      if (!response.ok) {
        setLoadError(payload.message || "Este link não é válido. Confira o endereço recebido.");
        return;
      }
      setPortal(payload.portal ?? null);
      setStatus(payload.status ?? "active");
      setLoadError("");
    } catch {
      setLoadError("Não foi possível carregar o pedido. Confira sua conexão e tente de novo.");
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(); });
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setError("");
    try {
      const form = new FormData(event.currentTarget);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signatureName: form.get("signatureName") }),
      });
      const payload = await response.json().catch(() => ({})) as
        { acknowledged?: { signatureName: string }; message?: string };
      if (!response.ok) {
        setError(payload.message || "Não foi possível confirmar. Confira os dados e tente de novo.");
        return;
      }
      setDone(payload.acknowledged ?? null);
      setStatus("acknowledged");
    } catch {
      setError("Não foi possível confirmar. Confira sua conexão e tente de novo.");
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return <main className={styles.page}><section className={styles.card}>
      <p className={styles.loading} role="status"><LoaderCircle aria-hidden="true" className={styles.spin} /> Carregando o recebimento…</p>
    </section></main>;
  }

  if (loadError || !portal) {
    return <main className={styles.page}><section className={styles.card}>
      <div className={styles.alert} role="alert"><AlertTriangle aria-hidden="true" /><p>{loadError || "Este link não é válido."}</p></div>
    </section></main>;
  }

  if (done) {
    return <main className={styles.page}><section className={styles.card}>
      <div className={styles.success} role="status">
        <CheckCircle2 aria-hidden="true" />
        <div>
          <h1>Recebimento confirmado</h1>
          <p>
            <strong>{done.signatureName}</strong> confirmou o recebimento de <strong>{portal.productName}</strong>.
          </p>
        </div>
      </div>
      <p className={styles.footnote}>Você pode fechar esta página.</p>
    </section></main>;
  }

  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <header className={styles.header}>
          <span className={styles.eyebrow}>CONFIRMAÇÃO DE RECEBIMENTO DE EPI</span>
          <h1>Olá, {portal.employeeName}</h1>
          <p>Confirme abaixo o recebimento do equipamento de proteção entregue pela empresa.</p>
        </header>

        <dl className={styles.issuer}>
          <div><dt>Equipamento</dt><dd>{portal.productName}</dd></div>
          {portal.caNumber && <div><dt>CA</dt><dd className={styles.mono}>{portal.caNumber}</dd></div>}
          {portal.size && <div><dt>Tamanho</dt><dd>{portal.size}</dd></div>}
          <div><dt>Quantidade</dt><dd>{portal.quantity}</dd></div>
          <div><dt>Data da entrega</dt><dd>{dayLabel(portal.deliveredOn)}</dd></div>
        </dl>

        {status !== "active" ? (
          <div className={styles.alert} role="status"><AlertTriangle aria-hidden="true" /><p>{resolvedNote[status]}</p></div>
        ) : (
          <form onSubmit={submit} className={styles.form}>
            {error && <div className={styles.alert} role="alert"><AlertTriangle aria-hidden="true" /><p>{error}</p></div>}
            <div className={styles.grid}>
              <label className={styles.spanTwo}>
                <span>Seu nome completo</span>
                <input name="signatureName" required maxLength={160} autoComplete="name" placeholder="Digite seu nome para confirmar" />
              </label>
            </div>
            <p className={styles.deadline}>
              {portal.expiresAt && `Este link vale até ${dayLabel(portal.expiresAt)}.`}
            </p>
            <button type="submit" className={styles.submit} disabled={sending}>
              {sending ? <><LoaderCircle aria-hidden="true" className={styles.spin} /> Confirmando…</> : <><PenLine aria-hidden="true" /> Confirmar recebimento</>}
            </button>
          </form>
        )}

        <p className={styles.privacy}>
          <ShieldCheck aria-hidden="true" />
          Este endereço é pessoal e vale só para esta entrega. Não repasse o link.
        </p>
      </section>
    </main>
  );
}
