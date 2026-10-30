/**
 * Quem um `@` no comentário alcança.
 *
 * A rota de comentários procurava o membro com `lower(name) LIKE '%texto%'`.
 * `@ana` avisava Ana, Mariana, Juliana e Luciana; `_` é curinga do `LIKE` e a
 * expressão aceitava o caractere, então `@a_a` casava com quase todo mundo. No
 * DP o comentário fala de salário, afastamento e rescisão — avisar a pessoa
 * errada não é ruído, é dado pessoal chegando a quem não tem nada com a
 * demanda (§18 de `docs/engenharia-reversa-trello.md`).
 *
 * O Trello resolve com nome de usuário único. O Vinculato não tem nome de
 * usuário, então a menção casa com o nome por **igualdade**, nunca por trecho:
 *
 * - `@ana` casa com quem tem "Ana" como **primeiro nome**;
 * - `@ana.paula`, `@ana_paula`, `@ana-paula` e `@anapaula` casam com quem tem
 *   "Ana Paula" como começo do nome (as palavras inteiras, na ordem);
 * - sem acento e sem caixa dos dois lados, porque quem digita com pressa
 *   escreve `@joao` para João.
 *
 * E a regra que fecha o defeito: **se mais de uma pessoa casar, ninguém é
 * avisado** e a menção volta como ambígua, para a tela pedir o nome mais
 * completo. Avisar as duas é exatamente o erro que isto corrige.
 *
 * Quem não pode ver a demanda (sem acesso à empresa dela) não é avisado mesmo
 * que o nome case: a notificação carrega o título da demanda.
 */

export type MentionCandidate = {
  userId: string;
  name: string;
  /** Pode abrir a demanda: administrador ou com acesso à empresa dela. */
  canSeeCard: boolean;
};

export type MentionResolution = {
  /** Ids a notificar, sem repetição e sem o autor. */
  userIds: string[];
  /** Menções que casaram com mais de uma pessoa — ninguém foi avisado. */
  ambiguous: string[];
  /** Menções que não casaram com ninguém. */
  unknown: string[];
  /** Menções de quem não tem acesso à demanda — ninguém foi avisado. */
  withoutAccess: string[];
};

const MENTION = /(?:^|[^\p{L}0-9@])@([\p{L}0-9][\p{L}0-9._-]{0,79})/gu;
const SEPARATOR = /[._-]+/gu;
const MAX_MENTIONS = 10;

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase();
}

function nameWords(name: string): string[] {
  return normalize(name).split(/[^\p{L}0-9]+/u).filter(Boolean);
}

/** As menções do texto, como foram escritas, sem repetição (pela forma normalizada). */
export function extractMentions(body: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of body.matchAll(MENTION)) {
    const raw = match[1].replace(/[._-]+$/u, "");
    const key = normalize(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(raw);
    if (result.length >= MAX_MENTIONS) break;
  }
  return result;
}

/** Se a menção, já normalizada, nomeia esta pessoa. */
export function mentionMatchesName(mention: string, name: string): boolean {
  const words = nameWords(name);
  if (!words.length) return false;
  const parts = normalize(mention).split(SEPARATOR).filter(Boolean);
  if (!parts.length) return false;
  if (parts.length > 1) {
    return parts.length <= words.length && parts.every((part, index) => words[index] === part);
  }
  const [token] = parts;
  if (words[0] === token) return true;
  /* `@anapaula`: as primeiras palavras, coladas. Uma palavra só não entra
     aqui (já foi o caso acima), então "Ana" nunca casa por prefixo. */
  let joined = "";
  for (const word of words) {
    joined += word;
    if (joined === token && joined !== words[0]) return true;
    if (joined.length >= token.length) break;
  }
  return false;
}

export function resolveMentions(
  body: string,
  candidates: readonly MentionCandidate[],
  authorUserId: string,
): MentionResolution {
  const result: MentionResolution = { userIds: [], ambiguous: [], unknown: [], withoutAccess: [] };
  const others = candidates.filter((candidate) => candidate.userId !== authorUserId);
  const ids = new Set<string>();
  for (const mention of extractMentions(body)) {
    const matches = others.filter((candidate) => mentionMatchesName(mention, candidate.name));
    if (!matches.length) {
      /* O autor se mencionando não é "desconhecido": só não há quem avisar. */
      const self = candidates.some((candidate) => candidate.userId === authorUserId && mentionMatchesName(mention, candidate.name));
      if (!self) result.unknown.push(mention);
      continue;
    }
    if (matches.length > 1) { result.ambiguous.push(mention); continue; }
    const [person] = matches;
    if (!person.canSeeCard) { result.withoutAccess.push(mention); continue; }
    ids.add(person.userId);
  }
  result.userIds = [...ids];
  return result;
}

/** A frase que a tela mostra depois de publicar, ou vazio quando tudo casou. */
export function mentionWarning(resolution: Pick<MentionResolution, "ambiguous" | "unknown" | "withoutAccess">): string {
  const parts: string[] = [];
  const list = (items: string[]) => items.map((item) => `@${item}`).join(", ");
  if (resolution.ambiguous.length) parts.push(`${list(resolution.ambiguous)} combina com mais de uma pessoa — escreva o nome completo, como @ana.paula`);
  if (resolution.unknown.length) parts.push(`${list(resolution.unknown)} não é ninguém do workspace`);
  if (resolution.withoutAccess.length) parts.push(`${list(resolution.withoutAccess)} não tem acesso à empresa desta demanda`);
  return parts.length ? `Comentário publicado, mas ninguém foi avisado por ${parts.join("; ")}.` : "";
}
