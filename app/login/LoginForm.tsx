"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const returnTo = new URLSearchParams(window.location.search).get("return_to") || "/painel?modulos=1";
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnTo }),
      });
      const payload = await response.json() as { error?: string; redirectTo?: string };
      if (!response.ok) throw new Error(payload.error || "Não foi possível concluir o acesso.");
      // Sem abertura animada: quem acabou de digitar a senha quer o sistema,
      // não o logotipo. O botão continua em "Aguarde…" até a página trocar.
      window.location.assign(payload.redirectTo || "/painel?modulos=1");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir o acesso.");
      setBusy(false);
    }
  }

  return (
    <>
      <h2>Entrar</h2>
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
    </>
  );
}
