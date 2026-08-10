"use client";

import { FormEvent, useState } from "react";
import { leadInterestLabels, leadInterests, type LeadInterest } from "@/lib/marketing";
import { siteStyles as styles } from "../site/SiteShell";

type Status = { tone: "success" | "error"; message: string } | null;

/**
 * Formulário de contato do site.
 *
 * O envio grava um registro de verdade e devolve um protocolo — o botão não é
 * decorativo. O consentimento é obrigatório para que o retorno seja legítimo.
 */
export function ContactForm({ defaultInterest }: { defaultInterest: LeadInterest }) {
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch("/api/site/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: String(form.get("name") ?? ""),
          email: String(form.get("email") ?? ""),
          company: String(form.get("company") ?? ""),
          phone: String(form.get("phone") ?? ""),
          headcount: String(form.get("headcount") ?? ""),
          interest: String(form.get("interest") ?? ""),
          message: String(form.get("message") ?? ""),
          consent: form.get("consent") === "on",
          sourcePath: window.location.pathname,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { protocol?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "Não foi possível enviar o contato.");
      setStatus({ tone: "success", message: `Contato recebido. Protocolo ${payload.protocol}. Retornamos pelo e-mail informado.` });
      event.currentTarget.reset();
    } catch (cause) {
      setStatus({ tone: "error", message: cause instanceof Error ? cause.message : "Não foi possível enviar o contato." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate={false}>
      {status && <p className={styles.formStatus} data-tone={status.tone} role={status.tone === "error" ? "alert" : "status"}>{status.message}</p>}

      <div className={styles.formRow}>
        <label>Nome<input name="name" required minLength={2} maxLength={120} autoComplete="name" /></label>
        <label>E-mail corporativo<input name="email" type="email" required maxLength={180} autoComplete="email" /></label>
      </div>
      <div className={styles.formRow}>
        <label>Empresa<input name="company" maxLength={160} autoComplete="organization" /></label>
        <label>Telefone<input name="phone" maxLength={40} autoComplete="tel" /></label>
        <label>Colaboradores
          <select name="headcount" defaultValue="">
            <option value="">Prefiro não informar</option>
            <option value="ate-50">Até 50</option>
            <option value="51-200">51 a 200</option>
            <option value="201-1000">201 a 1.000</option>
            <option value="mais-1000">Mais de 1.000</option>
          </select>
        </label>
      </div>
      <label>Assunto
        <select name="interest" defaultValue={defaultInterest} required>
          {leadInterests.map((item) => <option key={item} value={item}>{leadInterestLabels[item]}</option>)}
        </select>
      </label>
      <label>Como podemos ajudar?<textarea name="message" maxLength={1000} placeholder="Conte o cenário: quantas empresas, quais sistemas usa hoje e o que precisa resolver." /></label>

      <label className={styles.consent}>
        <input type="checkbox" name="consent" required />
        <span>
          Concordo que o Vinculato use estes dados para retornar o contato, conforme a Política de privacidade.
          Os dados não são vendidos nem usados para outra finalidade.
        </span>
      </label>

      <button className={styles.primaryButton} type="submit" disabled={busy}>
        {busy ? "Enviando…" : "Enviar contato"}
      </button>
    </form>
  );
}
