import type { Capability } from "./authorization.ts";
import { ApiError } from "./api-errors.ts";
import { cleanText } from "./registrations.ts";

export const auxiliaryModules = ["benefits", "psychology", "contractors"] as const;
export type AuxiliaryModule = typeof auxiliaryModules[number];

export const auxiliaryProviderTypes = ["benefit_operator", "psychologist", "contractor"] as const;
export type AuxiliaryProviderType = typeof auxiliaryProviderTypes[number];

const moduleProvider: Record<AuxiliaryModule, AuxiliaryProviderType> = {
  benefits: "benefit_operator",
  psychology: "psychologist",
  contractors: "contractor",
};

const moduleCapabilities: Record<AuxiliaryModule, { read: Capability; manage: Capability }> = {
  benefits: { read: "benefits.read", manage: "benefits.manage" },
  psychology: { read: "psychology.read", manage: "psychology.manage" },
  contractors: { read: "contractors.read", manage: "contractors.manage" },
};

const clinicalDataPattern = /diagn[oó]stico|prontu[aá]rio|\bcid\b|medica[cç][aã]o|nota cl[ií]nica|paciente|sintoma|tratamento/u;

export function assertNoClinicalData(moduleType: AuxiliaryModule, ...values: unknown[]) {
  if (moduleType === "psychology" && clinicalDataPattern.test(JSON.stringify(values).toLowerCase())) {
    throw ApiError.badRequest("Dados clínicos não podem ser armazenados neste módulo.", "CLINICAL_DATA_FORBIDDEN");
  }
}

export function parseAuxiliaryModule(value: unknown): AuxiliaryModule {
  const candidate = cleanText(value, 30);
  if (!auxiliaryModules.includes(candidate as AuxiliaryModule)) {
    throw ApiError.badRequest("Módulo auxiliar inválido.", "INVALID_AUXILIARY_MODULE");
  }
  return candidate as AuxiliaryModule;
}

export function parseProviderType(value: unknown): AuxiliaryProviderType {
  const providerType = cleanText(value, 40);
  if (!auxiliaryProviderTypes.includes(providerType as AuxiliaryProviderType)) {
    throw ApiError.badRequest("Tipo de fornecedor inválido.", "INVALID_PROVIDER_TYPE");
  }
  return providerType as AuxiliaryProviderType;
}

export function providerTypeForModule(moduleType: AuxiliaryModule) {
  return moduleProvider[moduleType];
}

export function moduleForProviderType(providerType: AuxiliaryProviderType): AuxiliaryModule {
  return providerType === "benefit_operator" ? "benefits" : providerType === "psychologist" ? "psychology" : "contractors";
}

export function auxiliaryCapability(moduleType: AuxiliaryModule, action: "read" | "manage") {
  return moduleCapabilities[moduleType][action];
}

function boundedNumber(value: unknown, field: string, maximum = 100_000_000) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0 || number > maximum) {
    throw ApiError.badRequest(`${field} inválido.`, "INVALID_AUXILIARY_NUMBER");
  }
  return Math.round(number * 100) / 100;
}

function count(value: unknown, field: string) {
  return Math.trunc(boundedNumber(value, field, 1_000_000));
}

function optionalDate(value: unknown) {
  const date = cleanText(value, 10);
  if (!date) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw ApiError.badRequest("Data inválida.", "INVALID_AUXILIARY_DATE");
  }
  return date;
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]) {
  const candidate = cleanText(value, 60);
  return allowed.includes(candidate as T[number]) ? candidate as T[number] : fallback;
}

export function sanitizeAuxiliaryPayload(moduleType: AuxiliaryModule, input: unknown, output: unknown) {
  const rawInput = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const rawOutput = output && typeof output === "object" && !Array.isArray(output) ? output as Record<string, unknown> : {};

  if (moduleType === "benefits") {
    return {
      input: {
        benefitType: cleanText(rawInput.benefitType, 100),
        action: enumValue(rawInput.action, ["include", "change", "remove", "billing"] as const, "billing"),
        participantsCount: count(rawInput.participantsCount, "Quantidade de participantes"),
        billingReference: cleanText(rawInput.billingReference, 80),
      },
      output: {
        processedCount: count(rawOutput.processedCount, "Quantidade processada"),
        rejectedCount: count(rawOutput.rejectedCount, "Quantidade rejeitada"),
        operatorProtocol: cleanText(rawOutput.operatorProtocol, 120),
        effectiveDate: optionalDate(rawOutput.effectiveDate),
      },
    };
  }

  if (moduleType === "psychology") {
    const sanitized = {
      input: {
        serviceKind: enumValue(rawInput.serviceKind, ["individual", "group", "orientation", "campaign"] as const, "individual"),
        sessionsScheduled: count(rawInput.sessionsScheduled, "Sessões agendadas"),
        periodStart: optionalDate(rawInput.periodStart),
        periodEnd: optionalDate(rawInput.periodEnd),
      },
      output: {
        sessionsDelivered: count(rawOutput.sessionsDelivered, "Sessões realizadas"),
        absences: count(rawOutput.absences, "Ausências"),
        administrativeProtocol: cleanText(rawOutput.administrativeProtocol, 120),
      },
    };
    assertNoClinicalData(moduleType, rawInput, rawOutput);
    return sanitized;
  }

  return {
    input: {
      serviceDescription: cleanText(rawInput.serviceDescription, 240),
      invoiceNumber: cleanText(rawInput.invoiceNumber, 80),
      servicePeriod: cleanText(rawInput.servicePeriod, 40),
      grossAmount: boundedNumber(rawInput.grossAmount, "Valor bruto"),
    },
    output: {
      approvedAmount: boundedNumber(rawOutput.approvedAmount, "Valor aprovado"),
      paymentDueDate: optionalDate(rawOutput.paymentDueDate),
      paymentReference: cleanText(rawOutput.paymentReference, 120),
    },
  };
}

export function sanitizeProviderCode(value: unknown) {
  const code = cleanText(value, 80).toUpperCase().replace(/[^A-Z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!code) throw ApiError.badRequest("Informe o código do fornecedor.", "PROVIDER_CODE_REQUIRED");
  return code;
}

export function money(value: unknown) {
  return boundedNumber(value, "Valor total");
}
