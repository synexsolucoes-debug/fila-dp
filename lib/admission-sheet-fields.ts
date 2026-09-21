/**
 * De onde veio cada campo da ficha, e o que fazer quando as origens divergem.
 *
 * ## Três origens, e por que a distinção não é decorativa
 *
 *   `document` — lido do Registro de Empregado anexado.
 *   `registry` — do cadastro do colaborador já aprovado no Vinculato.
 *   `manual`   — digitado por uma pessoa aqui.
 *
 * Quem transcreve precisa saber qual é qual. Um CPF lido do documento e um CPF
 * digitado por um colega pedem confianças diferentes: o primeiro tem o arquivo
 * ao lado para conferir, o segundo tem uma pessoa e uma data. Apresentar os
 * dois como "o CPF da ficha" apagaria essa diferença exatamente quando ela
 * importa — na hora de decidir se dá para colar no ERP sem olhar.
 *
 * ## A precedência, e o que ela protege
 *
 * Manual vence documento, que vence cadastro. Não é hierarquia de qualidade: é
 * ordem de decisão. Alguém que corrigiu um campo já olhou o documento e decidiu
 * contra ele; reler o PDF não pode desfazer isso sozinho. O valor extraído
 * continua guardado e aparece ao lado, para que a divergência seja visível em
 * vez de silenciosa.
 *
 * ## Identidade: validação matemática não prova titularidade
 *
 * Um CPF com dígito verificador correto é um CPF válido — de alguém. Não prova
 * que é **desta** pessoa. Por isso, antes de trazer qualquer coisa do cadastro,
 * a ficha compara o que o documento diz com o colaborador vinculado à demanda.
 * Divergindo, o preenchimento automático não acontece e a divergência vira
 * pendência: anexar dado de uma pessoa à admissão de outra é o erro mais caro
 * que esta tela pode cometer, e o único que ninguém percebe olhando a tela.
 */
import { registrationFormFields, type RegistrationFormRaw } from "./employee-registration-form.ts";

export const fieldSources = ["document", "registry", "manual"] as const;
export type FieldSource = typeof fieldSources[number];

export const FIELD_SOURCE_LABELS: Readonly<Record<FieldSource, string>> = {
  document: "Lido do documento",
  registry: "Do cadastro do Vinculato",
  manual: "Preenchido à mão",
};

/** Metadado por campo. Nenhum valor — é o que permite guardá-lo em coluna aberta. */
export type FieldMeta = { source: FieldSource; by: string; at: string };
export type FieldMetaMap = Record<string, FieldMeta>;

const knownKeys = new Set(registrationFormFields.map((field) => field.key));

export function sanitizeFieldMeta(value: unknown): FieldMetaMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const meta: FieldMetaMap = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!knownKeys.has(key) || !raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const source = typeof entry.source === "string" && (fieldSources as readonly string[]).includes(entry.source)
      ? entry.source as FieldSource
      : null;
    if (!source) continue;
    meta[key] = {
      source,
      by: String(entry.by ?? "").slice(0, 220),
      at: String(entry.at ?? "").slice(0, 40),
    };
  }
  return meta;
}

export type MergedField = {
  key: string;
  value: string;
  source: FieldSource;
  /** O que o documento dizia, quando alguém corrigiu por cima. */
  documentValue: string;
  by: string;
  at: string;
};

/**
 * Aplica a precedência e devolve o valor efetivo de cada campo, com a origem.
 *
 * Campo ausente em todas as origens simplesmente não entra: a ficha o mostra
 * como em branco, que é diferente de mostrá-lo com valor vazio e origem.
 */
export function mergeSheetFields(input: {
  extracted: RegistrationFormRaw;
  overrides: RegistrationFormRaw;
  registry?: RegistrationFormRaw;
  meta: FieldMetaMap;
}) {
  const merged: Record<string, MergedField> = {};
  for (const field of registrationFormFields) {
    const manual = input.overrides[field.key] ?? "";
    const document = input.extracted[field.key] ?? "";
    const registry = input.registry?.[field.key] ?? "";
    const value = manual || document || registry;
    if (!value) continue;
    const source: FieldSource = manual ? "manual" : document ? "document" : "registry";
    const meta = input.meta[field.key];
    merged[field.key] = {
      key: field.key,
      value,
      source,
      documentValue: source === "manual" ? document : "",
      by: source === "manual" ? (meta?.by ?? "") : "",
      at: source === "manual" ? (meta?.at ?? "") : "",
    };
  }
  return merged;
}

/* -------------------------------------------------------------------------- *
 * Identidade
 * -------------------------------------------------------------------------- */

export type IdentityDivergence = { field: string; label: string; detail: string };

const digits = (value: string) => value.replace(/\D/gu, "");

/** Compara ignorando acento, caixa e espaço repetido — não a ordem dos nomes. */
function foldName(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * O documento é desta pessoa?
 *
 * Compara o que foi lido com o colaborador vinculado à demanda. O CPF é
 * comparado pelos últimos quatro dígitos porque é o que o cadastro guarda —
 * `protectCpf` grava HMAC e os quatro finais, e nunca o número em claro.
 *
 * Quatro dígitos não são prova de identidade, e o código não finge que são: é
 * uma **peneira**. Ela pega a troca grosseira — o documento de outra pessoa
 * anexado na demanda errada —, que é o caso real. Coincidência nos quatro
 * finais com nome também batendo é raro o bastante para não valer um falso
 * alarme em toda admissão.
 */
export function detectIdentityDivergence(input: {
  extracted: RegistrationFormRaw;
  employee: { fullName: string; cpfLast4: string } | null;
}): IdentityDivergence[] {
  if (!input.employee) return [];
  const divergences: IdentityDivergence[] = [];

  const documentTaxId = digits(input.extracted.taxId ?? "");
  const expectedLast4 = digits(input.employee.cpfLast4 ?? "");
  if (documentTaxId.length === 11 && expectedLast4.length === 4 && documentTaxId.slice(-4) !== expectedLast4) {
    divergences.push({
      field: "taxId",
      label: "CPF",
      detail: "O CPF lido no documento não termina nos mesmos quatro dígitos do CPF cadastrado para esta pessoa.",
    });
  }

  const documentName = foldName(input.extracted.fullName ?? "");
  const expectedName = foldName(input.employee.fullName ?? "");
  if (documentName && expectedName && documentName !== expectedName) {
    /* Nome diferente nem sempre é pessoa diferente: casamento, nome social e
       abreviação mudam o texto sem mudar quem é. Por isso a divergência só é
       levantada quando não há sequer um sobrenome em comum — abaixo disso o
       alarme tocaria em admissão legítima e seria ignorado por hábito. */
    const documentParts = new Set(documentName.split(" ").filter((part) => part.length > 2));
    const shared = expectedName.split(" ").filter((part) => part.length > 2 && documentParts.has(part));
    if (shared.length === 0) {
      divergences.push({
        field: "fullName",
        label: "Nome",
        detail: "O nome lido no documento não tem nenhum sobrenome em comum com o do colaborador desta demanda.",
      });
    }
  }
  return divergences;
}

/**
 * Dados contratuais do cadastro, para completar o que o documento não traz.
 *
 * Só entram campos que o cadastro **decide** — cargo, empresa, data de admissão
 * —, e nunca documento pessoal: o RG e o PIS do cadastro vieram de uma digitação
 * anterior, e usá-los aqui transformaria um erro antigo em confirmação nova.
 */
export function registryFields(employee: {
  fullName?: string;
  admissionDate?: string;
  positionName?: string;
  companyName?: string;
} | null): RegistrationFormRaw {
  if (!employee) return {};
  const fields: RegistrationFormRaw = {};
  if (employee.fullName) fields.fullName = employee.fullName;
  if (employee.admissionDate) {
    const [year, month, day] = employee.admissionDate.slice(0, 10).split("-");
    if (year && month && day) fields.admissionDate = `${day}/${month}/${year}`;
  }
  if (employee.positionName) fields.position = employee.positionName;
  if (employee.companyName) fields.employerName = employee.companyName;
  return fields;
}
