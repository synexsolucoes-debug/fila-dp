import { ApiError } from "./api-errors.ts";
import { cleanText } from "./registrations.ts";
import {
  parseConditionList, parseTransitionConditions,
  type TransitionCondition, type TransitionConditionMap,
} from "./process-conditions.ts";

export const processLifecycleStatuses = ["draft", "in_review", "published", "inactive", "archived"] as const;
export const processVersionStatuses = ["draft", "in_review", "published", "retired"] as const;
export const processCriticalities = ["low", "medium", "high", "critical"] as const;
export const processPriorities = ["low", "normal", "high", "urgent"] as const;
export const processSlaUnits = ["minutes", "hours", "days"] as const;
export const processResponsibilityModes = [
  "USER", "DEPARTMENT", "DEPARTMENT_MANAGER", "REQUESTER",
  "EMPLOYEE_MANAGER", "PROCESS_OWNER", "DYNAMIC",
] as const;
export const processStepTypes = [
  "TASK", "USER_TASK", "APPROVAL", "SYSTEM_TASK", "NOTIFICATION", "FORM",
  "DOCUMENT_REQUEST", "DEMAND_CREATION", "CONDITION", "SUBPROCESS",
  "LANE", "START_EVENT", "END_EVENT", "GATEWAY",
] as const;

export type ProcessLifecycleStatus = typeof processLifecycleStatuses[number];
export type ProcessVersionStatus = typeof processVersionStatuses[number];
export type ProcessStepType = typeof processStepTypes[number];
export type ProcessResponsibilityMode = typeof processResponsibilityModes[number];

const objectValue = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const enumValue = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? value as T : fallback;

const numberBetween = (value: unknown, min: number, max: number, fallback = min) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
};

const stringArray = (value: unknown, maxItems: number, maxLength: number) =>
  Array.isArray(value)
    ? [...new Set(value.map((item) => cleanText(item, maxLength)).filter(Boolean))].slice(0, maxItems)
    : [];

export function cleanProcessCode(value: unknown) {
  return cleanText(value, 60).toUpperCase().replace(/[^A-Z0-9_-]/g, "_").replace(/_+/g, "_");
}

export function sanitizeIdList(value: unknown, max = 100) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => cleanText(item, 120)).filter(Boolean))].slice(0, max)
    : [];
}

export function sanitizeProcessTags(value: unknown) {
  if (Array.isArray(value)) return stringArray(value, 20, 40);
  return cleanText(value, 800).split(",").map((item) => item.trim()).filter(Boolean).slice(0, 20);
}

function xmlEscape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function defaultBpmnXml(name: string, seed = "process") {
  const safeName = xmlEscape(cleanText(name, 160) || "Novo processo");
  const safeSeed = (cleanText(seed, 80).replace(/[^A-Za-z0-9_]/g, "_") || "process").slice(0, 70);
  const processId = `Process_${safeSeed}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Definitions_${safeSeed}" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="${processId}" name="${safeName}" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1" name="Início"><bpmn:outgoing>Flow_1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:userTask id="Activity_1" name="Nova etapa"><bpmn:incoming>Flow_1</bpmn:incoming><bpmn:outgoing>Flow_2</bpmn:outgoing></bpmn:userTask>
    <bpmn:endEvent id="EndEvent_1" name="Fim"><bpmn:incoming>Flow_2</bpmn:incoming></bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="Activity_1" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Activity_1" targetRef="EndEvent_1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1"><bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${processId}">
    <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1"><dc:Bounds x="180" y="160" width="36" height="36" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="Activity_1_di" bpmnElement="Activity_1"><dc:Bounds x="290" y="138" width="120" height="80" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="EndEvent_1_di" bpmnElement="EndEvent_1"><dc:Bounds x="490" y="160" width="36" height="36" /></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1"><di:waypoint x="216" y="178" /><di:waypoint x="290" y="178" /></bpmndi:BPMNEdge>
    <bpmndi:BPMNEdge id="Flow_2_di" bpmnElement="Flow_2"><di:waypoint x="410" y="178" /><di:waypoint x="490" y="178" /></bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
}

export function validBpmnXml(value: unknown) {
  const xml = typeof value === "string" ? value.trim() : "";
  if (!xml) throw ApiError.badRequest("O diagrama BPMN está vazio.", "PROCESS_BPMN_REQUIRED");
  if (xml.length > 2_000_000) throw ApiError.badRequest("O diagrama BPMN excede o limite de 2 MB.", "PROCESS_BPMN_TOO_LARGE");
  if (!/<(?:bpmn:)?definitions\b/i.test(xml) || !/<(?:bpmn:)?process\b/i.test(xml)) {
    throw ApiError.badRequest("O conteúdo informado não é um BPMN 2.0 válido.", "PROCESS_BPMN_INVALID");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw ApiError.badRequest("O BPMN contém declarações XML não permitidas.", "PROCESS_BPMN_UNSAFE");
  return xml;
}

export function safeSvgPreview(value: unknown) {
  const svg = typeof value === "string" ? value.trim() : "";
  if (!svg) return "";
  if (svg.length > 1_000_000) throw ApiError.badRequest("A prévia SVG excede o limite de 1 MB.", "PROCESS_SVG_TOO_LARGE");
  if (!/<svg\b/i.test(svg) || /<script\b|javascript:|onload\s*=|onerror\s*=/i.test(svg)) {
    throw ApiError.badRequest("A prévia SVG contém conteúdo não permitido.", "PROCESS_SVG_UNSAFE");
  }
  return svg;
}

export type ProcessStepConfigInput = {
  id: string;
  bpmnElementId: string;
  stepType: ProcessStepType;
  departmentId: string;
  responsibleUserId: string;
  responsibilityMode: ProcessResponsibilityMode;
  slaValue: number;
  slaUnit: "minutes" | "hours" | "days";
  slaBusinessDays: boolean;
  cutoffTime: string;
  escalation: Record<string, unknown>;
  createDemand: boolean;
  demandType: string;
  requesterDepartmentId: string;
  responsibleDepartmentId: string;
  demandPriority: "low" | "normal" | "high" | "urgent";
  demandSlaValue: number;
  demandSlaUnit: "minutes" | "hours" | "days";
  checklistId: string;
  checklistItems: string[];
  formId: string;
  requiredDocuments: string[];
  optionalDocuments: string[];
  evidenceRequired: boolean;
  requiresApproval: boolean;
  approverUserId: string;
  approverDepartmentId: string;
  approvalCount: number;
  approvalMode: "sequential" | "parallel";
  subprocessProcessId: string;
  settings: {
    name: string; description: string; instructions: string; internalCode: string;
    dynamicAssignee: string; notificationTemplate: string;
    /* Regras do §23/§25. Passam pelo mesmo saneador do motor — o que ele não
       entende não é gravado, para o banco nunca guardar regra que a execução
       vai descartar depois e ninguém entender por quê. */
    entryRules: TransitionCondition[];
    exitRules: TransitionCondition[];
    transitions: TransitionConditionMap;
    blockingIntegrations: string[];
  };
};

export function sanitizeProcessStepConfigs(value: unknown): ProcessStepConfigInput[] {
  const input = Array.isArray(value) ? value.slice(0, 300) : [];
  const result = input.map((raw) => {
    const item = objectValue(raw);
    const settings = objectValue(item.settings);
    const bpmnElementId = cleanText(item.bpmnElementId, 160);
    if (!bpmnElementId) throw ApiError.badRequest("Uma configuração de etapa não possui bpmnElementId.", "PROCESS_STEP_ELEMENT_REQUIRED");
    const id = cleanText(item.id, 120) || crypto.randomUUID();
    const cutoffTime = cleanText(item.cutoffTime, 5);
    const escalation = objectValue(item.escalation);
    return {
      id,
      bpmnElementId,
      stepType: enumValue(item.stepType, processStepTypes, "TASK"),
      departmentId: cleanText(item.departmentId, 120),
      responsibleUserId: cleanText(item.responsibleUserId, 120),
      responsibilityMode: enumValue(item.responsibilityMode, processResponsibilityModes, "DEPARTMENT"),
      slaValue: numberBetween(item.slaValue, 0, 525600, 0),
      slaUnit: enumValue(item.slaUnit, processSlaUnits, "hours"),
      slaBusinessDays: Boolean(item.slaBusinessDays),
      cutoffTime: /^\d{2}:\d{2}$/.test(cutoffTime) ? cutoffTime : "",
      escalation: { afterValue: numberBetween(escalation.afterValue, 0, 525600, 0), notifyOwner: Boolean(escalation.notifyOwner), notifyDepartmentManager: Boolean(escalation.notifyDepartmentManager) },
      createDemand: Boolean(item.createDemand),
      demandType: cleanText(item.demandType, 120),
      requesterDepartmentId: cleanText(item.requesterDepartmentId, 120),
      responsibleDepartmentId: cleanText(item.responsibleDepartmentId, 120),
      demandPriority: enumValue(item.demandPriority, processPriorities, "normal"),
      demandSlaValue: numberBetween(item.demandSlaValue, 0, 525600, 0),
      demandSlaUnit: enumValue(item.demandSlaUnit, processSlaUnits, "hours"),
      checklistId: cleanText(item.checklistId, 120),
      checklistItems: stringArray(item.checklistItems, 50, 180),
      formId: cleanText(item.formId, 120),
      requiredDocuments: stringArray(item.requiredDocuments, 50, 120),
      optionalDocuments: stringArray(item.optionalDocuments, 50, 120),
      evidenceRequired: Boolean(item.evidenceRequired),
      requiresApproval: Boolean(item.requiresApproval),
      approverUserId: cleanText(item.approverUserId, 120),
      approverDepartmentId: cleanText(item.approverDepartmentId, 120),
      approvalCount: numberBetween(item.approvalCount, 1, 20, 1),
      approvalMode: item.approvalMode === "parallel" ? "parallel" as const : "sequential" as const,
      subprocessProcessId: cleanText(item.subprocessProcessId, 120),
      settings: {
        name: cleanText(settings.name, 160), description: cleanText(settings.description, 1000),
        instructions: cleanText(settings.instructions, 4000), internalCode: cleanText(settings.internalCode, 80),
        dynamicAssignee: cleanText(settings.dynamicAssignee, 120), notificationTemplate: cleanText(settings.notificationTemplate, 1000),
        entryRules: parseConditionList(settings.entryRules),
        exitRules: parseConditionList(settings.exitRules),
        transitions: parseTransitionConditions(settings.transitions),
        blockingIntegrations: stringArray(settings.blockingIntegrations, 12, 60).map((item) => item.toLowerCase()),
      },
    };
  });
  const elementIds = new Set<string>();
  const ids = new Set<string>();
  for (const item of result) {
    if (elementIds.has(item.bpmnElementId)) throw ApiError.badRequest("Cada elemento BPMN pode possuir apenas uma configuração.", "PROCESS_STEP_DUPLICATE");
    if (ids.has(item.id)) throw ApiError.badRequest("Configurações de etapa duplicadas.", "PROCESS_STEP_ID_DUPLICATE");
    elementIds.add(item.bpmnElementId); ids.add(item.id);
  }
  return result;
}

export function processVersionLabel(major: unknown, minor: unknown) {
  return `v${Math.max(1, Number(major) || 1)}.${Math.max(0, Number(minor) || 0)}`;
}

export function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}
