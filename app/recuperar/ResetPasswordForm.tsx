"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";

export function ResetPasswordForm({ token, email }: { token: string; email: string }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmation) { setError("As senhas não conferem."); return; }
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, email, password }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Não foi possível redefinir a senha.");
      setSuccess(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível redefinir a senha.");
    } finally { setBusy(false); }
  }

  if (!token) return <div className="recovery-state"><h2>Link de recuperação ausente</h2><p>Solicite ao administrador do workspace um novo link de redefinição de senha.</p><Link className="button auth-primary" href="/login">Voltar ao login</Link></div>;
  if (success) return <div className="recovery-state"><span className="auth-status"><i /> Senha atualizada</span><h2>Acesso redefinido.</h2><p>Sua nova senha já está ativa. Entre novamente para continuar.</p><Link className="button auth-primary" href="/login">Ir para o login</Link></div>;
  return <><span className="auth-status neutral">Recuperação segura</span><h2>Crie uma nova senha</h2><p>Este link é válido por 30 minutos e pode ser usado uma única vez.</p><form className="auth-login-form" onSubmit={submit}><label>E-mail<input value={email} readOnly autoComplete="email" /></label><label>Nova senha<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" minLength={8} autoComplete="new-password" required /><small>Mínimo de 8 caracteres.</small></label><label>Confirmar nova senha<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} type="password" minLength={8} autoComplete="new-password" required /></label>{error && <p className="auth-login-error" role="alert">{error}</p>}<button className="button auth-primary" disabled={busy}>{busy ? "Atualizando…" : "Redefinir senha"}</button></form><Link className="auth-secondary-link" href="/login">Voltar ao login</Link></>;
}
