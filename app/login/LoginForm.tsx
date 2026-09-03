"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, ShieldCheck } from "lucide-react";
import { LoginIntroMotion } from "@/app/components/LoginIntroMotion";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loginDestination, setLoginDestination] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const returnTo = new URLSearchParams(window.location.search).get("return_to") || "/painel";
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnTo }),
      });
      const payload = await response.json() as { error?: string; redirectTo?: string };
      if (!response.ok) throw new Error(payload.error || "Não foi possível concluir o acesso.");
      const destination = payload.redirectTo || "/painel";

      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;

      if (reducedMotion) {
        window.location.assign(destination);
        return;
      }

      setLoginDestination(destination);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir o acesso.");
      setBusy(false);
    }
  }

  if (loginDestination) {
    return <LoginIntroMotion destination={loginDestination} />;
  }

  return (
    <>
      <span className="auth-status neutral"><ShieldCheck aria-hidden="true" /> Acesso administrado</span>
      <h2>Entrar no Vinculato</h2>
      <p>Use o e-mail e a senha liberados pelo administrador do seu grupo.</p>
      <form className="auth-login-form" onSubmit={submit}>
        <label>E-mail<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
        <label>Senha<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} autoComplete="current-password" required /><small>Mínimo de 8 caracteres.</small></label>
        {error && <p className="auth-login-error" role="alert">{error}</p>}
        <button className="button auth-primary" disabled={busy}>{busy ? "Aguarde…" : "Entrar"}<ArrowRight aria-hidden="true" /></button>
      </form>
      <p className="auth-recovery-hint">Ainda não tem conta? <Link href="/cadastro">Criar workspace Starter gratuito</Link>.</p>
      <p className="auth-recovery-hint">
        Esqueceu a senha? <Link href="/recuperar">Recuperar acesso</Link>. No primeiro acesso, o link de ativação é
        enviado pelo administrador do grupo.
      </p>
      <div className="auth-security-note"><CheckCircle2 aria-hidden="true" /><p>O administrador define o papel, as empresas permitidas e pode revogar o acesso a qualquer momento.</p></div>
    </>
  );
}
