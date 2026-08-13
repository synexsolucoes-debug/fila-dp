import { createHash } from "node:crypto";
import type { SankhyaRawData, VinculatoNormalizedEmployee } from "./types.ts";

const aliases: Record<keyof VinculatoNormalizedEmployee, string[]> = {
  externalEmployeeId: ["codigo", "codfunc", "codigo funcionario", "id", "id funcionario"],
  registrationNumber: ["matricula", "registro", "chapa"],
  fullName: ["nome", "nome completo", "funcionario", "colaborador"],
  cpfDigits: ["cpf", "cpf funcionario"],
  email: ["email", "e-mail"],
  phone: ["telefone", "celular", "fone"],
  admissionDate: ["admissao", "data admissao", "dt admissao"],
  terminationDate: ["demissao", "data demissao", "desligamento"],
  employmentStatus: ["situacao", "status", "situacao funcionario"],
  positionCode: ["codigo cargo", "cod cargo"],
  positionName: ["cargo", "descricao cargo"],
  functionName: ["funcao", "descricao funcao"],
  departmentCode: ["codigo departamento", "cod departamento", "codigo setor"],
  departmentName: ["departamento", "setor"],
  costCenterCode: ["codigo centro resultado", "cod centro custo", "codigo centro custo"],
  costCenterName: ["centro resultado", "centro de resultado", "centro custo", "centro de custo"],
  scheduleCode: ["codigo jornada", "cod horario", "codigo horario"],
  scheduleName: ["jornada", "horario", "escala"],
  salaryCents: ["salario", "salario base", "remuneracao"],
};

function key(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function text(value: unknown, max = 300) {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/\s+/gu, " ").slice(0, max);
}

function valueOf(record: SankhyaRawData, field: keyof VinculatoNormalizedEmployee) {
  const normalized = new Map(Object.entries(record).map(([name, value]) => [key(name), value]));
  for (const candidate of aliases[field]) {
    if (normalized.has(candidate)) return normalized.get(candidate);
  }
  return "";
}

function date(value: unknown) {
  const raw = text(value, 40);
  if (!raw) return "";
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(raw);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/u.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function moneyCents(value: unknown) {
  if (typeof value === "number") return Math.max(0, Math.round(value * 100));
  const raw = text(value, 40).replace(/R\$|\s/giu, "");
  if (!raw) return 0;
  const normalized = raw.includes(",") ? raw.replace(/\./gu, "").replace(",", ".") : raw;
  const number = Number(normalized);
  return Number.isFinite(number) ? Math.max(0, Math.round(number * 100)) : 0;
}

function status(value: unknown): VinculatoNormalizedEmployee["employmentStatus"] {
  const normalized = key(text(value));
  if (/demit|deslig|rescind|inativ|afastado definitivo/u.test(normalized)) return "terminated";
  if (/afast|licenca/u.test(normalized)) return "on_leave";
  return "active";
}

export function normalizeSankhyaEmployee(record: SankhyaRawData) {
  const normalized: VinculatoNormalizedEmployee = {
    externalEmployeeId: text(valueOf(record, "externalEmployeeId"), 120),
    registrationNumber: text(valueOf(record, "registrationNumber"), 60),
    fullName: text(valueOf(record, "fullName"), 160),
    cpfDigits: text(valueOf(record, "cpfDigits"), 30).replace(/\D/gu, "").slice(0, 11),
    email: text(valueOf(record, "email"), 160).toLowerCase(),
    phone: text(valueOf(record, "phone"), 40),
    admissionDate: date(valueOf(record, "admissionDate")),
    terminationDate: date(valueOf(record, "terminationDate")),
    employmentStatus: status(valueOf(record, "employmentStatus")),
    positionCode: text(valueOf(record, "positionCode"), 80),
    positionName: text(valueOf(record, "positionName"), 160),
    functionName: text(valueOf(record, "functionName"), 160),
    departmentCode: text(valueOf(record, "departmentCode"), 80),
    departmentName: text(valueOf(record, "departmentName"), 160),
    costCenterCode: text(valueOf(record, "costCenterCode"), 80),
    costCenterName: text(valueOf(record, "costCenterName"), 160),
    scheduleCode: text(valueOf(record, "scheduleCode"), 80),
    scheduleName: text(valueOf(record, "scheduleName"), 160),
    salaryCents: moneyCents(valueOf(record, "salaryCents")),
  };
  const errors: string[] = [];
  if (!normalized.externalEmployeeId) errors.push("externalEmployeeId");
  if (!normalized.registrationNumber) errors.push("registrationNumber");
  if (!normalized.fullName) errors.push("fullName");
  if (!normalized.admissionDate) errors.push("admissionDate");
  return { normalized, errors };
}

/** Persistência minimizada: CPF completo não entra no snapshot intermediário. */
export function persistedSankhyaEmployee(employee: VinculatoNormalizedEmployee) {
  const safe = Object.fromEntries(Object.entries(employee).filter(([field]) => field !== "cpfDigits")) as Omit<VinculatoNormalizedEmployee, "cpfDigits">;
  return { ...safe, cpfLast4: employee.cpfDigits.slice(-4) };
}

export function normalizedEmployeeHash(employee: VinculatoNormalizedEmployee) {
  return createHash("sha256").update(JSON.stringify(persistedSankhyaEmployee(employee))).digest("hex");
}
