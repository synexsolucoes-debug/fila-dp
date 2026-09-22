/**
 * Campos sugeridos a partir do OCR de uma foto de documento (RG, CTPS).
 *
 * ## Por que é "sugestão", nunca "leitura"
 *
 * A ficha de contratação (`employee-registration-form.ts`) lê o Registro de
 * Empregado — um formulário burocrático cujo layout é fixo e cujo conteúdo a
 * legislação define. Uma foto de RG ou CTPS não tem essa garantia: o layout
 * varia por estado, a foto pode estar torta, embaçada ou com reflexo, e o OCR
 * erra dígito com muito mais frequência do que a extração de um PDF com texto
 * selecionável.
 *
 * Por isso este módulo não alimenta a ficha diretamente — ele produz
 * candidatos que a tela mostra ao lado do campo em branco, com a foto
 * disponível para conferência, e que só entram na ficha se uma pessoa
 * confirmar (pelo mesmo caminho de "Corrigir/Preencher" que já existe). Nunca
 * há envio automático ao ERP a partir de um valor que só passou por OCR.
 *
 * ## Por que só CPF, PIS, nome e data de nascimento
 *
 * CPF e PIS têm dígito verificador: dá para confirmar matematicamente que o
 * número lido é plausível, então valem o pattern-match mesmo sem rótulo por
 * perto — é o mesmo raciocínio de `isValidCpf`/`isValidPis` na ficha do PDF.
 *
 * Nome e data de nascimento vêm de um rótulo bem padronizado em RG e CTPS
 * ("Nome", "Data de nascimento") e por isso valem a extração por âncora
 * (`sliceByLabels`, a mesma técnica da ficha em PDF) — mas nome é texto livre,
 * sem dígito para conferir, e por isso nunca sai com confiança alta.
 *
 * Número de CTPS, série, RG e o resto ficam de fora de propósito: são campos
 * curtos, sem dígito verificador confiável, e o rótulo no cartão físico é
 * ambíguo demais (a mesma armadilha que `ambiguousLabels` já documenta para o
 * PDF). Chutar aqui produziria, na metade das vezes, um valor com aparência de
 * certo — e é exatamente isso que a leitura por OCR não pode fazer sozinha.
 */
import { isValidPis, isValidRegistrationDate } from "./employee-registration-form.ts";
import { sliceByLabels } from "./label-anchored-text.ts";
import { isValidCpf } from "./registrations.ts";

export type PhotoFieldConfidence = "ok" | "low";

export type PhotoFieldSuggestion = { value: string; confidence: PhotoFieldConfidence };

export type PhotoFieldSuggestions = Partial<Record<"taxId" | "pisNumber" | "fullName" | "birthDate", PhotoFieldSuggestion>>;

/** Rótulos padronizados de RG e CTPS que identificam nome e nascimento sem ambiguidade. */
const identityLabels: Readonly<Record<string, string>> = {
  fullName: "Nome",
  birthDate: "Data de Nascimento",
};

const digitsOnly = (value: string) => value.replace(/\D/gu, "");

/**
 * Varre `text` por sequências de 11 dígitos (com ou sem pontuação de CPF/PIS)
 * e devolve as que passam no dígito verificador de cada formato.
 *
 * Os dois formatos têm o mesmo tamanho em dígitos — por isso o mesmo número
 * nunca valida como os dois ao mesmo tempo (os pesos do módulo 11 são
 * diferentes), e não há caso real de confundir um com o outro.
 */
function scanChecksummedElevenDigits(text: string) {
  const candidates = text.match(/\d[\d.\-\/ ]{9,17}\d/gu) ?? [];
  const cpf: string[] = [];
  const pis: string[] = [];
  for (const candidate of candidates) {
    const digits = digitsOnly(candidate);
    if (digits.length !== 11) continue;
    if (isValidCpf(digits)) cpf.push(digits);
    else if (isValidPis(digits)) pis.push(digits);
  }
  return { cpf, pis };
}

/**
 * Extrai candidatos a campo a partir do texto que o OCR devolveu de uma foto.
 *
 * Só entra campo cujo valor passou em alguma conferência (dígito verificador,
 * formato de data válido, ou rótulo padronizado do documento) — o que não
 * passa em nenhuma delas simplesmente não vira sugestão, em vez de aparecer
 * como um palpite sem base.
 */
export function extractPhotoFields(text: string): { fields: PhotoFieldSuggestions; warnings: string[] } {
  const warnings: string[] = [];
  if (!text.trim()) return { fields: {}, warnings: ["A foto não tem texto legível."] };

  const fields: PhotoFieldSuggestions = {};

  const { cpf, pis } = scanChecksummedElevenDigits(text);
  // Mais de um CPF válido no mesmo texto é ambíguo — não dá para saber qual é
  // o da pessoa (pode ser ruído do OCR lendo outro número do documento por
  // engano). Um só, com dígito verificador batendo, é forte o bastante.
  if (cpf.length === 1) {
    const formatted = `${cpf[0].slice(0, 3)}.${cpf[0].slice(3, 6)}.${cpf[0].slice(6, 9)}-${cpf[0].slice(9)}`;
    fields.taxId = { value: formatted, confidence: "ok" };
  } else if (cpf.length > 1) {
    warnings.push("Mais de um CPF válido encontrado na foto — confira manualmente qual é o correto.");
  }
  if (pis.length === 1) {
    const formatted = `${pis[0].slice(0, 3)}.${pis[0].slice(3, 8)}.${pis[0].slice(8, 10)}-${pis[0].slice(10)}`;
    fields.pisNumber = { value: formatted, confidence: "ok" };
  } else if (pis.length > 1) {
    warnings.push("Mais de um PIS/PASEP válido encontrado na foto — confira manualmente qual é o correto.");
  }

  const anchored = sliceByLabels(text, identityLabels, 160);
  if (anchored.fields.fullName) {
    // Texto livre, sem dígito para conferir: nunca sai com confiança alta,
    // mesmo tendo achado o rótulo — só quem compara com a foto pode confirmar.
    fields.fullName = { value: anchored.fields.fullName, confidence: "low" };
  }
  if (anchored.fields.birthDate) {
    const raw = anchored.fields.birthDate;
    if (isValidRegistrationDate(raw)) fields.birthDate = { value: raw, confidence: "ok" };
    else warnings.push("Data de nascimento: o trecho lido perto do rótulo não é uma data válida.");
  }

  return { fields, warnings };
}
