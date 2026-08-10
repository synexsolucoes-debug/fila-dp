"use client";

import { FormEvent, useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, ShieldCheck, UserPlus } from "lucide-react";

export function LoginForm() {
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch("/api/auth/setup-status")
      .then((response) => response.json())
      .then((payload: { setupRequired?: boolean; signupEnabled?: boolean }) => {
        if (!active) return;
        setSetupRequired(Boolean(payload.setupRequired));
        setSignupEnabled(Boolean(payload.signupEnabled));
        // O site pode chegar aqui pedindo o cadastro. A intenção só vira modo de
        // criação se a criação pública estiver mesmo habilitada — caso contrário
        // a tela continua sendo a de entrada, sem prometer um caminho inexistente.
        if (payload.signupEnabled && new URLSearchParams(window.location.search).get("modo") === "criar") {
          setMode("signup");
        }
      })
      .catch(() => { if (active) { setSetupRequired(false); setSignupEnabled(false); } });
    return () => { active = false; };
  }, []);

  const isBootstrap = setupRequired === true;
  const isSignup = !isBootstrap && signupEnabled && mode === "signup";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const returnTo = new URLSearchParams(window.location.search).get("return_to") || "/painel";
      const response = await fetch(isSignup ? "/api/auth/signup" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isSignup ? { name, groupName, email, password } : { mode: isBootstrap ? "bootstrap" : "login", email, password, name, groupName, returnTo }),
      });
      const payload = await response.json() as { error?: string; redirectTo?: string };
      if (!response.ok) throw new Error(payload.error || "Não foi possível concluir o acesso.");
      window.location.assign(payload.redirectTo || "/painel");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir o acesso.");
      setBusy(false);
    }
  }

  return (
    <>
      <span className="auth-status neutral">{isSignup ? <UserPlus aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />} {isSignup ? "Novo workspace" : "Acesso administrado"}</span>
      <h2>{isBootstrap ? "Configure o primeiro grupo" : isSignup ? "Crie sua conta" : "Entrar no Vinculato"}</h2>
      <p>{isBootstrap ? "Crie o grupo empresarial e a primeira conta administradora. Os próximos usuários serão liberados por você." : isSignup ? "Abra um novo grupo e comece a ativação do seu workspace." : "Use o e-mail e a senha liberados pelo administrador do seu grupo."}</p>
      {!isBootstrap && signupEnabled && <div className="auth-mode-switch" role="group" aria-label="Modo de acesso"><button type="button" aria-pressed={!isSignup} onClick={() => { setMode("login"); setError(""); }}>Entrar</button><button type="button" aria-pressed={isSignup} onClick={() => { setMode("signup"); setError(""); }}>Criar conta</button></div>}
      <form className="auth-login-form" onSubmit={submit}>
        {(isBootstrap || isSignup) && <><label>Nome do grupo empresarial<input value={groupName} onChange={(event) => setGroupName(event.target.value)} autoComplete="organization" placeholder="Ex.: Grupo Opty" required /></label><label>Seu nome completo<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required /></label></>}
        <label>E-mail<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
        <label>Senha<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} autoComplete={isBootstrap || isSignup ? "new-password" : "current-password"} required /><small>Mínimo de 8 caracteres.</small></label>
        {error && <p className="auth-login-error" role="alert">{error}</p>}
        <button className="button auth-primary" disabled={busy || setupRequired === null}>{busy ? "Aguarde…" : isBootstrap ? "Criar grupo e administrador" : isSignup ? "Criar conta e workspace" : "Entrar"}<ArrowRight aria-hidden="true" /></button>
      </form>
      {!isBootstrap && !isSignup && <p className="auth-recovery-hint">Primeiro acesso ou senha esquecida? Peça ao administrador do grupo um novo link de ativação.</p>}
      <div className="auth-security-note"><CheckCircle2 aria-hidden="true" /><p>O administrador define o papel, as empresas permitidas e pode revogar o acesso a qualquer momento.</p></div>
    </>
  );
}
