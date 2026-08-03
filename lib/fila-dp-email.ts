type TransactionalEmail = {
  to: string;
  subject: string;
  preheader: string;
  title: string;
  paragraphs: string[];
  actionLabel?: string;
  actionUrl?: string;
  idempotencyKey: string;
};

export type EmailDeliveryResult = {
  status: "sent" | "not_configured" | "failed";
  providerId?: string;
  error?: string;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character] ?? character);
}

function emailHtml(message: TransactionalEmail) {
  const action = message.actionLabel && message.actionUrl
    ? `<p style="margin:28px 0"><a href="${escapeHtml(message.actionUrl)}" style="display:inline-block;padding:13px 20px;border-radius:12px;background:#0E3B3B;color:#fff;text-decoration:none;font-weight:700">${escapeHtml(message.actionLabel)}</a></p>`
    : "";
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(message.subject)}</title></head><body style="margin:0;background:#F6F3EC;color:#1F2937;font-family:Arial,sans-serif"><div style="display:none;max-height:0;overflow:hidden">${escapeHtml(message.preheader)}</div><main style="max-width:600px;margin:0 auto;padding:32px 18px"><section style="padding:32px;border:1px solid #d8ded8;border-radius:16px;background:#fff"><p style="margin:0 0 24px;color:#0E3B3B;font-size:20px;font-weight:800">Fila <span style="color:#28a886">DP</span></p><h1 style="margin:0 0 18px;font-size:25px;line-height:1.25">${escapeHtml(message.title)}</h1>${message.paragraphs.map((paragraph) => `<p style="margin:0 0 14px;color:#4b5563;font-size:15px;line-height:1.6">${escapeHtml(paragraph)}</p>`).join("")}${action}<p style="margin:26px 0 0;color:#7b8490;font-size:12px;line-height:1.5">Se você não reconhece esta solicitação, ignore esta mensagem. Nunca compartilhe sua senha.</p></section></main></body></html>`;
}

export async function sendTransactionalEmail(message: TransactionalEmail): Promise<EmailDeliveryResult> {
  const apiKey = process.env.RESEND_API_KEY ?? "";
  if (!apiKey) return { status: "not_configured" };

  const from = process.env.FDP_EMAIL_FROM || "Fila DP <onboarding@resend.dev>";
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": message.idempotencyKey.slice(0, 256),
      },
      body: JSON.stringify({ from, to: [message.to], subject: message.subject, html: emailHtml(message) }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({})) as { id?: string; message?: string; error?: { message?: string } };
    if (!response.ok) return { status: "failed", error: payload.error?.message || payload.message || `Resend respondeu com status ${response.status}.` };
    return { status: "sent", providerId: payload.id };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : "Falha ao enviar e-mail." };
  }
}

