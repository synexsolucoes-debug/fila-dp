export type CompanyOption = { id: string; name: string; legalName: string; status: string };
export type CycleOption = { id: string; competence: string; status: string };

export type TimeSheet = {
  id: string;
  employeeId: string;
  registrationNumber: string;
  employeeName: string;
  status: string;
  source: string;
  entriesCount: number;
  workedMinutes: number;
  expectedMinutes: number;
  balanceMinutes: number;
  blockingIssues: number;
  warningIssues: number;
  approvedAt: string;
  exportedAt: string;
};

export type TimeEventTotal = { eventCode: string; minutes: number; sheets: number };

export type TimeInconsistency = {
  id: string;
  sheetId: string;
  entryDate: string;
  kind: string;
  severity: "blocking" | "warning";
  detail: string;
  status: string;
  resolutionNote: string;
  registrationNumber: string;
  employeeName: string;
};

export type HourEventMappingRow = {
  id: string;
  destination: string;
  eventCode: string;
  rubricCode: string;
  targetField: string;
  unit: string;
  status: string;
  note: string;
};

export type TimeExportRow = {
  id: string;
  destination: string;
  status: string;
  sheetsCount: number;
  linesCount: number;
  checksum: string;
  createdAt: string;
};

export type TimePermissions = {
  manage: boolean;
  approve: boolean;
  export: boolean;
  manageMappings: boolean;
};

export type HourEventCatalogItem = { code: string; label: string; computed: boolean };

export type TimeOverview = {
  competence: string;
  cycle: CycleOption | null;
  cycles: CycleOption[];
  destination: string;
  sheets: TimeSheet[];
  events: TimeEventTotal[];
  inconsistencies: TimeInconsistency[];
  mappings: HourEventMappingRow[];
  exports: TimeExportRow[];
  summary: {
    sheets: number;
    approvedSheets: number;
    openBlockingIssues: number;
    openWarningIssues: number;
    missingMappings: string[];
    exportReady: boolean;
  };
  catalog: { hourEvents: HourEventCatalogItem[]; inconsistencyLabels: Record<string, string> };
  permissions: TimePermissions;
  boundary: string;
};

export type TimeDialog =
  | null
  | { kind: "entries"; sheetId: string; employeeName: string }
  | { kind: "mapping"; eventCode: string }
  | { kind: "inconsistency"; sheetId: string; inconsistencyId: string; detail: string }
  | { kind: "export" };
