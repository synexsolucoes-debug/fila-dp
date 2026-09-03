import { ApiError } from "./api-errors.ts";

type ConfirmationEmail = {
  to: string;
  name: string;
  confirmationUrl: string;
  idempotencyKey: string;
};

function configuration() {
  return {
    apiKey: String(process.env.RESEND_API_KEY ?? "").trim(),
    from: String(process.env.FDP_EMAIL_FROM ?? "").trim(),
  };
}

export function assertTransactionalEmailConfigured() {
  const config = configuration();
  if (config.apiKey && config.from) return config;
  if (process.env.NODE_ENV === "production") {
    throw new ApiError(503, "EMAIL_NOT_CONFIGURED", "O envio de confirmação está temporariamente indisponível.");
  }
  return config;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

/** Adaptador transacional inicial. O restante do cadastro não conhece Resend. */
export async function sendSignupConfirmationEmail(input: ConfirmationEmail) {
  const config = assertTransactionalEmailConfigured();
  if (!config.apiKey || !config.from) return { provider: "development", id: "not-sent" };

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify({
      from: config.from,
      to: [input.to],
      subject: "Confirme seu cadastro no Vinculato",
      html: `<p>Olá, ${escapeHtml(input.name)}.</p><p>Confirme seu e-mail para ativar o workspace Starter:</p><p><a href="${escapeHtml(input.confirmationUrl)}">Confirmar cadastro</a></p><p>Este link expira em 24 horas e só pode ser usado uma vez.</p>`,
    }),
  });
  if (!response.ok) {
    throw new ApiError(503, "EMAIL_DELIVERY_FAILED", "Não foi possível enviar a confirmação agora. Tente novamente em alguns minutos.");
  }
  const payload = await response.json() as { id?: string };
  return { provider: "resend", id: String(payload.id ?? "") };
}
