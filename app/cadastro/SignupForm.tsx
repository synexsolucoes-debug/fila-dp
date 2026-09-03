"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, ShieldCheck } from "lucide-react";

export function SignupForm() {
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          email: form.get("email"),
          password: form.get("password"),
          workspaceName: form.get("workspaceName"),
          acceptTerms: form.get("acceptTerms") === "on",
          acceptPrivacy: form.get("acceptPrivacy") === "on",
        }),
      });
      const payload = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "Não foi possível concluir o cadastro.");
      setMessage(payload.message || "Verifique seu e-mail para confirmar o cadastro.");
      formElement.reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir o cadastro.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <span className="auth-status neutral"><ShieldCheck aria-hidden="true" /> Plano Starter</span>
      <h2>Crie seu workspace gratuito</h2>
      <p>Comece no plano Starter e conclua o CNPJ no onboarding da empresa.</p>
      <form className="auth-login-form" onSubmit={submit}>
        <label>Seu nome<input name="name" autoComplete="name" minLength={2} maxLength={120} required /></label>
        <label>E-mail<input name="email" type="email" autoComplete="email" maxLength={254} required /></label>
        <label>Senha<input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={200} required /><small>Use pelo menos 8 caracteres.</small></label>
        <label>Nome da organização<input name="workspaceName" autoComplete="organization" minLength={2} maxLength={160} required /></label>
        <label><span><input name="acceptTerms" type="checkbox" style={{ width: "auto", minHeight: 0 }} required /> Aceito os <Link href="/termos" target="_blank" rel="noreferrer">Termos de Uso</Link>.</span></label>
        <label><span><input name="acceptPrivacy" type="checkbox" style={{ width: "auto", minHeight: 0 }} required /> Aceito a <Link href="/privacidade" target="_blank" rel="noreferrer">Política de Privacidade</Link>.</span></label>
        {error && <p className="auth-login-error" role="alert">{error}</p>}
        {message && <p role="status"><CheckCircle2 aria-hidden="true" /> {message}</p>}
        <button className="button auth-primary" disabled={busy}>{busy ? "Enviando…" : "Criar conta"}<ArrowRight aria-hidden="true" /></button>
      </form>
    </>
  );
}
