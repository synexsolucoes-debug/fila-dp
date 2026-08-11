/**
 * Limite de privacidade do assistente.
 *
 * Este módulo é a razão de o assistente poder existir num sistema que guarda
 * CPF, dados bancários e salário. Ele não é um filtro de conveniência: é a
 * fronteira entre o que fica no ambiente do cliente e o que sai para um
 * provedor de modelo — que é infraestrutura de terceiro, ainda que contratada.
 *
 * Duas decisões que sustentam o resto:
 *
 *   1. **Redigir na saída, não confiar na entrada.** Todo texto que sai passa
 *      por aqui, inclusive o que o próprio usuário digitou. Se alguém colar um
 *      CPF na pergunta, ele não vai junto.
 *   2. **Falso positivo é aceitável; falso negativo não.** Redigir um número de
 *      protocolo por engano atrapalha uma resposta. Deixar vazar um CPF é
 *      incidente. Os padrões são deliberadamente amplos.
 *
 * O que este módulo NÃO faz: decidir o que o assistente pode ler do banco. Isso
 * é `lib/assistant/context.ts`, e a regra lá é mais simples ainda — dado
 * pessoal de colaborador e prestador não entra no contexto, redigido ou não.
 */

export type RedactionKind =
  | "cpf" | "cnpj" | "pis" | "cartao" | "iban" | "agencia_conta"
  | "email" | "telefone" | "chave_pix" | "valor";

export type RedactionHit = { kind: RedactionKind; count: number };

export type RedactionResult = {
  text: string;
  hits: RedactionHit[];
  /** `true` quando alguma coisa foi redigida — o registro guarda isso. */
  redacted: boolean;
};

/**
 * A ordem importa: padrões mais específicos primeiro.
 *
 * CNPJ antes de CPF porque um CNPJ contém uma sequência que casaria com CPF;
 * cartão antes de valores porque um número de cartão formatado com espaços
 * pareceria vários números soltos.
 */
const PATTERNS: Array<{ kind: RedactionKind; pattern: RegExp; label: string }> = [
  // 00.000.000/0000-00 ou 14 dígitos seguidos.
  { kind: "cnpj", pattern: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/gu, label: "[CNPJ]" },
  // 000.000.000-00 ou 11 dígitos seguidos.
  { kind: "cpf", pattern: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/gu, label: "[CPF]" },
  // PIS/PASEP: 11 dígitos com máscara própria.
  { kind: "pis", pattern: /\b\d{3}\.\d{5}\.\d{2}-\d\b/gu, label: "[PIS]" },
  // Cartão: 13 a 19 dígitos, com ou sem separador.
  { kind: "cartao", pattern: /\b(?:\d[ -]?){13,19}\b/gu, label: "[CARTÃO]" },
  { kind: "iban", pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/gu, label: "[IBAN]" },
  // Agência e conta, o formato que aparece em ficha bancária.
  { kind: "agencia_conta", pattern: /\b\d{3,5}-?\d?\s*\/\s*\d{4,12}-?\d?\b/gu, label: "[CONTA]" },
  { kind: "email", pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gu, label: "[E-MAIL]" },
  // Telefone brasileiro com DDD, com ou sem máscara.
  { kind: "telefone", pattern: /\(?\b\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/gu, label: "[TELEFONE]" },
  // Chave Pix aleatória (UUID).
  { kind: "chave_pix", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, label: "[CHAVE PIX]" },
  // Dinheiro: R$ seguido de valor. Salário e pagamento saem daqui.
  { kind: "valor", pattern: /R\$\s?\d{1,3}(?:\.\d{3})*(?:,\d{2})?/gu, label: "[VALOR]" },
];

/**
 * Redige o que não pode sair do ambiente.
 *
 * Devolve também o que foi encontrado, para que o registro da conversa possa
 * dizer "houve redação" sem guardar o que foi redigido — e para que a auditoria
 * consiga responder se o limite foi acionado alguma vez.
 */
export function redact(input: string): RedactionResult {
  let text = String(input ?? "");
  const hits: RedactionHit[] = [];

  for (const { kind, pattern, label } of PATTERNS) {
    let count = 0;
    text = text.replace(pattern, (match) => {
      // Sequências curtas de dígitos com separador são data, não cartão. Sem
      // esta exceção, "12-05-2026" viraria [CARTÃO] em toda pergunta sobre prazo.
      if (kind === "cartao" && match.replace(/\D/gu, "").length < 13) return match;
      count += 1;
      return label;
    });
    if (count > 0) hits.push({ kind, count });
  }

  return { text, hits, redacted: hits.length > 0 };
}

/** Redige uma estrutura inteira, campo a campo, preservando o formato. */
export function redactDeep<T>(value: T): { value: T; hits: RedactionHit[] } {
  const all: RedactionHit[] = [];
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const result = redact(node);
      all.push(...result.hits);
      return result.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, item]) => [key, walk(item)]));
    }
    return node;
  };
  const redacted = walk(value) as T;
  // Agrega as ocorrências por tipo: dez CPFs em campos diferentes são uma
  // informação só para quem audita.
  const merged = new Map<RedactionKind, number>();
  for (const hit of all) merged.set(hit.kind, (merged.get(hit.kind) ?? 0) + hit.count);
  return { value: redacted, hits: [...merged].map(([kind, count]) => ({ kind, count })) };
}

/**
 * Campos que nunca podem aparecer no contexto, nem redigidos.
 *
 * A redação protege contra o dado que aparece por acidente dentro de um texto.
 * Estes nomes são o contrário: campos cuja presença já indica que alguém montou
 * o contexto errado. Aqui a resposta é falhar, não limpar.
 */
export const FORBIDDEN_CONTEXT_FIELDS = [
  "password_hash", "password_salt", "payout_encrypted", "payout_iv", "payout_tag",
  "tax_id", "taxId", "cpf", "cnpj", "salary", "base_amount", "net_amount",
  "bank_account", "bankAccount", "agency", "pix",
] as const;

export class ContextLeakError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`O contexto do assistente não pode conter "${field}".`);
    this.name = "ContextLeakError";
    this.field = field;
  }
}

/**
 * Recusa um contexto que carregue campo proibido, em qualquer profundidade.
 *
 * É uma checagem de programação, não de entrada do usuário: ela existe para que
 * um `SELECT *` acrescentado no futuro quebre em teste, e não em produção com
 * o dado já a caminho do provedor.
 */
export function assertNoForbiddenFields(value: unknown, path = "contexto"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenFields(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if ((FORBIDDEN_CONTEXT_FIELDS as readonly string[]).includes(key)) {
      throw new ContextLeakError(`${path}.${key}`);
    }
    assertNoForbiddenFields(item, `${path}.${key}`);
  }
}
