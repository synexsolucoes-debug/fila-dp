export type OperationTab = "overview" | "movements" | "approvals" | "closing" | "obligations" | "pending" | "library";
export type CycleStatus = "open" | "pre_closing" | "processing" | "post_closing" | "closed";
export type WorkStatus = "pending" | "in_progress" | "blocked" | "completed";
export type MovementStatus = "draft" | "pending_approval" | "approved" | "rejected" | "applied" | "canceled";
export type MovementType = "salary_change" | "vacation" | "leave" | "termination" | "transfer" | "benefit_change" | "registration_sync" | "other";

export type CompanyOption = { id: string; name: string; legalName: string; status: string };
export type Cycle = {
  id: string; companyId: string; competence: string; status: CycleStatus;
  preClosingDueDate: string; paymentDate: string; postClosingDueDate: string; closedAt: string; notes: string;
};
export type Demand = { id: string; title: string; processType: string; priority: string; dueAt: string; legalDueAt: string; slaStatus: string; archived: boolean };
export type Movement = {
  id: string; companyId: string; employeeId: string; employeeName: string; socialName: string; payrollCycleId: string;
  movementType: MovementType; effectiveDate: string; title: string; status: MovementStatus; createdAt: string; updatedAt: string;
  details?: Record<string, unknown>;
};
export type Approval = {
  id: string; movementId: string; sequence: number; approverUserId: string; status: "pending" | "approved" | "rejected";
  decidedAt: string; comment: string; movementTitle: string; employeeName: string; canDecide: boolean;
};
export type ClosingItem = {
  id: string; phase: "pre_closing" | "post_closing"; category: string; title: string; status: WorkStatus;
  ownerUserId: string; dueDate: string; completedAt: string; notes: string; position: number;
};
export type Obligation = {
  id: string; obligationType: string; title: string; dueDate: string; status: "open" | "in_progress" | "blocked" | "completed";
  ownerUserId: string; cardId: string; notes: string;
};
export type PendingItem = {
  id: string; sourceType: string; sourceId: string; severity: "info" | "warning" | "critical"; blocking: boolean;
  title: string; dueDate: string; status: "open" | "in_progress" | "resolved" | "waived"; ownerUserId: string; resolution: string;
};
export type ProcessDefinition = { id: string; code: string; name: string; category: string; status: string; latestVersion: number; publishedVersion: number };
export type ProcessVersion = { id: string; definitionId: string; version: number; status: "draft" | "published" | "retired"; configuration: Record<string, unknown>; publishedAt: string };
export type Approver = { id: string; name: string; email: string; role: string };
export type EmployeeOption = { id: string; name: string; registrationNumber: string };
export type OperationPermissions = {
  manageCompetences: boolean; transitionCompetences: boolean; manageMovements: boolean; decideApprovals: boolean;
  manageObligations: boolean; managePending: boolean; manageProcesses: boolean; publishProcesses: boolean;
};
export type OverviewPayload = {
  competence: string; cycle: Cycle | null; cycles: Cycle[]; demands: Demand[]; obligations: Obligation[];
  closingItems: ClosingItem[]; pendingItems: PendingItem[]; processes: ProcessDefinition[]; movements: Movement[];
  approvals: Approval[]; approvers: Approver[]; permissions: OperationPermissions;
};

export type EditorState =
  | { kind: "competence" }
  | { kind: "movement"; movement?: Movement }
  | { kind: "approval"; approval: Approval }
  | { kind: "obligation" }
  | { kind: "pending" }
  | { kind: "pending-resolution"; item: PendingItem; status: "resolved" | "waived" }
  | { kind: "transition"; target: CycleStatus }
  | { kind: "process" }
  | { kind: "process-version"; process: ProcessDefinition }
  | { kind: "process-publish"; version: ProcessVersion; process: ProcessDefinition }
  | null;
