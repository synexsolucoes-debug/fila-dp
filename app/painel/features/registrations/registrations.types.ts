export type RegistrationTab = "companies" | "employees" | "contractors" | "catalogs";
export type EmployeeDetailTab = "personal" | "employment" | "contact" | "epi" | "history";
export type CatalogResource = "departments" | "positions" | "cost-centers" | "work-schedules";
export type RecordStatus = "active" | "inactive";

export type Company = {
  id: string;
  parentCompanyId: string | null;
  isPrincipal: boolean;
  legalName: string;
  tradeName: string;
  taxId: string;
  externalCode: string;
  email: string;
  phone: string;
  status: RecordStatus;
  taxRegime: string;
  stateRegistration: string;
  municipalRegistration: string;
  postalCode: string;
  street: string;
  streetNumber: string;
  addressComplement: string;
  district: string;
  city: string;
  state: string;
  country: string;
};

export type Employee = {
  id: string;
  companyId: string;
  companyName: string;
  departmentId: string | null;
  departmentName: string;
  positionId: string | null;
  positionName: string;
  costCenterId: string | null;
  costCenterName: string;
  workScheduleId: string | null;
  workScheduleName: string;
  managerEmployeeId: string | null;
  registrationNumber: string;
  fullName: string;
  socialName: string;
  cpfLast4: string;
  email: string;
  phone: string;
  birthDate: string;
  admissionDate: string;
  terminationDate: string;
  employmentStatus: "active" | "on_leave" | "terminated";
  employmentType: "clt" | "intern" | "apprentice" | "temporary";
  workModel: "onsite" | "hybrid" | "remote";
  sourceSystem: "manual" | "solides" | "sankhya";
  externalId: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export type CatalogItem = {
  id: string;
  companyId: string;
  code: string;
  name: string;
  status: RecordStatus;
  cboCode: string;
  weeklyHours: number | null;
  description: string;
  parentDepartmentId: string | null;
};

export type HistoryEvent = {
  id: string;
  actorEmail: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type EmployeeDraft = {
  companyId: string;
  registrationNumber: string;
  fullName: string;
  socialName: string;
  cpf: string;
  departmentId: string;
  positionId: string;
  costCenterId: string;
  workScheduleId: string;
  admissionDate: string;
  birthDate: string;
  terminationDate: string;
  employmentStatus: Employee["employmentStatus"];
  employmentType: Employee["employmentType"];
  workModel: Employee["workModel"];
  email: string;
  phone: string;
  notes: string;
};

export type CompanyDraft = Omit<Company, "id" | "isPrincipal"> & { companyType: "principal" | "branch" };
