export type IntegrationChannel = "email" | "whatsapp" | "teams" | "drive" | "onedrive" | "solides" | "erp";
export type IntegrationTab = "connectors" | "mappings" | "runs" | "reconciliations";
export type ConnectorStatus = "connected" | "needs_credentials" | "paused" | "error";
export type MappingStatus = "draft" | "active" | "archived";
export type RunStatus = "queued" | "running" | "succeeded" | "partial" | "failed";

export type IntegrationPermissions = { manage: boolean; run: boolean; reconcile: boolean };

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
