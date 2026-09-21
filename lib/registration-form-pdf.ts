/**
 * Extração dos campos do Registro de Empregado a partir do PDF.
 *
 * ## O problema que este módulo resolve
 *
 * `extractText` devolve o texto na ordem interna do arquivo, que **não** é a
 * ordem visual da grade. Um rótulo pode aparecer colado no valor do campo
 * vizinho, e a sequência pode saltar de uma coluna para outra. Dá para ver o
 * efeito em `lib/payroll-pdf.ts`, onde as expressões casam com coisas como
 * `Total Líquido: 1.234,56 7.890,12Sal. Base:`.
 *
 * Escrever uma expressão por campo contra uma ordem suposta seria adivinhar — e
 * a adivinhação erraria calado no dia em que a ordem mudasse.
 *
 * ## A saída: ancorar nos rótulos, não na ordem
 *
 * O conjunto de rótulos do Registro de Empregado é **fechado e conhecido** — é
 * um documento cujo conteúdo mínimo a legislação fixa. Então o algoritmo não
 * precisa saber onde cada campo está; precisa saber onde cada *rótulo* está:
 *
 *  1. procura cada rótulo no texto, do mais longo para o mais curto;
 *  2. reserva o trecho ocupado, para que um rótulo curto não case dentro de um
 *     longo — sem isso, `CTPS` casaria dentro de `Data de expedição da CTPS`;
 *  3. ordena os rótulos encontrados pela posição real no texto;
 *  4. o valor de um campo é o que existe entre o fim do seu rótulo e o começo
 *     do próximo rótulo encontrado.
 *
 * O passo 3 é o que torna a leitura independente da ordem: se a Sólides mudar a
 * sequência interna do PDF, os rótulos mudam de posição juntos e o fatiamento
 * continua certo.
 *
 * ## Por que um extrator imperfeito é seguro aqui
 *
 * Porque ele não é a última palavra. O que sai daqui passa por
 * `buildRegistrationSheet`, que confere dígito verificador de CPF, PIS, CNH,
 * título e CNPJ, e recusa como ilegível o que não fecha. Um fatiamento errado
 * em campo com dígito vira "não foi possível ler", nunca vira número errado
 * copiado para o ERP.
 *
 * Em campo de texto livre não há dígito para conferir, e por isso existem as
 * duas guardas de `plausibleValue`: valor absurdamente longo e valor que contém
 * outro rótulo são sinais de fatiamento errado, e viram ausência em vez de
 * conteúdo.
 */
import { extractText, getDocumentProxy } from "unpdf";
import type { RegistrationFormRaw } from "./employee-registration-form.ts";

/**
 * O rótulo de cada campo, exatamente como o documento o escreve.
 *
 * A chave é a mesma de `registrationFormFields`. O que não está aqui não é
 * esquecimento: ver `ambiguousLabels`.
 */
export const registrationFormLabels: Readonly<Record<string, string>> = {
  employerName: "Empregador",
  employerTaxId: "CNPJ",
  employerAddress: "Endereço",
  esocialRegistration: "Matrícula eSocial",

  fullName: "Empregado",
  beneficiaries: "Beneficiários",
  residence: "Residência",
  birthDate: "Data de nascimento",
  birthPlace: "Local do nascimento",
  nationality: "País da nacionalidade",
  maritalStatus: "Estado civil",
  fatherName: "Pai",
  motherName: "Mãe",
  race: "Cor",
  sex: "Sexo",
  education: "Grau de instrução",
  disability: "Deficiência",
  homePhone: "Telefone Residencial",
  mobilePhone: "Telefone Celular",

  identityCard: "Cédula de Identidade",
  identityIssueDate: "Data de emissão",
  identityIssuer: "Órgão/UF emissor",
  voterRegistration: "Título Eleitoral",
  voterZone: "Zona",
  voterSection: "Seção",
  professionalBoard: "Inscr. Órgão de Classe",
  ctpsNumber: "CTPS",
  ctpsSeries: "Série",
  ctpsIssueDate: "Data de expedição da CTPS",
  ctpsState: "UF CTPS",
  taxId: "CPF",
  driverLicense: "Cart. Nac. Habilitação",
  militaryDocument: "Doc. militar",

  position: "Cargo",
  jobFunction: "Função",
  cbo: "C.B.O.",
  admissionDate: "Data de Admissão",
  salary: "Salário",
  workSchedule: "Horário de Trabalho",
  breakSchedule: "Horário de Intervalo",

  fgtsOptionDate: "Opção em",
  fgtsLinkedAccountBank: "Conta vinculada no banco",
  fgtsRectificationDate: "Data da Retificação",
  pisRegisteredAt: "Cadastrado em",
  pisNumber: "Sob nº",
  bankDomicile: "Domicílio bancário",
  bankNumber: "Nº banco",
  bankBranch: "Agência código",
  bankBranchAddress: "End. da agência",
};

/**
 * Campos cujo rótulo não identifica o campo sozinho, e por isso não são lidos.
 *
 * `Categoria` aparece duas vezes na mesma ficha — uma para a habilitação, outra
 * para o documento militar. `Por` e `Nº` são curtos demais para distinguir de
 * qualquer outra ocorrência no documento.
 *
 * Eles saem em branco, e em branco é um estado honesto: a tela manda buscar na
 * origem. Chutar qual das duas `Categoria` é a da CNH produziria, na metade das
 * vezes, um valor errado com aparência de certo — que é exatamente o que a
 * ficha inteira existe para impedir.
 */
export const ambiguousLabels: Readonly<Record<string, string>> = {
  bookNumber: "Nº",
  salaryUnit: "Por",
  driverLicenseCategory: "Categoria",
  militaryCategory: "Categoria",
};

/**
 * Acento e caixa somem, e o comprimento não muda — os índices continuam valendo.
 *
 * O indicador ordinal entra no mapa por um motivo concreto: o rótulo do PIS é
 * `Sob nº`, e um gerador de PDF pode escrever esse `º` como `°`, como `o` ou
 * como nada. Sem a normalização, o rótulo não é encontrado, a fatia do campo
 * anterior engole o número do PIS e o C.B.O. sai com o PIS grudado — foi
 * exatamente o que aconteceu no primeiro ensaio deste módulo.
 */
const FOLD: Readonly<Record<string, string>> = {
  á: "a", à: "a", ã: "a", â: "a", ä: "a", é: "e", ê: "e", è: "e", ë: "e",
  í: "i", ì: "i", î: "i", ï: "i", ó: "o", ô: "o", õ: "o", ò: "o", ö: "o",
  ú: "u", ù: "u", û: "u", ü: "u", ç: "c", ñ: "n", º: "o", "°": "o", ª: "a",
};

export function foldKeepingLength(value: string) {
  let folded = "";
  for (const character of value.toLowerCase()) folded += FOLD[character] ?? character;
  return folded;
}

const isLetter = (character: string | undefined) => character !== undefined && /\p{L}/u.test(character);

/**
 * Localiza o rótulo respeitando fronteira de palavra e trechos já reservados.
 *
 * A fronteira resolve `Empregado` dentro de `Empregador`: a letra seguinte
 * impede o casamento, e o rótulo mais longo já reservou o trecho de qualquer
 * forma.
 */
function findLabel(haystack: string, needle: string, claimed: Array<{ start: number; end: number }>) {
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return -1;
    const end = index + needle.length;
    const overlaps = claimed.some((span) => index < span.end && end > span.start);
    const boundedBefore = !isLetter(haystack[index - 1]);
    const boundedAfter = !isLetter(haystack[end]);
    if (!overlaps && boundedBefore && boundedAfter) return index;
    from = index + 1;
  }
}

/** Separador residual entre rótulo e valor, que o PDF escreve de formas variadas. */
function trimValue(value: string) {
  return value.replace(/^[\s:.\-–—|]+/u, "").replace(/[\s:.\-–—|]+$/u, "").replace(/\s+/gu, " ").trim();
}

const MAX_VALUE = 220;

/**
 * Recusa o que tem cara de fatiamento errado.
 *
 * Um valor longo demais quer dizer que o próximo rótulo não foi encontrado e a
 * fatia engoliu o resto do documento. Um valor que contém outro rótulo quer
 * dizer que a fatia atravessou um campo. Nos dois casos a ausência é melhor do
 * que o conteúdo: campo vazio se denuncia a quem transcreve, campo errado não.
 */
function plausibleValue(value: string, foldedLabels: readonly string[]) {
  if (!value || value.length > MAX_VALUE) return false;
  const folded = foldKeepingLength(value);
  return !foldedLabels.some((label) => folded.includes(label));
}

/**
 * Fatia o texto do Registro de Empregado em campos.
 *
 * Recebe o texto já extraído — assim o teste da regra não precisa de PDF, e o
 * teste do PDF não precisa repetir a regra.
 */
export function extractRegistrationFields(text: string) {
  const warnings: string[] = [];
  if (!text.trim()) return { fields: {} as RegistrationFormRaw, warnings: ["O documento não tem texto legível."], found: 0 };

  const folded = foldKeepingLength(text);
  const entries = Object.entries(registrationFormLabels)
    .sort(([, a], [, b]) => b.length - a.length);

  const claimed: Array<{ start: number; end: number }> = [];
  const anchors: Array<{ key: string; start: number; end: number }> = [];
  for (const [key, label] of entries) {
    const index = findLabel(folded, foldKeepingLength(label), claimed);
    if (index < 0) {
      warnings.push(`Rótulo não encontrado no documento: ${label}.`);
      continue;
    }
    const span = { start: index, end: index + label.length };
    claimed.push(span);
    anchors.push({ key, ...span });
  }

  anchors.sort((a, b) => a.start - b.start);
  const foldedLabels = Object.values(registrationFormLabels).map(foldKeepingLength);

  const fields: RegistrationFormRaw = {};
  anchors.forEach((anchor, index) => {
    const stop = anchors[index + 1]?.start ?? text.length;
    const value = trimValue(text.slice(anchor.end, stop));
    if (!value) return;
    if (!plausibleValue(value, foldedLabels)) {
      warnings.push(`${registrationFormLabels[anchor.key]}: o trecho lido não parece ser o valor do campo.`);
      return;
    }
    fields[anchor.key] = value;
  });

  return { fields, warnings, found: anchors.length };
}

/**
 * Lê o texto do PDF. Separado da regra por ser o único ponto que toca o arquivo.
 *
 * As duas guardas vêm de `lib/payroll-pdf.ts`, e por um motivo que vale repetir:
 * o arquivo chega de um anexo, e anexo é o que alguém subiu. A assinatura
 * recusa o que não é PDF antes de entregá-lo ao leitor, e o teto de páginas
 * recusa o arquivo grande que faria a leitura consumir a requisição inteira.
 */
export async function registrationFormText(bytes: Uint8Array) {
  const signature = Buffer.from(bytes.subarray(0, 5)).toString("ascii");
  if (signature !== "%PDF-") throw new Error("O arquivo da ficha não é um PDF válido.");
  const document = await getDocumentProxy(bytes);
  if (document.numPages > 20) throw new Error("A ficha de registro deve ter no máximo 20 páginas.");
  const { text } = await extractText(document, { mergePages: true });
  return text;
}

/** Caminho completo: bytes do PDF anexado à demanda até os campos crus. */
export async function readRegistrationFormPdf(bytes: Uint8Array) {
  return extractRegistrationFields(await registrationFormText(bytes));
}
