import { ApiError } from "./api-errors.ts";

/**
 * O adaptador transacional (Resend), e o mesmo caminho para os três e-mails
 * que o produto envia.
 *
 * Até aqui só existia um: a confirmação de cadastro (§80). Convite de membro e
 * link de recuperação de acesso **geravam o link e paravam** — a tela devolvia
 * a URL para o administrador copiar e mandar por fora, exatamente a lacuna que
 * a auditoria de 11/08 nomeou (W6: "não existe e-mail transacional em nenhum
 * ponto do produto além da confirmação de cadastro").
 *
 * A diferença de postura entre os três importa:
 *
 * - **Confirmação de cadastro** é a própria razão de a requisição existir: sem
 *   e-mail configurado, `assertTransactionalEmailConfigured` recusa a
 *   requisição em produção, porque não há outro caminho para confirmar.
 * - **Convite** e **recuperação de acesso** continuam funcionando sem e-mail
 *   nenhum configurado — é assim hoje, e não pode deixar de ser: o
 *   administrador sempre pôde copiar o link e mandar por fora. O envio aqui é
 *   um canal **a mais**, nunca uma trava a mais. Por isso as duas nunca
 *   lançam: `dispatchTransactionalEmail` devolve o resultado, e quem chama
 *   decide o que fazer com uma falha — a resposta da rota continua sendo o
 *   convite ou o link criado, com ou sem e-mail.
 */

export type TransactionalEmail = {
  to: string;
  subject: string;
  html: string;
  /** A mesma ocorrência não pode virar duas mensagens por retentativa. */
  idempotencyKey: string;
};

export type TransactionalEmailResult = { provider: "resend" | "development"; id: string };

function configuration() {
  return {
    apiKey: String(process.env.RESEND_API_KEY ?? "").trim(),
    from: String(process.env.FDP_EMAIL_FROM ?? "").trim(),
  };
}

/** Verdadeiro só quando existe provedor e remetente configurados. */
export function transactionalEmailConfigured() {
  const config = configuration();
  return Boolean(config.apiKey && config.from);
}

/**
 * Exige o provedor configurado, e só faz sentido para o e-mail que **é** o
 * motivo da requisição — hoje, só a confirmação de cadastro. Convite e
 * recuperação de acesso não chamam isto: eles continuam sem e-mail algum.
 */
export function assertTransactionalEmailConfigured() {
  const config = configuration();
  if (config.apiKey && config.from) return config;
  if (process.env.NODE_ENV === "production") {
    throw new ApiError(503, "EMAIL_NOT_CONFIGURED", "O envio de confirmação está temporariamente indisponível.");
  }
  return config;
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

/**
 * O único ponto que fala com o Resend.
 *
 * Sem provedor configurado, devolve "development" em vez de lançar — é o que
 * permite convite e recuperação seguirem funcionando (só) pelo link em
 * qualquer ambiente sem `RESEND_API_KEY`. Quem precisa que a ausência de
 * e-mail seja um erro (a confirmação de cadastro) já recusou antes de chegar
 * aqui, em `assertTransactionalEmailConfigured`.
 */
export async function dispatchTransactionalEmail(input: TransactionalEmail): Promise<TransactionalEmailResult> {
  const config = configuration();
  if (!config.apiKey || !config.from) return { provider: "development", id: "not-sent" };

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify({ from: config.from, to: [input.to], subject: input.subject, html: input.html }),
  });
  if (!response.ok) {
    throw new ApiError(503, "EMAIL_DELIVERY_FAILED", "Não foi possível enviar o e-mail agora. Tente novamente em alguns minutos.");
  }
  const payload = await response.json() as { id?: string };
  return { provider: "resend", id: String(payload.id ?? "") };
}

type ConfirmationEmail = {
  to: string;
  name: string;
  confirmationUrl: string;
  idempotencyKey: string;
};

/** Adaptador transacional inicial. O restante do cadastro não conhece Resend. */
export async function sendSignupConfirmationEmail(input: ConfirmationEmail) {
  assertTransactionalEmailConfigured();
  return dispatchTransactionalEmail({
    to: input.to,
    subject: "Confirme seu cadastro no Vinculato",
    html: `<p>Olá, ${escapeHtml(input.name)}.</p><p>Confirme seu e-mail para ativar o workspace Starter:</p><p><a href="${escapeHtml(input.confirmationUrl)}">Confirmar cadastro</a></p><p>Este link expira em 24 horas e só pode ser usado uma vez.</p>`,
    idempotencyKey: input.idempotencyKey,
  });
}

type ActivationEmail = {
  to: string;
  name: string;
  activationUrl: string;
  idempotencyKey: string;
};

/**
 * Convite de membro (§ "Usuários e permissões").
 *
 * Nunca lança: quem chama já criou o vínculo e a resposta da rota é o convite
 * em si. Uma falha aqui vira log e o administrador continua com o link para
 * copiar — o e-mail é conforto a mais, não um pré-requisito novo.
 */
export async function sendMemberActivationEmail(input: ActivationEmail): Promise<TransactionalEmailResult | null> {
  if (!transactionalEmailConfigured()) return null;
  return dispatchTransactionalEmail({
    to: input.to,
    subject: "Você foi convidado para o Vinculato",
    html: `<p>Olá, ${escapeHtml(input.name)}.</p><p>Você foi convidado para acessar o Vinculato. Defina sua senha para começar:</p><p><a href="${escapeHtml(input.activationUrl)}">Definir senha e entrar</a></p><p>Este link expira em 30 minutos e só pode ser usado uma vez. Se expirar, peça a quem administra o grupo para gerar um novo.</p>`,
    idempotencyKey: input.idempotencyKey,
  });
}

type RecoveryEmail = {
  to: string;
  name: string;
  recoveryUrl: string;
  idempotencyKey: string;
};

/**
 * Link de recuperação de acesso, gerado por um administrador para um membro
 * já existente (`POST /api/members/[id]/recovery`) — não é "esqueci minha
 * senha" autosserviço, que ainda não existe (W3 da auditoria de 11/08): é o
 * administrador decidindo mandar um link novo para alguém específico. Mesma
 * postura de nunca lançar da ativação.
 */
export async function sendAccessRecoveryEmail(input: RecoveryEmail): Promise<TransactionalEmailResult | null> {
  if (!transactionalEmailConfigured()) return null;
  return dispatchTransactionalEmail({
    to: input.to,
    subject: "Link para redefinir seu acesso ao Vinculato",
    html: `<p>Olá, ${escapeHtml(input.name)}.</p><p>Um administrador do seu grupo gerou um novo link de acesso para você:</p><p><a href="${escapeHtml(input.recoveryUrl)}">Redefinir senha e entrar</a></p><p>Este link expira em 30 minutos e só pode ser usado uma vez. Se expirar, peça a quem administra o grupo para gerar outro.</p>`,
    idempotencyKey: input.idempotencyKey,
  });
}
