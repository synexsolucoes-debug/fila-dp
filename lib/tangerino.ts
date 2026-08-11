/**
 * Contrato oficial da Sólides DP (Tangerino).
 *
 * Documentação: https://docs.tangerino.com.br/
 * Especificação: https://employer.tangerino.com.br/v2/api-docs (Swagger 2.0)
 * Base oficial: https://employer.tangerino.com.br
 * Autenticação: cabeçalho `Authorization: Basic <token>`.
 *
 * É um produto DIFERENTE da Sólides Gestão (`lib/solides.ts`): outro host, outra
 * autenticação, outro contrato. Um workspace pode usar um, outro, ou os dois.
 *
 * Duas diferenças que moldam este conector:
 *
 * 1. Não existe filtro por data de admissão. O recurso oficial filtra por
 *    `lastUpdate` (epoch em milissegundos), que devolve quem foi ATUALIZADO desde
 *    então. A admissão é derivada no Vinculato: recebe-se a janela de atualização
 *    e mantém-se quem tem `admissionDate` a partir do corte e não está demitido.
 * 2. A API não expõe download de documento. Os únicos arquivos que ela manipula
 *    são foto do colaborador (só upload), imagem de assinatura e espelho de ponto
 *    via GED. Os documentos da admissão continuam sendo obtidos na Sólides.
 */
import { admissionTaskDraft as buildAdmissionTask, admissionText, emptyAdmission, type AdmissionRecord, type AdmissionSource } from "./admissions.ts";
import { ApiError } from "./api-errors.ts";

export const tangerinoSource: AdmissionSource = {
  label: "Sólides DP",
  documentsNote: "Os arquivos dos documentos permanecem na Sólides DP: a API oficial do Tangerino não expõe download de anexos.",
};

export const tangerinoApiHosts = ["employer.tangerino.com.br", "api.tangerino.com.br"] as const;

/** Único recurso oficial que o conector consome hoje: a listagem de colaboradores. */
const officialResourcePath = /^(?:\/api\/employer)?\/employee\/find-all$/u;

/**
 * Campos documentais devolvidos em `EmployeeReturnWithoutPinDTO`.
 * Guardamos apenas os NOMES presentes/ausentes: o valor bruto de documento não
 * entra em banco, histórico, log ou URL — mesma regra aplicada ao CPF por `protectCpf`.
 */
export const tangerinoDocumentFields = [
  { key: "cpf", label: "CPF" },
  { key: "ctps", label: "CTPS — número" },
  { key: "series", label: "CTPS — série" },
  { key: "pis", label: "PIS/PASEP" },
] as const;

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Aceita o `date-time` do DTO ou epoch em milissegundos e devolve `AAAA-MM-DD`. */
export function tangerinoDateToIso(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const fromEpoch = new Date(value);
    return Number.isNaN(fromEpoch.getTime()) ? "" : fromEpoch.toISOString().slice(0, 10);
  }
  const raw = admissionText(value, 40);
  if (!raw) return "";
  if (/^[0-9]{10,}$/u.test(raw)) return tangerinoDateToIso(Number(raw));
  const brazilian = /^([0-3]?[0-9])\/([01]?[0-9])\/([0-9]{4})$/u.exec(raw);
  if (brazilian) {
    const [, day, month, year] = brazilian;
    const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    return Number.isNaN(new Date(`${iso}T00:00:00Z`).getTime()) ? "" : iso;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

/** `lastUpdate` é epoch em milissegundos, conforme a especificação. */
export function isoToEpochMillis(value: unknown) {
  const iso = tangerinoDateToIso(value);
  if (!iso) return 0;
  return Date.parse(`${iso}T00:00:00.000Z`);
}

/**
 * Aceita somente o recurso oficial do Tangerino. Mesma postura da Sólides Gestão:
 * host fora da lista oficial, caminho diferente ou esquema não HTTPS são recusados.
 */
export function validateTangerinoEndpoint(value: unknown) {
  const raw = typeof value === "string" ? value.trim().slice(0, 500) : "";
  if (!raw) {
    throw new ApiError(409, "TANGERINO_OFFICIAL_RESOURCE_REQUIRED",
      `Configure o recurso oficial da Sólides DP (https://${tangerinoApiHosts[0]}/employee/find-all).`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw ApiError.badRequest("O recurso da Sólides DP precisa ser uma URL válida.", "TANGERINO_ENDPOINT_INVALID");
  }
  if (url.protocol !== "https:") throw ApiError.badRequest("O recurso da Sólides DP precisa usar HTTPS.", "TANGERINO_ENDPOINT_INSECURE");
  if (url.username || url.password) throw ApiError.badRequest("O recurso da Sólides DP não pode carregar credenciais na URL.", "TANGERINO_ENDPOINT_INVALID");
  if (!(tangerinoApiHosts as readonly string[]).includes(url.hostname)) {
    throw new ApiError(409, "TANGERINO_OFFICIAL_RESOURCE_REQUIRED",
      `A Sólides DP só aceita o recurso oficial em ${tangerinoApiHosts.join(", ")}. Endpoint especulativo não é aceito.`);
  }
  if (!officialResourcePath.test(url.pathname)) {
    throw new ApiError(409, "TANGERINO_OFFICIAL_RESOURCE_REQUIRED",
      "O recurso oficial suportado é /employee/find-all.");
  }
  return `${url.origin}${url.pathname}`;
}

/** Monta a consulta de colaboradores atualizados desde o corte, conforme a especificação. */
export function tangerinoEmployeesUrl(endpoint: unknown, options: { since?: unknown; page?: number; pageSize?: number; includeFired?: boolean } = {}) {
  const url = new URL(validateTangerinoEndpoint(endpoint));
  const since = isoToEpochMillis(options.since);
  if (since) url.searchParams.set("lastUpdate", String(since));
  // A paginação do Spring é indexada em zero: `page=0` é a primeira página.
  url.searchParams.set("page", String(Math.max(0, Math.min(1000, Math.trunc(options.page ?? 0) || 0))));
  url.searchParams.set("size", String(Math.max(1, Math.min(200, Math.trunc(options.pageSize ?? 100) || 100))));
  url.searchParams.set("showFired", options.includeFired ? "1" : "0");
  return url.toString();
}

/**
 * A Sólides DP autentica com `Basic`. O token copiado de
 * Empregador → Integrações às vezes já vem com o prefixo; aceitar as duas formas
 * evita um `Basic Basic ...` que o provedor recusaria sem explicar o motivo.
 */
export function tangerinoAuthorization(token: string) {
  const value = token.trim();
  if (!value) throw new ApiError(409, "INTEGRATION_CREDENTIAL_INCOMPLETE", "A credencial da Sólides DP não possui token utilizável.");
  return /^basic\s/iu.test(value) ? `Basic ${value.replace(/^basic\s+/iu, "")}` : `Basic ${value}`;
}

/** O recurso responde com o envelope `Page` do Spring: os registros vêm em `content`. */
export function tangerinoRecords(payload: unknown) {
  const page = record(payload);
  return Array.isArray(page.content) ? page.content.map(record) : [];
}

/**
 * Normaliza um colaborador da Sólides DP. O CPF sai em `cpf` apenas para virar
 * HMAC em `protectCpf` na gravação; ele nunca é persistido em claro.
 */
export function normalizeTangerinoAdmission(raw: unknown): AdmissionRecord {
  const source = record(raw);
  const jobRole = record(source.jobRoleDTO);
  const workplace = record(source.currentWorkplaceDTO);
  const schedule = record(source.currentWorkSchedule);
  const company = record(source.company);
  const salary = record(jobRole.salary);
  const present: string[] = [];
  const missing: string[] = [];
  for (const field of tangerinoDocumentFields) {
    (admissionText(source[field.key], 80) ? present : missing).push(field.label);
  }
  return {
    ...emptyAdmission(),
    externalId: admissionText(source.id, 120),
    fullName: admissionText(source.name, 160) || admissionText(source.socialName, 160),
    registrationNumber: admissionText(source.externalId, 60),
    admissionDate: tangerinoDateToIso(source.admissionDate),
    birthDate: tangerinoDateToIso(source.birthDate),
    email: admissionText(source.email, 160),
    phone: admissionText(source.phone, 40),
    positionName: admissionText(jobRole.description, 120),
    departmentName: admissionText(company.descriptionName ?? company.fantasyName, 120),
    unityName: admissionText(workplace.name, 120),
    contractStartDate: tangerinoDateToIso(source.effectiveDate),
    workShift: admissionText(schedule.name, 80),
    salary: Math.max(0, Math.min(999999999, Number(salary.value) || 0)),
    cpf: admissionText(source.cpf, 20),
    documentsPresent: present,
    documentsMissing: missing,
  };
}

/**
 * Por que um registro recebido não vira tarefa.
 *
 * O filtro oficial é por atualização, não por admissão: a mesma janela traz
 * desligamento, correção de cadastro e admissão antiga. Sem este recorte, mexer
 * no cadastro de alguém admitido há dois anos abriria uma conciliação de admissão.
 */
export function tangerinoSkipReason(raw: unknown, admission: AdmissionRecord, sinceIso: string) {
  const source = record(raw);
  if (source.fired === true || tangerinoDateToIso(source.resignationDate)) return "desligado";
  const cut = tangerinoDateToIso(sinceIso);
  if (cut && admission.admissionDate && admission.admissionDate < cut) return "admitido antes do corte";
  return "";
}

/** Rascunho da tarefa, com a Sólides DP nomeada como origem. */
export function admissionTaskDraft(admission: AdmissionRecord) {
  return buildAdmissionTask(admission, tangerinoSource, tangerinoDocumentFields.length);
}
