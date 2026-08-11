/**
 * Contrato oficial da Sólides Gestão.
 *
 * Documentação: https://gestaoapidocs.solides.com.br/
 * Base oficial: https://app.solides.com/{locale}/api/v1/
 * Autenticação: cabeçalho `Authorization: Token token=<token>` (não é Bearer).
 *
 * Limite conhecido e deliberado: a API de Gestão devolve os DADOS documentais do
 * colaborador (bloco `documents`) e não expõe download dos arquivos. O conector
 * concilia a ficha e abre a tarefa; os arquivos continuam sendo obtidos na Sólides.
 * Nenhum endpoint especulativo é aceito — ver `validateSolidesEndpoint`.
 */
import { admissionTaskDraft as buildAdmissionTask, admissionText, emptyAdmission, type AdmissionRecord, type AdmissionSource } from "./admissions.ts";
import { ApiError } from "./api-errors.ts";

/** A regra de produto e o formato da tarefa são comuns aos dois produtos da Sólides. */
export { admissionIsComplete } from "./admissions.ts";
export type { AdmissionRecord } from "./admissions.ts";

export const solidesSource: AdmissionSource = {
  label: "Sólides",
  documentsNote: "Os arquivos dos documentos permanecem na Sólides: a API oficial de Gestão não expõe download de anexos.",
};

export const solidesApiHosts = ["app.solides.com"] as const;
export const solidesLocales = ["pt-BR", "es", "en"] as const;

/** Único recurso oficial que o conector consome hoje: a listagem de colaboradores. */
const officialResourcePath = /^\/(pt-BR|es|en)\/api\/v1\/colaboradores$/u;

/**
 * Campos documentais devolvidos por `GET /colaboradores/{id}` no bloco `documents`.
 * Guardamos apenas os NOMES presentes/ausentes: o valor bruto de documento não entra
 * em banco, histórico, log ou URL — mesma regra já aplicada ao CPF em `protectCpf`.
 */
export const solidesDocumentFields = [
  { key: "idNumber", label: "CPF" },
  { key: "rg", label: "RG" },
  { key: "issuingBody", label: "Órgão emissor do RG" },
  { key: "dispatchDate", label: "Data de expedição do RG" },
  { key: "ctpsNum", label: "CTPS — número" },
  { key: "ctpsSerie", label: "CTPS — série" },
  { key: "pis", label: "PIS/PASEP" },
  { key: "voterRegistration", label: "Título de eleitor" },
  { key: "reservist", label: "Certificado de reservista" },
  { key: "bank", label: "Banco" },
  { key: "agency", label: "Agência" },
  { key: "checkingsAccount", label: "Conta corrente" },
] as const;

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const textValue = admissionText;

/** Converte `DD/MM/AAAA` (formato da Sólides) ou ISO em `AAAA-MM-DD`. */
export function solidesDateToIso(value: unknown) {
  const raw = textValue(value, 40);
  const brazilian = /^([0-3]?[0-9])\/([01]?[0-9])\/([0-9]{4})$/u.exec(raw);
  if (brazilian) {
    const [, day, month, year] = brazilian;
    const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    return Number.isNaN(new Date(`${iso}T00:00:00Z`).getTime()) ? "" : iso;
  }
  const isoCandidate = raw.slice(0, 10);
  if (!/^[0-9]{4}-[01][0-9]-[0-3][0-9]$/u.test(isoCandidate)) return "";
  return Number.isNaN(new Date(`${isoCandidate}T00:00:00Z`).getTime()) ? "" : isoCandidate;
}

/** Converte `AAAA-MM-DD` no formato `DD/MM/AAAA` exigido pelo filtro `data_admissao`. */
export function isoToSolidesDate(value: unknown) {
  const iso = solidesDateToIso(value);
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

/**
 * Aceita somente o recurso oficial da Sólides. Continua rejeitando endpoint
 * especulativo: host fora da lista oficial, caminho diferente ou esquema não HTTPS.
 */
export function validateSolidesEndpoint(value: unknown) {
  const raw = typeof value === "string" ? value.trim().slice(0, 500) : "";
  if (!raw) {
    throw new ApiError(409, "SOLIDES_OFFICIAL_RESOURCE_REQUIRED",
      `Configure o recurso oficial da Sólides (https://${solidesApiHosts[0]}/pt-BR/api/v1/colaboradores).`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw ApiError.badRequest("O recurso da Sólides precisa ser uma URL válida.", "SOLIDES_ENDPOINT_INVALID");
  }
  if (url.protocol !== "https:") throw ApiError.badRequest("O recurso da Sólides precisa usar HTTPS.", "SOLIDES_ENDPOINT_INSECURE");
  if (url.username || url.password) throw ApiError.badRequest("O recurso da Sólides não pode carregar credenciais na URL.", "SOLIDES_ENDPOINT_INVALID");
  if (!(solidesApiHosts as readonly string[]).includes(url.hostname)) {
    throw new ApiError(409, "SOLIDES_OFFICIAL_RESOURCE_REQUIRED",
      `A Sólides só aceita o recurso oficial em ${solidesApiHosts.join(", ")}. Endpoint especulativo não é aceito.`);
  }
  if (!officialResourcePath.test(url.pathname)) {
    throw new ApiError(409, "SOLIDES_OFFICIAL_RESOURCE_REQUIRED",
      "O recurso oficial suportado é /{locale}/api/v1/colaboradores, com locale pt-BR, es ou en.");
  }
  return `${url.origin}${url.pathname}`;
}

/** Monta a consulta de admissões a partir da data de corte, conforme a documentação oficial. */
export function solidesAdmissionsUrl(endpoint: unknown, options: { since?: unknown; page?: number; pageSize?: number; includeInactive?: boolean } = {}) {
  const url = new URL(validateSolidesEndpoint(endpoint));
  const since = isoToSolidesDate(options.since);
  if (since) url.searchParams.set("data_admissao", since);
  if (options.includeInactive) url.searchParams.set("status", "todos");
  url.searchParams.set("page", String(Math.max(1, Math.min(1000, Math.trunc(options.page ?? 1) || 1))));
  url.searchParams.set("page_size", String(Math.max(1, Math.min(150, Math.trunc(options.pageSize ?? 150) || 150))));
  return url.toString();
}

/** A Sólides autentica com `Token token=`, e não com o `Bearer` usado pelos demais conectores. */
export function solidesAuthorization(token: string) {
  const value = token.trim();
  if (!value) throw new ApiError(409, "INTEGRATION_CREDENTIAL_INCOMPLETE", "A credencial da Sólides não possui token utilizável.");
  return `Token token=${value}`;
}

export type SolidesAdmission = AdmissionRecord;

/**
 * Normaliza um colaborador da Sólides. O CPF sai em `cpf` apenas para ser convertido
 * em HMAC por `protectCpf` no momento da gravação; ele nunca é persistido em claro.
 */
export function normalizeSolidesAdmission(raw: unknown): AdmissionRecord {
  const source = record(raw);
  const documents = record(source.documents);
  const contact = record(source.contact);
  const position = record(source.position);
  const department = record(source.departament ?? source.department);
  const unity = record(source.unity);
  const present: string[] = [];
  const missing: string[] = [];
  for (const field of solidesDocumentFields) {
    (textValue(documents[field.key], 80) ? present : missing).push(field.label);
  }
  const salary = Number(String(source.salary ?? "").replace(/\./gu, "").replace(",", ".")) || 0;
  return {
    ...emptyAdmission(),
    externalId: textValue(source.id, 120),
    fullName: textValue(source.name, 160),
    registrationNumber: textValue(source.registration, 60),
    admissionDate: solidesDateToIso(source.dateAdmission),
    birthDate: solidesDateToIso(source.birthDate),
    email: textValue(contact.corporateEmail ?? contact.personalEmail ?? source.email, 160),
    phone: textValue(contact.cellPhone ?? contact.phone, 40),
    positionName: textValue(position.name, 120),
    departmentName: textValue(department.name, 120),
    unityName: textValue(unity.name, 120),
    contractType: textValue(source.typeContract, 80),
    contractStartDate: solidesDateToIso(source.dateContract),
    contractExpirationDate: solidesDateToIso(source.contractExpirationDate),
    workShift: textValue(source.workShift, 80),
    salary: Math.max(0, Math.min(999999999, salary)),
    cpf: textValue(documents.idNumber ?? source.idNumber, 20),
    documentsPresent: present,
    documentsMissing: missing,
    dependents: Array.isArray(source.dependents) ? source.dependents.length : 0,
  };
}

/** Rascunho da tarefa, com a Sólides Gestão nomeada como origem. */
export function admissionTaskDraft(admission: AdmissionRecord) {
  return buildAdmissionTask(admission, solidesSource, solidesDocumentFields.length);
}
