"use client";

import { FormEvent, useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, ShieldCheck } from "lucide-react";

export function LoginForm() {
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState("");

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/setup-status")
      .then((response) => response.json())
      .then((payload: { setupRequired?: boolean }) => { if (active) setSetupRequired(Boolean(payload.setupRequired)); })
      .catch(() => { if (active) setSetupRequired(false); });
    return () => { active = false; };
  }, []);

  const isBootstrap = setupRequired === true;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const returnTo = new URLSearchParams(window.location.search).get("return_to") || "/painel";
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: isBootstrap ? "bootstrap" : "login", email, password, name, groupName, returnTo }),
      });
      const payload = await response.json() as { error?: string; redirectTo?: string };
      if (!response.ok) throw new Error(payload.error || "Não foi possível concluir o acesso.");
      window.location.assign(payload.redirectTo || "/painel");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir o acesso.");
      setBusy(false);
    }
  }

  async function requestRecovery() {
    setError("");
    setRecoveryMessage("");
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError("Informe seu e-mail antes de solicitar a recuperação.");
      return;
    }
    setRecoveryBusy(true);
    try {
      const response = await fetch("/api/auth/forgot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      const payload = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "Não foi possível solicitar a recuperação.");
      setRecoveryMessage(payload.message || "Se o e-mail estiver liberado, você receberá as instruções.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível solicitar a recuperação.");
    } finally {
      setRecoveryBusy(false);
    }
  }

  return (
    <>
      <span className="auth-status neutral"><ShieldCheck aria-hidden="true" /> Acesso administrado</span>
      <h2>{isBootstrap ? "Configure o primeiro grupo" : "Entrar no Fila DP"}</h2>
      <p>{isBootstrap ? "Crie o grupo empresarial e a primeira conta administradora. Os próximos usuários serão liberados por você." : "Use o e-mail e a senha liberados pelo administrador do seu grupo."}</p>
      <form className="auth-login-form" onSubmit={submit}>
        {isBootstrap && <><label>Nome do grupo empresarial<input value={groupName} onChange={(event) => setGroupName(event.target.value)} autoComplete="organization" placeholder="Ex.: Grupo Opty" required /></label><label>Seu nome completo<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required /></label></>}
        <label>E-mail<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
        <label>Senha<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} autoComplete={isBootstrap ? "new-password" : "current-password"} required /><small>Mínimo de 8 caracteres.</small></label>
        {error && <p className="auth-login-error" role="alert">{error}</p>}
        {recoveryMessage && <p className="auth-login-success" role="status">{recoveryMessage}</p>}
        <button className="button auth-primary" disabled={busy || setupRequired === null}>{busy ? "Aguarde…" : isBootstrap ? "Criar grupo e administrador" : "Entrar"}<ArrowRight aria-hidden="true" /></button>
      </form>
      {!isBootstrap && <p className="auth-recovery-hint">Primeiro acesso ou senha esquecida? <button type="button" disabled={recoveryBusy} onClick={() => void requestRecovery()}>{recoveryBusy ? "Enviando…" : "Receber link por e-mail"}</button></p>}
      <div className="auth-security-note"><CheckCircle2 aria-hidden="true" /><p>O administrador define o papel, as empresas permitidas e pode revogar o acesso a qualquer momento.</p></div>
    </>
  );
}
