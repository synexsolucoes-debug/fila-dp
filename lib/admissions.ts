/**
 * Contrato comum das admissões recebidas de um sistema externo.
 *
 * A Sólides tem dois produtos com APIs distintas — Gestão (`lib/solides.ts`) e
 * DP/Tangerino (`lib/tangerino.ts`). O que muda entre eles é o transporte: host,
 * autenticação, filtro e nomes de campo. O que NÃO muda é a regra de produto:
 * o Vinculato recebe quem já foi admitido, abre conciliação cadastral e nunca
 * copia valor de documento para descrição, metadado ou auditoria.
 *
 * Por isso a normalização vive em cada conector e a tarefa nasce aqui.
 */
import { cleanText } from "./registrations.ts";

export type AdmissionRecord = {
  externalId: string;
  fullName: string;
  registrationNumber: string;
  admissionDate: string;
  birthDate: string;
  email: string;
  phone: string;
  positionName: string;
  departmentName: string;
  unityName: string;
  contractType: string;
  contractStartDate: string;
  contractExpirationDate: string;
  workShift: string;
  salary: number;
  /** Só existe para virar HMAC em `protectCpf`; nunca é persistido em claro. */
  cpf: string;
  documentsPresent: string[];
  documentsMissing: string[];
  dependents: number;
};

/** Como o sistema de origem é nomeado na tarefa, e por que os arquivos não vêm junto. */
export type AdmissionSource = { label: string; documentsNote: string };

export function emptyAdmission(): AdmissionRecord {
  return {
    externalId: "", fullName: "", registrationNumber: "", admissionDate: "", birthDate: "", email: "", phone: "",
    positionName: "", departmentName: "", unityName: "", contractType: "", contractStartDate: "", contractExpirationDate: "",
    workShift: "", salary: 0, cpf: "", documentsPresent: [], documentsMissing: [], dependents: 0,
  };
}

export function admissionText(value: unknown, max = 160) {
  return typeof value === "string" || typeof value === "number" ? cleanText(String(value), max) : "";
}

/** Só há admissão a conciliar quando a origem devolve identificador, nome e data de admissão. */
export function admissionIsComplete(admission: AdmissionRecord) {
  const missing: string[] = [];
  if (!admission.externalId) missing.push("externalId");
  if (!admission.fullName) missing.push("fullName");
  if (!admission.admissionDate) missing.push("admissionDate");
  return missing;
}

/**
 * Rascunho da tarefa aberta no Vinculato. O texto não carrega valor de documento:
 * lista apenas quais documentos vieram preenchidos e quais faltam.
 */
export function admissionTaskDraft(admission: AdmissionRecord, source: AdmissionSource, documentFieldCount: number) {
  const contract = [admission.contractType, admission.workShift].filter(Boolean).join(" · ") || "não informado";
  const lotacao = [admission.positionName, admission.departmentName, admission.unityName].filter(Boolean).join(" · ") || "não informada";
  const description = [
    `Colaborador admitido na ${source.label} em ${admission.admissionDate}.`,
    `Matrícula: ${admission.registrationNumber || "não informada"} · Registro ${source.label}: ${admission.externalId}`,
    `Lotação: ${lotacao}`,
    `Contrato: ${contract}`,
    admission.contractExpirationDate ? `Vigência do contrato até ${admission.contractExpirationDate}.` : "",
    `Dependentes informados: ${admission.dependents}`,
    `Ficha documental recebida: ${admission.documentsPresent.length}/${documentFieldCount} campos.`,
    admission.documentsMissing.length ? `Pendente na ficha: ${admission.documentsMissing.join(", ")}.` : "Ficha documental completa.",
    source.documentsNote,
  ].filter(Boolean).join("\n");
  const checklist = [
    `Conferir a ficha recebida da ${source.label}`,
    ...admission.documentsMissing.slice(0, 12).map((label) => `Obter na ${source.label}: ${label}`),
    `Baixar os arquivos dos documentos na ${source.label} e anexar à tarefa`,
    `Vincular o registro da ${source.label} ao ERP`,
    "Tratar divergências cadastrais",
    "Registrar a sincronização concluída",
  ];
  return {
    title: `Conciliação cadastral — ${admission.fullName}`.slice(0, 160),
    description: description.slice(0, 4000),
    checklist,
  };
}
