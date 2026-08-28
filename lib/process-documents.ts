/**
 * Conferência de documento obrigatório (§26).
 *
 * ## O problema que este módulo resolve
 *
 * Até aqui, "documento obrigatório" virava item de checklist: a etapa não
 * avançava com item em aberto, mas **marcar é declarar, não provar**. Só
 * `evidenceRequired` olhava se havia anexo — e por contagem total da demanda,
 * de modo que um único comprovante de residência satisfazia a exigência de sete
 * documentos. Para uma admissão que vai ser auditada, isso é a diferença entre
 * ter a papelada e dizer que tem.
 *
 * ## Por que a mudança é opcional por etapa
 *
 * Ligar a conferência para todo mundo travaria demanda que hoje anda: processos
 * em execução têm etapas cujo documento foi marcado sem anexo, e uma regra nova
 * aplicada ao passado transforma trabalho em andamento em trabalho parado. A
 * etapa declara como quer ser conferida — `declared` é o comportamento de
 * sempre e continua sendo o padrão. Quem quiser rigor liga `attached` na versão
 * nova do processo, e as demandas já instanciadas seguem na versão que
 * instanciaram (§29).
 *
 * ## Por que casar por nome de arquivo
 *
 * `fdp_card_attachments` guarda `filename`, não tipo de documento. Criar uma
 * tabela de classificação seria o desenho certo se alguém fosse classificar —
 * mas quem anexa está com pressa, e um campo a mais no upload vira campo
 * ignorado. O nome do arquivo é o que a pessoa já escreve, então é nele que a
 * conferência olha.
 *
 * O casamento é por **palavra significativa**, não por igualdade: "Comprovante
 * de residência" é atendido por `comprovante-residencia-joao.pdf` e por
 * `Comprovante de Residencia.PDF`, e não por `contrato.pdf`. Exigir o nome
 * exato reprovaria arquivo legítimo, e comparar só o começo aceitaria qualquer
 * coisa — os dois erros terminam com alguém desligando a conferência.
 */

/** Como a etapa confere os documentos que exige. */
export const DOCUMENT_PROOFS = ["declared", "attached"] as const;
export type DocumentProof = (typeof DOCUMENT_PROOFS)[number];

/** `declared` é o comportamento anterior, e continua sendo o padrão (§48). */
export const DEFAULT_DOCUMENT_PROOF: DocumentProof = "declared";

export function parseDocumentProof(raw: unknown): DocumentProof {
  const value = String(raw ?? "").trim().toLowerCase();
  return (DOCUMENT_PROOFS as readonly string[]).includes(value)
    ? value as DocumentProof
    : DEFAULT_DOCUMENT_PROOF;
}

/**
 * Palavras que não distinguem um documento de outro.
 *
 * Sem elas, "Comprovante **de** residência" exigiria a partícula no nome do
 * arquivo, e `comprovante-residencia.pdf` — o nome que as pessoas realmente
 * escrevem — seria recusado.
 */
const STOPWORDS = new Set([
  "de", "da", "do", "das", "dos", "e", "a", "o", "as", "os",
  "em", "no", "na", "nos", "nas", "para", "por", "com", "ao", "aos",
]);

/** Extensões que não fazem parte do nome do documento. */
const EXTENSION = /\.[a-z0-9]{1,5}$/u;

/**
 * Texto comparável: sem acento, sem caixa, sem pontuação.
 *
 * A normalização precisa ser a mesma dos dois lados — documento e arquivo —
 * senão a conferência dependeria de quem digitou ter usado cedilha.
 */
export function normalizeDocumentText(value: string): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

/**
 * As palavras que identificam o documento.
 *
 * Quando o nome só tem partícula ou número curto — "de", "2" — não sobra
 * palavra significativa; nesse caso o nome inteiro normalizado é usado, para a
 * exigência não virar impossível de atender nem passar de graça.
 */
export function documentTokens(name: string): string[] {
  const normalized = normalizeDocumentText(name).replace(EXTENSION, "");
  const words = normalized.split(" ").filter(Boolean);
  const significant = words.filter((word) => word.length > 1 && !STOPWORDS.has(word));
  return significant.length ? significant : words;
}

/**
 * Um arquivo atende um documento quando o nome dele traz todas as palavras
 * significativas do documento.
 *
 * "Todas", e não "alguma": com "alguma", `contrato.pdf` atenderia "Contrato de
 * experiência" e "Contrato social" ao mesmo tempo, e a conferência viraria
 * teatro.
 */
export function attachmentMatchesDocument(filename: string, document: string): boolean {
  const tokens = documentTokens(document);
  if (!tokens.length) return false;
  const haystack = normalizeDocumentText(filename);
  if (!haystack) return false;
  const words = new Set(haystack.split(" ").filter(Boolean));
  // A palavra pode aparecer inteira ou dentro de outra ("residencia" em
  // "comprovanteresidencia"), porque quem nomeia arquivo junta tudo às vezes.
  return tokens.every((token) => words.has(token) || haystack.includes(token));
}

/**
 * Os documentos exigidos que nenhum anexo atende.
 *
 * Um mesmo arquivo pode atender mais de um documento: um PDF chamado
 * "CPF e RG.pdf" é uma juntada legítima, e recusá-la obrigaria a pessoa a
 * separar páginas para satisfazer o sistema — trabalho que existe só por causa
 * da regra.
 */
export function missingDocuments(
  required: readonly string[],
  filenames: readonly string[],
): string[] {
  const names = filenames.map((item) => String(item ?? "")).filter(Boolean);
  return required
    .map((item) => String(item ?? "").trim())
    .filter((document) => document
      && !names.some((filename) => attachmentMatchesDocument(filename, document)));
}

/** O motivo do bloqueio, escrito para quem precisa resolver — não para o log. */
export function describeMissingDocuments(missing: readonly string[]): string {
  if (missing.length === 1) {
    return `Esta etapa exige o documento "${missing[0]}" anexado à demanda.`;
  }
  return `Esta etapa exige ${missing.length} documentos ainda não anexados: ${missing.join(", ")}.`;
}
