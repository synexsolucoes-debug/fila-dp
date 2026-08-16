export type SaasTab = "activation" | "plan" | "invoices";
export type OnboardingStep = "company" | "team" | "operation" | "integrations" | "billing";
export type BillingInterval = "monthly" | "annual";

export type OnboardingProfile = {
  teamSize: string;
  primaryGoal: string;
  source: string;
};

export type SaasPlan = {
  id: string;
  code: string;
  name: string;
  description: string;
  status: string;
  currency: string;
  monthlyPriceCents: number;
  annualPriceCents: number;
  trialDays: number;
  includedSeats: number;
  companyLimit: number;
  integrationLimit: number;
  storageLimitMb: number;
  features: string[];
  checkout: { monthly: boolean; annual: boolean };
};

export type Subscription = {
  id: string;
  status: string;
  billingInterval: BillingInterval;
  seatQuantity: number;
  provider: string;
  trialEndsAt: string;
  currentPeriodStartsAt: string;
  currentPeriodEndsAt: string;
  cancelAtPeriodEnd: boolean;
  canceledAt: string;
  plan: { id: string; code: string; name: string };
};

export type Onboarding = {
  status: string;
  currentStep: string;
  completedSteps: OnboardingStep[];
  skippedSteps: OnboardingStep[];
  profile: OnboardingProfile;
  completedAt: string;
  updatedAt: string;
};

export type Invoice = {
  id: string;
  status: string;
  currency: string;
  amountDueCents: number;
  amountPaidCents: number;
  hostedInvoiceUrl: string;
  periodStartsAt: string;
  periodEndsAt: string;
  paidAt: string;
  createdAt: string;
};

export type SaasOverview = {
  workspace: { id: string; name: string };
  plans: SaasPlan[];
  subscription: Subscription | null;
  onboarding: Onboarding | null;
  invoices: Invoice[];
  usage: { members: number; companies: number; integrations: number; storageMb: number };
  permissions: { manage: boolean; exportData: boolean; platform: boolean };
};
