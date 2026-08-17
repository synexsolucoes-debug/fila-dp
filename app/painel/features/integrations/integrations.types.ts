export type IntegrationChannel = "email" | "whatsapp" | "teams" | "drive" | "onedrive" | "solides" | "tangerino" | "erp" | "sankhya_browser";
export type IntegrationTab = "connectors" | "mappings" | "runs" | "reconciliations";
export type ConnectorStatus = "connected" | "needs_credentials" | "paused" | "error" | "requires_user_action";
export type MappingStatus = "draft" | "active" | "archived";
export type RunStatus = "queued" | "running" | "authenticating" | "navigating" | "processing" | "extracting" | "importing" | "succeeded" | "partial" | "failed" | "requires_user_action" | "canceled";

export type IntegrationPermissions = {
  manage: boolean;
  run: boolean;
  reconcile: boolean;
  view: boolean;
  credentialsManage: boolean;
  execute: boolean;
  logsView: boolean;
};

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

export type StandardConnectorConfig = {
  endpoint?: string;
  accountReference?: string;
  admissionsSince?: string;
  pageSize?: number;
  boardId?: string;
  companyId?: string;
};

export type Connector = {
  id: string;
  channel: IntegrationChannel;
  displayName: string;
  status: ConnectorStatus;
  lastSyncAt: string;
  lastError: string;
  updatedAt: string;
  hasCredentials: boolean;
  credentialId: string;
  fingerprint: string;
  keyVersion: number;
  verifiedAt: string;
  expiresAt: string;
  publicHint: string;
  config: SankhyaConfig | StandardConnectorConfig | null;
  lastConnectionAt: string;
  lastSuccessfulSyncAt: string;
  nextSyncAt: string;
  scheduleEnabled: boolean;
  connectorVersion: string;
};

export type Mapping = {
  id: string;
  integrationId: string;
  resourceType: string;
  direction: string;
  version: number;
  status: MappingStatus;
  checksum: string;
  publishedAt: string;
  createdAt: string;
};

export type IntegrationRun = {
  id: string;
  integrationId: string;
  displayName: string;
  mappingId: string;
  triggerType: string;
  status: RunStatus;
  attempt: number;
  receivedCount: number;
  processedCount: number;
  skippedCount: number;
  conflictCount: number;
  failedCount: number;
  updatedCount: number;
  unchangedCount: number;
  durationMs: number;
  summary: string;
  errorCode: string;
  errorMessage: string;
  startedAt: string;
  completedAt: string;
  createdAt: string;
};

export type Reconciliation = {
  id: string;
  integrationId: string;
  runId: string;
  displayName: string;
  entityType: string;
  externalId: string;
  internalId: string;
  status: "unmatched" | "conflict";
  differenceFields: string[];
  createdAt: string;
};

export type QueueState = { status: string; count: number };

export type IntegrationsOverview = {
  connectors: Connector[];
  mappings: Mapping[];
  runs: IntegrationRun[];
  reconciliations: Reconciliation[];
  queue: QueueState[];
  permissions: IntegrationPermissions;
  sankhyaEnabled: boolean;
  companies: Array<{ id: string; legalName: string; tradeName: string }>;
  solidesBoundary: string;
};

export type RunItem = {
  id: string;
  itemKey: string;
  direction: string;
  status: string;
  targetType: string;
  errorCode: string;
  errorMessage: string;
  processedAt: string;
  createdAt: string;
  metadataFields: string[];
};

export type RunJob = {
  id: string;
  jobType: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  lastErrorCode: string;
  lastErrorMessage: string;
  completedAt: string;
  createdAt: string;
};

export type RunDetail = { run: IntegrationRun & { channel?: string; resourceType?: string; direction?: string; mappingVersion?: number }; items: RunItem[]; jobs: RunJob[] };

export type IntegrationEditor =
  | { kind: "configure"; connector: Connector }
  | { kind: "credentials"; connector: Connector }
  | { kind: "revoke"; connector: Connector }
  | { kind: "mapping"; connectorId?: string }
  | { kind: "run"; connectorId?: string }
  | { kind: "reconciliation"; reconciliation: Reconciliation }
  | { kind: "detail"; run: IntegrationRun }
  | null;
