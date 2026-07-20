"use client";

import { FormEvent, useState } from "react";

export function LoginForm() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const returnTo = new URLSearchParams(window.location.search).get("return_to") || "/painel";
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, email, password, name, returnTo }),
      });
      const payload = await response.json() as { error?: string; redirectTo?: string };
      if (response.status === 409) {
        setMode("login");
        setPassword("");
        setError("Esta conta já foi criada. Entre com sua senha para continuar.");
        setBusy(false);
        return;
      }
      if (!response.ok) throw new Error(payload.error || "Não foi possível concluir o acesso.");
      window.location.assign(payload.redirectTo || "/painel");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir o acesso.");
      setBusy(false);
    }
  }

  return (
    <>
      <span className="auth-status neutral">Área exclusiva</span>
      <h2>{mode === "login" ? "Entrar no Fila DP" : "Criar conta no Fila DP"}</h2>
      <p>{mode === "login" ? "Acesse sua operação com e-mail e senha." : "Comece sua operação e convide sua equipe depois."}</p>
      <form className="auth-login-form" onSubmit={submit}>
        {mode === "register" && <label>Nome completo<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required /></label>}
        <label>E-mail<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
        <label>Senha<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} autoComplete={mode === "login" ? "current-password" : "new-password"} required /><small>Mínimo de 8 caracteres.</small></label>
        {error && <p className="auth-login-error" role="alert">{error}</p>}
        <button className="button auth-primary" disabled={busy}>{busy ? "Aguarde…" : mode === "login" ? "Entrar" : "Criar conta"}<span aria-hidden="true">→</span></button>
      </form>
      <button className="auth-secondary-link auth-mode-toggle" type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "Ainda não tenho conta" : "Já tenho uma conta"}</button>
      <div className="auth-security-note"><span aria-hidden="true">✓</span><p>Seu acesso é protegido por sessão segura. A senha é armazenada apenas como hash.</p></div>
    </>
  );
}
