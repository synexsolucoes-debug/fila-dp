"use client";

import { FormEvent, useId, useRef, useState } from "react";
import { leadInterestLabels, leadInterests, type LeadInterest } from "@/lib/marketing";
import { siteStyles as styles } from "../site/SiteShell";

type Status = { tone: "success" | "error"; message: string } | null;
type FieldErrors = Partial<Record<"name" | "email" | "consent", string>>;

/**
 * Formulário de contato do site.
 *
 * O envio grava um registro de verdade e devolve um protocolo — o botão não é
 * decorativo. O consentimento é obrigatório para que o retorno seja legítimo.
 *
 * A validação é do próprio formulário, e não do navegador. A bolha nativa do
 * `required` desaparece ao primeiro clique, não é lida por leitor de tela junto
 * do campo e some por completo quando o envio é interceptado por JavaScript —
 * era o caso aqui. Cada campo passa a ter mensagem própria, ligada por
 * `aria-describedby`, e o foco vai para o primeiro erro.
 */
export function ContactForm({ defaultInterest }: { defaultInterest: LeadInterest }) {
  const [status, setStatus] = useState<Status>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);

  function validate(form: FormData): FieldErrors {
    const found: FieldErrors = {};
    const name = String(form.get("name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    if (name.length < 2) found.name = "Informe seu nome com pelo menos 2 caracteres.";
    // O mesmo formato que `sanitizeLead` aplica no servidor: divergir aqui
    // faria o campo passar na tela e ser recusado depois, sem dizer qual era.
    if (!/^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/u.test(email)) {
      found.email = "Informe um e-mail válido, no formato nome@empresa.com.br.";
    }
    if (form.get("consent") !== "on") found.consent = "É necessário concordar com o uso dos dados para retornarmos o contato.";
    return found;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Guarda contra envio duplo: o clique repetido enquanto a requisição está
    // em curso criaria dois protocolos para o mesmo contato.
    if (busy) return;

    const element = event.currentTarget;
    const form = new FormData(element);
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setStatus(null);
      const first = Object.keys(found)[0];
      element.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }

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
      formRef.current?.reset();
    } catch (cause) {
      setStatus({ tone: "error", message: cause instanceof Error ? cause.message : "Não foi possível enviar o contato." });
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (field: keyof FieldErrors) => (errors[field]
    ? <small className={styles.fieldError} id={`${formId}-${field}-erro`}>{errors[field]}</small>
    : null);
  const fieldProps = (field: keyof FieldErrors) => ({
    "aria-invalid": errors[field] ? true : undefined,
    "aria-describedby": errors[field] ? `${formId}-${field}-erro` : undefined,
  });

  return (
    <form className={styles.form} ref={formRef} onSubmit={submit} noValidate aria-busy={busy}>
      {status && (
        <p
          className={styles.formStatus}
          data-tone={status.tone}
          role={status.tone === "error" ? "alert" : "status"}
        >
          {status.message}
        </p>
      )}

      <div className={styles.formRow}>
        <label>
          Nome
          <input name="name" required minLength={2} maxLength={120} autoComplete="name" {...fieldProps("name")} />
          {fieldError("name")}
        </label>
        <label>
          E-mail corporativo
          <input name="email" type="email" required maxLength={180} autoComplete="email" {...fieldProps("email")} />
          {fieldError("email")}
        </label>
      </div>
      <div className={styles.formRow}>
        <label>Empresa<input name="company" maxLength={160} autoComplete="organization" /></label>
        <label>Telefone<input name="phone" type="tel" maxLength={40} autoComplete="tel" inputMode="tel" /></label>
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
        <input type="checkbox" name="consent" required {...fieldProps("consent")} />
        <span>
          Concordo que o Vinculato use estes dados para retornar o contato, conforme a Política de privacidade.
          Os dados não são vendidos nem usados para outra finalidade.
        </span>
      </label>
      {fieldError("consent")}

      <button className={styles.primaryButton} type="submit" disabled={busy}>
        {busy ? "Enviando…" : "Enviar contato"}
      </button>
    </form>
  );
}
