"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, FileUp, LoaderCircle, ShieldCheck } from "lucide-react";
import styles from "./portal.module.css";

/**
 * O formulário do prestador.
 *
 * A tela tem quatro estados e nenhum deles é uma página de erro anônima:
 * carregando, pedido em aberto, pedido já resolvido (enviado, revogado ou
 * vencido) e envio concluído. Mesmo quando o link não serve mais, a página
 * mostra de que pedido se trata — quem recebeu a mensagem precisa reconhecer o
 * que abriu antes de procurar alguém para reclamar.
 *
 * Erro de envio não limpa o formulário. Quem digitou número, data e valor e
 * anexou um PDF não deve refazer tudo porque a rede caiu no meio.
 */

type Issuer = { legalName: string; taxId: string; city: string };
type Portal = {
  contractorName: string; competence: string; expectedAmount: number;
  expiresAt: string; submittedAt: string; issuer: Issuer;
};
type Status = "active" | "submitted" | "revoked" | "expired";

const money = (value: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);

const competenceLabel = (value: string) => {
  const [year, month] = value.split("-");
  if (!year || !month) return value;
  return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" })
    .format(new Date(Number(year), Number(month) - 1, 1));
};

const dayLabel = (value: string) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(date);
};

const formatTaxId = (value: string) => {
  const digits = (value ?? "").replace(/\D/gu, "");
  if (digits.length === 14) return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/u, "$1.$2.$3/$4-$5");
  return value;
};

const resolvedNote: Record<Exclude<Status, "active">, string> = {
  submitted: "A nota desta competência já foi recebida. Se precisar trocar o documento, fale com quem cuida do pagamento na empresa.",
  revoked: "Este link foi cancelado pela empresa. Peça um novo a quem cuida do pagamento.",
  expired: "O prazo deste link terminou. Peça um novo a quem cuida do pagamento.",
};

export function PortalInvoiceForm({ token }: { token: string }) {
  const [portal, setPortal] = useState<Portal | null>(null);
  const [status, setStatus] = useState<Status>("active");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [done, setDone] = useState<{ invoiceNumber: string; amount: number } | null>(null);

  const endpoint = `/api/portal/nota/${encodeURIComponent(token)}`;

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
      const response = await fetch(endpoint, { method: "POST", body: new FormData(event.currentTarget) });
      const payload = await response.json().catch(() => ({})) as
        { received?: { invoiceNumber: string; amount: number }; message?: string };
      if (!response.ok) {
        setError(payload.message || "Não foi possível enviar a nota. Confira os dados e tente de novo.");
        return;
      }
      setDone(payload.received ?? null);
      setStatus("submitted");
    } catch {
      setError("Não foi possível enviar a nota. Confira sua conexão e tente de novo.");
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return <main className={styles.page}><section className={styles.card}>
      <p className={styles.loading} role="status"><LoaderCircle aria-hidden="true" className={styles.spin} /> Carregando o pedido…</p>
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
          <h1>Nota recebida</h1>
          <p>
            A nota <strong>{done.invoiceNumber}</strong>, de {money(done.amount)}, chegou para a competência
            {" "}{competenceLabel(portal.competence)}. A empresa vai conferir o documento antes do pagamento.
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
          <span className={styles.eyebrow}>ENVIO DE NOTA FISCAL</span>
          <h1>Olá, {portal.contractorName}</h1>
          <p>
            Competência <strong>{competenceLabel(portal.competence)}</strong>, no valor de{" "}
            <strong className={styles.amount}>{money(portal.expectedAmount)}</strong>.
          </p>
        </header>

        <dl className={styles.issuer}>
          <div><dt>Emitir a nota para</dt><dd>{portal.issuer.legalName}</dd></div>
          {portal.issuer.taxId && <div><dt>CNPJ</dt><dd className={styles.mono}>{formatTaxId(portal.issuer.taxId)}</dd></div>}
          {portal.issuer.city && <div><dt>Cidade da prestação do serviço</dt><dd>{portal.issuer.city}</dd></div>}
        </dl>

        {status !== "active" ? (
          <div className={styles.alert} role="status"><AlertTriangle aria-hidden="true" /><p>{resolvedNote[status]}</p></div>
        ) : (
          <form onSubmit={submit} className={styles.form}>
            {error && <div className={styles.alert} role="alert"><AlertTriangle aria-hidden="true" /><p>{error}</p></div>}
            <div className={styles.grid}>
              <label><span>Número da nota</span><input name="invoiceNumber" required maxLength={80} inputMode="numeric" autoComplete="off" /></label>
              <label><span>Série</span><input name="series" maxLength={20} autoComplete="off" placeholder="Opcional" /></label>
              <label><span>Data de emissão</span><input name="issueDate" type="date" required /></label>
              <label><span>Valor da nota</span><input name="receivedAmount" type="number" min="0" step="0.01" required inputMode="decimal" /></label>
              <label className={styles.spanTwo}><span>CNPJ do emitente</span><input name="issuerDocument" maxLength={20} inputMode="numeric" autoComplete="off" placeholder="Opcional — o CNPJ da sua empresa" /></label>
              <label className={styles.spanTwo}>
                <span>Arquivo da nota</span>
                <input name="invoiceFile" type="file" required accept=".pdf,.xml,.jpg,.jpeg,.png,.webp,application/pdf,text/xml,application/xml,image/jpeg,image/png,image/webp" />
                <small>PDF, XML ou imagem, até 20 MB.</small>
              </label>
            </div>
            <p className={styles.deadline}>
              {portal.expiresAt && `Este link vale até ${dayLabel(portal.expiresAt)}.`}
            </p>
            <button type="submit" className={styles.submit} disabled={sending}>
              {sending ? <><LoaderCircle aria-hidden="true" className={styles.spin} /> Enviando…</> : <><FileUp aria-hidden="true" /> Enviar nota fiscal</>}
            </button>
          </form>
        )}

        <p className={styles.privacy}>
          <ShieldCheck aria-hidden="true" />
          Este endereço é pessoal e vale só para esta competência. Não repasse o link.
        </p>
      </section>
    </main>
  );
}
