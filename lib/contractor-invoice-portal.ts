import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "./api-errors.ts";
import { cleanText } from "./clean-text.ts";

/**
 * O portal do prestador: as regras do link que recebe a nota fiscal.
 *
 * Até aqui a nota entrava por uma pessoa do DP. O aviso saía como texto para
 * colar no WhatsApp, o prestador respondia com o PDF anexado, e alguém abria a
 * tela de Notas Fiscais e subia o arquivo — trinta vezes, todo mês. O trabalho
 * de coletar era o gargalo do fechamento, e ele não era do prestador: era de
 * quem estava tentando fechar a competência.
 *
 * O link muda quem digita, não a regra. O envio do portal entra pelo mesmo
 * `registerInvoice` da tela: mesma verificação de duplicidade, mesma
 * substituição versionada, mesma conferência humana depois. Um canal novo que
 * escrevesse direto nas colunas do fechamento seria a segunda versão da regra,
 * e duas versões da mesma regra é como as telas passam a mostrar números
 * diferentes para o mesmo prestador.
 *
 * ## Por que o token carrega o workspace
 *
 * Toda tabela com `workspace_id` neste banco tem RLS forçada, e a CI reprova
 * quem não tiver (§8). Isso vale para a tabela de links — o que significa que
 * procurar um token *antes* de saber o workspace não devolve linha nenhuma: a
 * própria política que protege o dado impede a busca.
 *
 * Por isso o token é `<workspace>.<segredo>`. O workspace não é a proteção e
 * nunca foi: ele só diz em qual inquilino procurar, e o segredo — 32 bytes
 * aleatórios, guardado apenas como hash — é o que autoriza. O hash é calculado
 * sobre os dois juntos, então um token de um cliente não pode ser reapresentado
 * em outro nem que alguém troque o prefixo na mão.
 *
 * A alternativa seria uma segunda tabela fora da RLS, como a de recuperação de
 * acesso. Ela existe porque o login precisa resolver o token antes de haver
 * qualquer contexto; aqui há contexto, ele só precisa vir junto.
 */

/* -------------------------------------------------------------------------- */
/* Token                                                                       */
/* -------------------------------------------------------------------------- */

function portalSecret() {
  return process.env.FDP_AUTH_SECRET || (process.env.NODE_ENV === "production" ? "" : "fila-dp-local-portal-secret");
}

/** Separa o inquilino do segredo. Ponto porque não aparece em base64url. */
const SEPARATOR = ".";

export type PortalToken = { token: string; workspaceId: string; secret: string; hash: string };

/**
 * Um token novo para um link.
 *
 * O valor completo só existe aqui e na mensagem que vai ao prestador: o banco
 * guarda o hash. Um vazamento do banco não devolve nenhum link utilizável, que
 * é a mesma escolha da recuperação de acesso.
 */
export function createPortalToken(workspaceId: string): PortalToken {
  const tenant = cleanText(workspaceId, 120);
  if (!tenant) throw new Error("O link do portal exige o workspace.");
  if (tenant.includes(SEPARATOR)) throw new Error("O identificador do workspace não pode conter ponto.");
  const secret = randomBytes(32).toString("base64url");
  return { token: `${tenant}${SEPARATOR}${secret}`, workspaceId: tenant, secret, hash: hashPortalToken(tenant, secret) };
}

export function hashPortalToken(workspaceId: string, secret: string) {
  const chave = portalSecret();
  if (!chave) throw new Error("O portal do prestador exige FDP_AUTH_SECRET configurado.");
  return createHash("sha256").update(`${chave}:portal:${workspaceId}:${secret}`).digest("hex");
}

/**
 * Lê o token que veio na URL.
 *
 * Devolve `null` para qualquer coisa fora do formato, sem dizer o que estava
 * errado: quem está tentando adivinhar não deve aprender se errou o inquilino
 * ou o segredo. A rota transforma todo `null` na mesma recusa.
 */
export function parsePortalToken(value: unknown): { workspaceId: string; secret: string } | null {
  const bruto = cleanText(value, 400);
  if (!bruto) return null;
  const corte = bruto.indexOf(SEPARATOR);
  if (corte <= 0) return null;
  const workspaceId = bruto.slice(0, corte);
  const secret = bruto.slice(corte + 1);
  if (!secret || !/^[A-Za-z0-9_-]{32,}$/u.test(secret)) return null;
  return { workspaceId, secret };
}

/**
 * Compara dois hashes sem vazar em quanto tempo eles diferem.
 *
 * A busca é por índice em `token_hash`, então a comparação já aconteceu dentro
 * do banco. Esta função existe para o caminho em que o hash volta e é conferido
 * de novo na aplicação — conferir com `===` ali devolveria, pelo tempo, quantos
 * caracteres iniciais estavam certos.
 */
export function samePortalHash(left: string, right: string) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* -------------------------------------------------------------------------- */
/* Situação do link                                                            */
/* -------------------------------------------------------------------------- */

export const portalLinkStatuses = ["active", "submitted", "revoked", "expired"] as const;
export type PortalLinkStatus = (typeof portalLinkStatuses)[number];

export const portalLinkStatusLabels: Record<PortalLinkStatus, string> = {
  active: "Aguardando envio",
  submitted: "Nota recebida",
  revoked: "Revogado",
  expired: "Prazo vencido",
};

export type PortalLinkRow = {
  revoked_at?: string | Date | null;
  submitted_at?: string | Date | null;
  expires_at: string | Date;
};

/**
 * A situação de um link, na ordem em que os fatos se sobrepõem.
 *
 * Revogado vence tudo: é a decisão explícita de alguém e não deve ser apagada
 * pela passagem do prazo. Nota recebida vence o vencimento pela mesma razão
 * inversa — um link que cumpriu o que existia para cumprir não é um prazo
 * perdido, e mostrá-lo como "vencido" no mês seguinte faria o painel acusar
 * atraso onde houve entrega.
 */
export function portalLinkStatus(row: PortalLinkRow, now = new Date()): PortalLinkStatus {
  if (row.revoked_at) return "revoked";
  if (row.submitted_at) return "submitted";
  return new Date(row.expires_at).getTime() <= now.getTime() ? "expired" : "active";
}

/** Só o link ativo aceita envio. Os outros três recusam, cada um por um motivo. */
export function assertPortalLinkUsable(row: PortalLinkRow, now = new Date()) {
  const status = portalLinkStatus(row, now);
  if (status === "active") return;
  if (status === "revoked") {
    throw new ApiError(410, "PORTAL_LINK_REVOKED",
      "Este link foi cancelado pela empresa. Procure quem cuida do pagamento para receber um novo.");
  }
  if (status === "expired") {
    throw new ApiError(410, "PORTAL_LINK_EXPIRED",
      "O prazo deste link terminou. Procure quem cuida do pagamento para receber um novo.");
  }
  throw new ApiError(409, "PORTAL_LINK_SUBMITTED",
    "A nota deste link já foi recebida. Se precisar substituí-la, procure quem cuida do pagamento.");
}

/* -------------------------------------------------------------------------- */
/* Prazo                                                                       */
/* -------------------------------------------------------------------------- */

/** Dias de vida do link quando quem gera não escolhe outro prazo. */
export const PORTAL_DEFAULT_DAYS = 10;
const MAX_DAYS = 90;

/**
 * O prazo do link, em dias a partir de agora.
 *
 * Tem teto porque um link sem fim é uma credencial permanente entregue por
 * WhatsApp — e o prazo é justamente o que faz um link vazado deixar de valer
 * sozinho, sem depender de alguém lembrar de revogá-lo.
 */
export function portalExpiryFromDays(days: unknown, now = new Date()) {
  const bruto = Number(days);
  const dias = Number.isFinite(bruto) && bruto > 0 ? Math.min(Math.floor(bruto), MAX_DAYS) : PORTAL_DEFAULT_DAYS;
  return new Date(now.getTime() + dias * 24 * 60 * 60 * 1000);
}

/* -------------------------------------------------------------------------- */
/* Endereço                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * O endereço que o prestador recebe.
 *
 * Sem `FDP_APP_URL` configurado não há link para mandar — e devolver um caminho
 * relativo seria pior que recusar: ele seria colado no WhatsApp e não abriria
 * nada, com o erro aparecendo do lado de quem não pode corrigi-lo.
 */
export function portalLinkUrl(token: string, baseUrl = process.env.FDP_APP_URL ?? "") {
  const base = cleanText(baseUrl, 400).replace(/\/+$/u, "");
  if (!base) {
    throw new ApiError(500, "APP_URL_NOT_CONFIGURED",
      "Configure FDP_APP_URL para gerar o link do portal do prestador.");
  }
  return `${base}/portal/nota/${encodeURIComponent(token)}`;
}
