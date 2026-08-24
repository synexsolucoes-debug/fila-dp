export const sankhyaRunPhases = [
  "queued", "running", "authenticating", "navigating", "processing", "extracting", "importing",
  "succeeded", "partial", "failed", "requires_user_action", "canceled",
] as const;
export type SankhyaRunPhase = typeof sankhyaRunPhases[number];

export type SankhyaConfig = {
  endpoint: string;
  companyId: string;
  companyContext: string;
  routine: "employees";
  routineName: string;
  automaticEnabled: boolean;
  frequency: "hourly" | "daily" | "weekly";
  scheduleTime: string;
  scheduleWeekday: number;
  timezone: string;
  timeoutMs: number;
  maxAttempts: number;
  downloadLimitBytes: number;
  diagnosticRetentionHours: number;
};

export type SankhyaCredentials = { username: string; password: string };
export type SankhyaRawData = Record<string, unknown>;

export type VinculatoNormalizedEmployee = {
  externalEmployeeId: string;
  registrationNumber: string;
  fullName: string;
  cpfDigits: string;
  email: string;
  phone: string;
  admissionDate: string;
  terminationDate: string;
  employmentStatus: "active" | "on_leave" | "terminated";
  positionCode: string;
  positionName: string;
  functionName: string;
  departmentCode: string;
  departmentName: string;
  costCenterCode: string;
  costCenterName: string;
  scheduleCode: string;
  scheduleName: string;
  salaryCents: number;
};

export type SankhyaExtraction = {
  records: SankhyaRawData[];
  source: "xlsx" | "csv" | "table";
};

export type SankhyaDiagnostic = { bytes: Buffer; mimeType: "image/png" };

export interface SankhyaBrowserSession {
  authenticate(endpoint: string, credentials: SankhyaCredentials, timeoutMs: number): Promise<void>;
  openDpExplorer(config: SankhyaConfig): Promise<void>;
  runRoutine(config: SankhyaConfig): Promise<void>;
  extract(config: SankhyaConfig): Promise<SankhyaExtraction>;
  diagnosticScreenshot(): Promise<SankhyaDiagnostic | null>;
  logout(): Promise<void>;
  close(): Promise<void>;
}

export type SankhyaSessionFactory = (input: { workspaceId: string; integrationId: string; runId: string }) => Promise<SankhyaBrowserSession>;
