import { createHash } from "node:crypto";
import { getD1 } from "../db/index.ts";
import { log } from "./observability.ts";

/**
 * Trilha de autenticação (§40).
 *
 * A auditoria de negócio (`fdp_audit_events`) exige workspace, e o login
 * acontece antes de existir um — quem pertence a vários grupos não tem um
 * "correto" a que atribuir o evento. Por isso os eventos de acesso têm tabela
 * própria, e por isso esta função existe em vez de reaproveitar
 * `prepareAuditEvent`.
 *
 * Regra de ouro deste módulo: **registrar nunca derruba o acesso**. Uma trilha
 * que impede alguém de entrar quando o banco engasga troca um problema de
 * observabilidade por um de disponibilidade. A falha é registrada no log
 * estruturado, onde acende sem trancar a porta.
 */

export type AuthAction = "login" | "logout" | "password_reset" | "session_revoked"
  | "signup_requested" | "signup_confirmed" | "signup_confirmation_resent";
export type AuthOutcome = "success" | "denied" | "failure";

/**
 * IP e agente entram como hash: servem para correlacionar tentativas — "a mesma
 * origem tentou doze e-mails" — sem guardar o endereço em claro numa tabela que
 * já contém e-mail. O segredo de sessão é a chave; sem ele o hash não é
 * reversível por quem só tiver o banco.
 */
function fingerprint(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const secret = String(process.env.FDP_PII_HASH_SECRET ?? process.env.FDP_AUTH_SECRET ?? "");
  return createHash("sha256").update(`${secret}:${trimmed}`).digest("hex").slice(0, 40);
}

export type AuthEventInput = {
  action: AuthAction;
  outcome: AuthOutcome;
  email: string;
  /** Ausente quando a tentativa foi contra um e-mail que não existe. */
  userId?: string | null;
  /** Motivo legível da recusa. Nunca detalhe que ajude quem sonda. */
  reason?: string;
  address?: string;
  userAgent?: string;
  requestId?: string | null;
};

export async function recordAuthEvent(event: AuthEventInput) {
  try {
    await getD1().prepare(`INSERT INTO fdp_auth_events
      (id, user_id, email, action, outcome, reason, ip_hash, user_agent_hash, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        crypto.randomUUID(),
        event.userId ?? null,
        event.email.trim().toLowerCase().slice(0, 200),
        event.action,
        event.outcome,
        (event.reason ?? "").slice(0, 200),
        fingerprint(event.address ?? ""),
        fingerprint(event.userAgent ?? ""),
        (event.requestId ?? "").slice(0, 100),
      )
      .run();
  } catch (error) {
    // Sem `throw`: ver o parágrafo no topo. O evento perdido aparece aqui.
    log("error", "auth.event_not_recorded", {}, {
      action: event.action,
      outcome: event.outcome,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message.slice(0, 300) : undefined,
    });
  }
}
