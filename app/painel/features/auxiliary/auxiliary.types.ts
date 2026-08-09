export type AuxiliaryModule = "benefits" | "psychology" | "contractors";
export type AuxiliaryTab = "executions" | "approvals" | "providers" | "history";
export type AuxiliaryStatus = "draft" | "pending_approval" | "approved" | "rejected" | "closed" | "canceled";
export type RevisionStatus = "draft" | "submitted" | "approved" | "rejected" | "superseded";
export type ProviderType = "benefit_operator" | "psychologist" | "contractor";

export type CompanyOption = { id: string; name: string; legalName: string; status: string };
export type CycleOption = { id: string; companyId: string; competence: string; status: string; paymentDate: string; closedAt: string };
export type Provider = {
  id: string; providerType: ProviderType; code: string; legalName: string; tradeName: string;
  taxId: string; email: string; phone: string; status: "active" | "inactive";
};
export type Approver = { id: string; name: string; email: string; role: string };
export type Approval = {
  id: string; executionId: string; revisionId: string; sequence: number; approverUserId: string;
  approverName: string; approverEmail: string; status: "pending" | "approved" | "rejected";
  comment: string; decidedAt: string; canDecide: boolean;
};
export type Revision = {
  id: string; executionId: string; revision: number; status: RevisionStatus;
  input: Record<string, unknown>; output: Record<string, unknown>; createdBy: string; createdAt: string;
};
export type Execution = {
  id: string; companyId: string; payrollCycleId: string; providerId: string; module: AuxiliaryModule;
  referenceCode: string; title: string; status: AuxiliaryStatus; currentRevision: number; totalAmount: number;
  dueDate: string; ownerUserId: string; providerName: string; revisionId: string; revisionStatus: RevisionStatus;
  input: Record<string, unknown>; output: Record<string, unknown>; approvalId: string; approvalStatus: string;
  approverUserId: string; canDecide: boolean; closedAt: string; createdAt: string; updatedAt: string;
};
export type AuxiliaryPermissions = { manage: boolean; requestApproval: boolean; decideApproval: boolean; close: boolean };
export type AuxiliaryOverview = {
  module: AuxiliaryModule; competence: string; cycle: CycleOption | null; cycles: CycleOption[];
  executions: Execution[]; providers: Provider[]; approvers: Approver[]; permissions: AuxiliaryPermissions;
  privacyBoundary: string;
};
export type ExecutionDetail = { execution: Execution; revisions: Revision[]; approvals: Approval[] };

export type AuxiliaryEditor =
  | { kind: "execution"; execution?: Execution }
  | { kind: "revision"; execution: Execution }
  | { kind: "submit"; execution: Execution }
  | { kind: "decision"; execution: Execution; approval: Approval }
  | { kind: "close"; execution: Execution }
  | { kind: "provider"; provider?: Provider }
  | null;
