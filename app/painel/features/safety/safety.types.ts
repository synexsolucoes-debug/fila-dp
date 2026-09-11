import type {
  AccidentBodyPart, AccidentGender, AccidentShift, AccidentType, WorkAccidentRecord,
} from "@/lib/work-accidents";

export type SafetyCompanyOption = {
  id: string;
  name: string;
  taxId: string;
  status: "active" | "inactive";
};

export type SafetyPermissions = {
  view: boolean;
  manage: boolean;
  remove: boolean;
  export: boolean;
};

export type SafetyOverview = {
  permissions: SafetyPermissions;
  companies: SafetyCompanyOption[];
  /** Anos com acidente lançado, do mais recente para o mais antigo. */
  years: number[];
  summary: { accidents: number; lastOccurrence: string };
};

/** O formulário de lançamento, no formato que a rota recebe. */
export type AccidentDraft = {
  id: string;
  companyId: string;
  occurredOn: string;
  accidentType: AccidentType;
  bodyPart: AccidentBodyPart;
  sector: string;
  workShift: AccidentShift;
  gender: AccidentGender;
  employeeLabel: string;
  leaveDays: string;
  expenseAmount: string;
  catIssued: boolean;
  catNumber: string;
  description: string;
};

export type SafetyTab = "dashboard" | "records";

export type { WorkAccidentRecord };
