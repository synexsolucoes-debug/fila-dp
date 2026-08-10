/**
 * Prontidão de cobrança (§73 e §103).
 *
 * O código de assinatura existe desde a Fase 7, mas "existir código" não é o
 * mesmo que "conseguir cobrar um cliente real". Esta verificação transforma a
 * pergunta em uma lista objetiva de bloqueios, e nunca devolve `ready` sem que
 * todos eles estejam resolvidos — inclusive as provas de que o checkout e o
 * webhook funcionaram de fato ao menos uma vez.
 */
export type ReadinessSeverity = "blocker" | "warning" | "info";

export type ReadinessCheck = {
  key: string;
  label: string;
  severity: ReadinessSeverity;
  passed: boolean;
  detail: string;
  /** O que fazer para resolver, quando não passou. */
  remedy?: string;
};

export type BillingReadinessInput = {
  stripeSecretConfigured: boolean;
  stripeWebhookSecretConfigured: boolean;
  publicUrlConfigured: boolean;
  selfSignupEnabled: boolean;
  plans: {
    code: string;
    status: string;
    monthlyPriceCents: number;
    annualPriceCents: number;
    stripeMonthlyPriceId: string;
    stripeAnnualPriceId: string;
  }[];
  processedWebhookEvents: number;
  failedWebhookEvents: number;
  activeSubscriptions: number;
  paidInvoices: number;
};

export function evaluateBillingReadiness(input: BillingReadinessInput) {
  const activePlans = input.plans.filter((plan) => plan.status === "active");
  const draftPlans = input.plans.filter((plan) => plan.status === "draft");
  const pricedPlans = activePlans.filter((plan) => plan.monthlyPriceCents > 0 || plan.annualPriceCents > 0);
  const misconfigured = pricedPlans.filter((plan) =>
    (plan.monthlyPriceCents > 0 && !plan.stripeMonthlyPriceId)
    || (plan.annualPriceCents > 0 && !plan.stripeAnnualPriceId));

  const checks: ReadinessCheck[] = [
    {
      key: "stripe_secret",
      label: "Chave secreta do provedor configurada",
      severity: "blocker",
      passed: input.stripeSecretConfigured,
      detail: input.stripeSecretConfigured ? "STRIPE_SECRET_KEY presente." : "STRIPE_SECRET_KEY ausente.",
      remedy: "Configure STRIPE_SECRET_KEY no ambiente de produção.",
    },
    {
      key: "stripe_webhook_secret",
      label: "Segredo do webhook configurado",
      severity: "blocker",
      passed: input.stripeWebhookSecretConfigured,
      detail: input.stripeWebhookSecretConfigured ? "STRIPE_WEBHOOK_SECRET presente." : "STRIPE_WEBHOOK_SECRET ausente.",
      remedy: "Configure STRIPE_WEBHOOK_SECRET com o segredo do endpoint cadastrado no provedor.",
    },
    {
      key: "public_url",
      label: "URL pública configurada",
      severity: "blocker",
      passed: input.publicUrlConfigured,
      detail: input.publicUrlConfigured ? "FDP_APP_URL presente." : "FDP_APP_URL ausente.",
      remedy: "Configure FDP_APP_URL para que checkout e portal retornem ao domínio correto.",
    },
    {
      key: "active_plans",
      label: "Existe plano ativo no catálogo",
      severity: "blocker",
      passed: activePlans.length > 0,
      detail: `${activePlans.length} plano(s) ativo(s), ${draftPlans.length} em rascunho.`,
      remedy: "Publique ao menos um plano no painel da plataforma antes de vender.",
    },
    {
      key: "plan_prices",
      label: "Planos com preço possuem identificador no provedor",
      severity: "blocker",
      passed: misconfigured.length === 0,
      detail: misconfigured.length === 0
        ? `${pricedPlans.length} plano(s) com preço configurado.`
        : `Sem identificador de preço: ${misconfigured.map((plan) => plan.code).join(", ")}.`,
      remedy: "Preencha stripe_monthly_price_id e stripe_annual_price_id dos planos com preço.",
    },
    {
      key: "webhook_proof",
      label: "Webhook do provedor já processou evento real",
      severity: "blocker",
      passed: input.processedWebhookEvents > 0,
      detail: `${input.processedWebhookEvents} evento(s) processado(s), ${input.failedWebhookEvents} com falha.`,
      remedy: "Dispare um evento de teste no provedor e confirme o processamento antes de abrir a venda.",
    },
    {
      key: "checkout_proof",
      label: "Existe assinatura criada pelo fluxo de checkout",
      severity: "blocker",
      passed: input.activeSubscriptions > 0,
      detail: `${input.activeSubscriptions} assinatura(s) em avaliação ou ativa(s).`,
      remedy: "Conclua uma assinatura em modo de teste para provar o fluxo de ponta a ponta.",
    },
    {
      key: "webhook_failures",
      label: "Sem falhas recentes de webhook",
      severity: "warning",
      passed: input.failedWebhookEvents === 0,
      detail: input.failedWebhookEvents === 0 ? "Nenhuma falha registrada." : `${input.failedWebhookEvents} evento(s) com falha.`,
      remedy: "Investigue os eventos com falha antes de considerar a cobrança estável.",
    },
    {
      key: "invoice_proof",
      label: "Existe fatura paga registrada",
      severity: "warning",
      passed: input.paidInvoices > 0,
      detail: `${input.paidInvoices} fatura(s) paga(s).`,
      remedy: "Uma cobrança concluída confirma o ciclo financeiro completo.",
    },
    {
      key: "self_signup",
      label: "Cadastro público",
      severity: "info",
      passed: true,
      detail: input.selfSignupEnabled ? "Aberto (FDP_ALLOW_SELF_SIGNUP=true)." : "Fechado; contas são criadas pela operação.",
    },
  ];

  const blockers = checks.filter((check) => check.severity === "blocker" && !check.passed);
  const warnings = checks.filter((check) => check.severity === "warning" && !check.passed);

  // Cadastro aberto sem cobrança pronta é risco comercial: o cliente entra e não
  // consegue pagar. O relatório trata isso como bloqueio explícito.
  const signupWithoutBilling = input.selfSignupEnabled && blockers.length > 0;

  return {
    ready: blockers.length === 0,
    checks,
    blockers: blockers.map((check) => check.key),
    warnings: warnings.map((check) => check.key),
    signupWithoutBilling,
    summary: blockers.length === 0
      ? warnings.length === 0
        ? "Cobrança pronta para clientes pagantes."
        : `Cobrança operacional, com ${warnings.length} ponto(s) de atenção.`
      : `Cobrança não está pronta: ${blockers.length} bloqueio(s) pendente(s).`,
  };
}
