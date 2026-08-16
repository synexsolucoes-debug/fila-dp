"use client";

import Link from "next/link";
import { KeyboardEvent, useCallback, useEffect, useState } from "react";
import {
  ArrowRight, BadgeCheck, Building2, Check, CheckCircle2, CircleAlert, CircleDot, CreditCard,
  ExternalLink, FileText, Gauge, LoaderCircle, Network, RefreshCw, Rocket, Settings2, ShieldCheck,
  SkipForward, Sparkles, Users, WalletCards, Waypoints,
} from "lucide-react";
import type { WorkspaceRole } from "@/lib/fila-dp-types";
import { navigateToHttps, normalizeSaasOverview, openBillingPortal, requestSaas, startCheckout, updateOnboarding } from "./saas.api";
import type { BillingInterval, OnboardingProfile, OnboardingStep, SaasOverview, SaasPlan, SaasTab } from "./saas.types";
import { ErrorBanner, StatusPill, statusTone } from "../shared";
import styles from "./saas.module.css";

const tabItems: Array<{ id: SaasTab; label: string; icon: typeof Rocket }> = [
  { id: "activation", label: "Ativação", icon: Rocket },
  { id: "plan", label: "Plano e uso", icon: Gauge },
  { id: "invoices", label: "Faturas", icon: FileText },
];

const stepItems: Array<{ id: OnboardingStep; label: string; description: string; icon: typeof Building2; optional?: boolean }> = [
  { id: "company", label: "Empresa", description: "Estrutura principal", icon: Building2 },
  { id: "team", label: "Equipe", description: "Pessoas e acessos", icon: Users },
  { id: "operation", label: "Operação", description: "Primeiro fluxo", icon: Waypoints },
  { id: "integrations", label: "Integrações", description: "Conectores", icon: Network, optional: true },
  { id: "billing", label: "Plano", description: "Cobrança e limites", icon: CreditCard, optional: true },
];

const statusLabels: Record<string, string> = {
  active: "Ativa", trialing: "Período de teste", past_due: "Pagamento pendente", canceled: "Cancelada", unpaid: "Não paga",
  paid: "Paga", open: "Em aberto", void: "Cancelada", uncollectible: "Não recebida", completed: "Concluído",
  in_progress: "Em ativação", dismissed: "Adiado",
};

const featureLabels: Record<string, string> = {
  boards: "Quadros operacionais", inbox: "Inbox multicanal", integrations: "Central de integrações", reports: "Relatórios",
  automation: "Automações", audit: "Auditoria", support: "Suporte prioritário", api: "API pública",
};

const date = (value: string) => {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).format(parsed);
};
const money = (cents: number, currency = "BRL") => new Intl.NumberFormat("pt-BR", { style: "currency", currency, maximumFractionDigits: 0 }).format(cents / 100);

export function SaasView({ role }: { role: WorkspaceRole }) {
  const [overview, setOverview] = useState<SaasOverview | null>(null);
  const [tab, setTab] = useState<SaasTab>("activation");
  const [interval, setInterval] = useState<BillingInterval>("monthly");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setOverview(normalizeSaasOverview(await requestSaas<unknown>("/api/saas/overview"))); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível carregar a central SaaS."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    let active = true;
    void requestSaas<unknown>("/api/saas/overview")
      .then((payload) => { if (active) setOverview(normalizeSaasOverview(payload)); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Não foi possível carregar a central SaaS."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(""), 4200); return () => window.clearTimeout(timer); }, [notice]);

  const completedCount = overview?.onboarding?.completedSteps.length ?? 0;
  const skippedCount = overview?.onboarding?.skippedSteps.length ?? 0;
  const progress = Math.round(((completedCount + skippedCount) / stepItems.length) * 100);

  async function mutateOnboarding(action: string, step?: OnboardingStep, profile?: OnboardingProfile) {
    setBusy(`${action}:${step ?? "profile"}`); setError("");
    try {
      await updateOnboarding(action, { step, profile });
      setNotice(action === "skip" ? "Etapa marcada como opcional." : action === "profile" ? "Perfil de ativação atualizado." : "Etapa concluída com sucesso.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível atualizar a ativação."); }
    finally { setBusy(""); }
  }

  async function checkout(plan: SaasPlan) {
    setBusy(`checkout:${plan.id}`); setError("");
    try {
      const result = await startCheckout(plan.code, interval, Math.max(1, overview?.usage.members ?? 1));
      navigateToHttps(result.url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível abrir o checkout."); setBusy(""); }
  }

  async function portal() {
    setBusy("portal"); setError("");
    try { navigateToHttps((await openBillingPortal()).url); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível abrir o portal de cobrança."); setBusy(""); }
  }

  function tabKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: number) {
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % tabItems.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + tabItems.length) % tabItems.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabItems.length - 1;
    else return;
    event.preventDefault(); setTab(tabItems[next].id);
    document.getElementById(`saas-tab-${tabItems[next].id}`)?.focus();
  }

  if (role !== "admin") return <div className={styles.blocked}><ShieldCheck aria-hidden="true" /><strong>Central reservada à administração</strong><p>Somente administradores do workspace podem consultar planos, uso e cobrança.</p></div>;
  if (loading && !overview) return <div className={styles.loading} aria-live="polite"><LoaderCircle className={styles.spin} aria-hidden="true" /><strong>Preparando a torre de ativação</strong><span>Conferindo plano, uso e prontidão do workspace…</span></div>;
  if (!overview) return <div className={styles.blocked} role="alert"><CircleAlert aria-hidden="true" /><strong>Central SaaS indisponível</strong><p>{error}</p><button type="button" onClick={() => void load()}><RefreshCw aria-hidden="true" /> Tentar novamente</button></div>;

  return <section className={styles.workspace} aria-label="Central SaaS do workspace">
    <header className={styles.commandDeck}>
      <div><span className={styles.eyebrow}>TORRE DE ATIVAÇÃO · {overview.workspace.name}</span><h2>Workspace pronto para decolar.</h2><p>Conclua a implantação, acompanhe os limites e mantenha a assinatura sob controle.</p></div>
      <div className={styles.commandStatus} data-tone={statusTone(overview.subscription?.status ?? "neutral")}><span><CircleDot aria-hidden="true" /> Assinatura</span><strong>{statusLabels[overview.subscription?.status ?? ""] ?? "Sem assinatura"}</strong><small>{overview.subscription?.plan.name ?? "Plano não definido"}</small></div>
      {overview.permissions.platform && <Link className={styles.platformLink} href="/plataforma"><ShieldCheck aria-hidden="true" /><span><strong>Console global</strong><small>Acesso autorizado entre workspaces</small></span><ArrowRight aria-hidden="true" /></Link>}
    </header>
    {error && <ErrorBanner title="A operação não foi concluída" message={error} onDismiss={() => setError("")} />}

    <section className={styles.readinessRail} aria-label={`Ativação ${progress}% concluída`}>
      <header><div><span className={styles.eyebrow}>PISTA DE PRONTIDÃO</span><strong>{progress}% operacional</strong></div><div className={styles.progressTrack} role="progressbar" aria-label="Progresso da ativação" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><i style={{ width: `${progress}%` }} /></div><small>{completedCount} concluída(s) · {skippedCount} opcional(is)</small></header>
      <ol>{stepItems.map((item, index) => {
        const completed = overview.onboarding?.completedSteps.includes(item.id) ?? false;
        const skipped = overview.onboarding?.skippedSteps.includes(item.id) ?? false;
        const current = overview.onboarding?.currentStep === item.id;
        const Icon = item.icon;
        return <li key={item.id} data-state={completed ? "complete" : skipped ? "skipped" : current ? "current" : "pending"}>
          <span className={styles.stationIndex}>{String(index + 1).padStart(2, "0")}</span><span className={styles.stationIcon}>{completed ? <Check aria-hidden="true" /> : skipped ? <SkipForward aria-hidden="true" /> : <Icon aria-hidden="true" />}</span>
          <div><strong>{item.label}</strong><small>{completed ? "Concluída" : skipped ? "Opcional" : current ? "Etapa atual" : item.description}</small></div>{index < stepItems.length - 1 && <ArrowRight className={styles.railArrow} aria-hidden="true" />}
        </li>;
      })}</ol>
    </section>

    <nav className={styles.tabs} role="tablist" aria-label="Seções da central SaaS">
      {tabItems.map((item, index) => { const Icon = item.icon; return <button key={item.id} id={`saas-tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls={`saas-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} className={tab === item.id ? styles.activeTab : ""} onClick={() => setTab(item.id)} onKeyDown={(event) => tabKeyDown(event, index)}><Icon aria-hidden="true" />{item.label}{item.id === "invoices" && <b>{overview.invoices.length}</b>}</button>; })}
    </nav>

    <div id={`saas-panel-${tab}`} className={styles.tabPanel} role="tabpanel" aria-labelledby={`saas-tab-${tab}`} tabIndex={0}>
      {tab === "activation" && <ActivationPanel key={overview.onboarding?.updatedAt ?? "not-started"} overview={overview} busy={busy} onMutate={mutateOnboarding} />}
      {tab === "plan" && <PlanPanel overview={overview} interval={interval} busy={busy} onInterval={setInterval} onCheckout={checkout} onPortal={portal} />}
      {tab === "invoices" && <InvoicesPanel overview={overview} onPortal={portal} busy={busy} />}
    </div>

    {notice && <div className={styles.toast} role="status"><CheckCircle2 aria-hidden="true" />{notice}</div>}
  </section>;
}

function ActivationPanel({ overview, busy, onMutate }: { overview: SaasOverview; busy: string; onMutate: (action: string, step?: OnboardingStep, profile?: OnboardingProfile) => Promise<void> }) {
  const onboarding = overview.onboarding;
  const [profile, setProfile] = useState<OnboardingProfile>(onboarding?.profile ?? { teamSize: "", primaryGoal: "", source: "" });
  return <div className={styles.activationLayout}>
    <section className={styles.activationSequence}>
      <header><div><span className={styles.eyebrow}>CHECKLIST GUIADO</span><h3>Sequência de ativação</h3><p>Cada liberação deixa o workspace mais preparado para operar em escala.</p></div><StatusBadge status={onboarding?.status ?? "in_progress"} /></header>
      {!onboarding ? <Empty icon={Rocket} title="Ativação ainda não iniciada" text="O roteiro aparecerá assim que o workspace for provisionado." /> : <ol>{stepItems.map((item, index) => {
        const complete = onboarding.completedSteps.includes(item.id); const skipped = onboarding.skippedSteps.includes(item.id); const current = onboarding.currentStep === item.id;
        const Icon = item.icon;
        return <li key={item.id} data-state={complete ? "complete" : skipped ? "skipped" : current ? "current" : "pending"}>
          <span className={styles.sequenceNumber}>{String(index + 1).padStart(2, "0")}</span><span className={styles.sequenceIcon}>{complete ? <Check aria-hidden="true" /> : <Icon aria-hidden="true" />}</span>
          <div><strong>{item.label}</strong><p>{item.description}{item.optional ? " · etapa opcional" : " · etapa obrigatória"}</p></div>
          <StatusBadge status={complete ? "completed" : skipped ? "dismissed" : current ? "in_progress" : "pending"} />
          {!complete && !skipped && <div className={styles.stepActions}><button className={styles.primaryButton} type="button" disabled={Boolean(busy)} onClick={() => void onMutate("complete", item.id)}>{busy === `complete:${item.id}` ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />} Concluir</button>{item.optional && <button className={styles.secondaryButton} type="button" disabled={Boolean(busy)} onClick={() => void onMutate("skip", item.id)}><SkipForward aria-hidden="true" /> Agora não</button>}</div>}
        </li>;
      })}</ol>}
    </section>

    <aside className={styles.profilePanel}>
      <header><Settings2 aria-hidden="true" /><div><span className={styles.eyebrow}>PERFIL ALLOWLISTED</span><h3>Contexto do grupo</h3></div></header>
      <p>Essas respostas ajudam a calibrar a ativação. Nenhum dado livre ou sensível é solicitado.</p>
      <form onSubmit={(event) => { event.preventDefault(); void onMutate("profile", undefined, profile); }}>
        <label>Tamanho da equipe<select value={profile.teamSize} onChange={(event) => setProfile((current) => ({ ...current, teamSize: event.target.value }))}><option value="">Selecione</option><option value="1-5">1 a 5 pessoas</option><option value="6-20">6 a 20 pessoas</option><option value="21-50">21 a 50 pessoas</option><option value="51-200">51 a 200 pessoas</option><option value="201+">Mais de 200</option></select></label>
        <label>Objetivo principal<select value={profile.primaryGoal} onChange={(event) => setProfile((current) => ({ ...current, primaryGoal: event.target.value }))}><option value="">Selecione</option><option value="organize">Organizar a operação</option><option value="deadlines">Controlar prazos</option><option value="integrations">Conectar sistemas</option><option value="governance">Aumentar governança</option><option value="scale">Escalar atendimento</option></select></label>
        <label>Como conheceu o Vinculato<select value={profile.source} onChange={(event) => setProfile((current) => ({ ...current, source: event.target.value }))}><option value="">Selecione</option><option value="search">Pesquisa</option><option value="referral">Indicação</option><option value="social">Redes sociais</option><option value="partner">Parceiro</option><option value="other">Outro</option></select></label>
        <button className={styles.primaryButton} disabled={Boolean(busy)}>{busy === "profile:profile" ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : <BadgeCheck aria-hidden="true" />} Salvar perfil</button>
      </form>
    </aside>
  </div>;
}

function PlanPanel({ overview, interval, busy, onInterval, onCheckout, onPortal }: { overview: SaasOverview; interval: BillingInterval; busy: string; onInterval: (value: BillingInterval) => void; onCheckout: (plan: SaasPlan) => void; onPortal: () => void }) {
  const current = overview.plans.find((plan) => plan.id === overview.subscription?.plan.id) ?? null;
  const limits = current ? [
    { label: "Usuários", value: overview.usage.members, limit: current.includedSeats, icon: Users },
    { label: "Empresas", value: overview.usage.companies, limit: current.companyLimit, icon: Building2 },
    { label: "Integrações", value: overview.usage.integrations, limit: current.integrationLimit, icon: Network },
    { label: "Armazenamento", value: overview.usage.storageMb, limit: current.storageLimitMb, icon: FileText, unit: " MB" },
  ] : [];
  return <div className={styles.planLayout}>
    <section className={styles.currentPlan}>
      <div><span className={styles.eyebrow}>PLANO EM OPERAÇÃO</span><h3>{overview.subscription?.plan.name ?? "Sem plano ativo"}</h3><p>{current?.description || "Selecione um plano publicado para liberar limites e cobrança."}</p><div className={styles.subscriptionMeta}><StatusBadge status={overview.subscription?.status ?? "neutral"} /><span><WalletCards aria-hidden="true" />{overview.subscription?.billingInterval === "annual" ? "Ciclo anual" : "Ciclo mensal"}</span>{overview.subscription?.currentPeriodEndsAt && <span>Renovação em {date(overview.subscription.currentPeriodEndsAt)}</span>}</div></div>
      <button className={styles.secondaryButton} type="button" disabled={busy === "portal"} onClick={onPortal}>{busy === "portal" ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : <ExternalLink aria-hidden="true" />} Gerenciar cobrança</button>
    </section>
    <section className={styles.usagePanel} aria-label="Uso do plano"><header><div><span className={styles.eyebrow}>TELEMETRIA DE COTA</span><h3>Uso atual</h3></div><small>Atualizado nesta consulta</small></header>{limits.length ? <div>{limits.map((item) => { const percentage = Math.min(100, Math.round((item.value / Math.max(1, item.limit)) * 100)); const Icon = item.icon; return <article key={item.label} data-tone={percentage >= 90 ? "danger" : percentage >= 70 ? "warning" : "safe"}><Icon aria-hidden="true" /><div><span><strong>{item.label}</strong><b>{item.value.toLocaleString("pt-BR")}{item.unit ?? ""} / {item.limit.toLocaleString("pt-BR")}{item.unit ?? ""}</b></span><i role="progressbar" aria-label={`${item.label}: ${item.value} de ${item.limit}`} aria-valuemin={0} aria-valuemax={item.limit} aria-valuenow={item.value}><b style={{ width: `${percentage}%` }} /></i><small>{percentage}% utilizado</small></div></article>; })}</div> : <Empty icon={Gauge} title="Limites indisponíveis" text="Associe um plano ao workspace para acompanhar as cotas." />}</section>
    <section className={styles.planComparison}>
      <header><div><span className={styles.eyebrow}>FAIXAS DE CAPACIDADE</span><h3>Compare planos ativos</h3><p>Escolha a capacidade compatível com o momento do grupo.</p></div><div className={styles.intervalSwitch} aria-label="Periodicidade de cobrança"><button type="button" aria-pressed={interval === "monthly"} onClick={() => onInterval("monthly")}>Mensal</button><button type="button" aria-pressed={interval === "annual"} onClick={() => onInterval("annual")}>Anual <b>economia</b></button></div></header>
      {overview.plans.length ? <div className={styles.planRows}>{overview.plans.map((plan) => { const isCurrent = plan.id === overview.subscription?.plan.id; const price = interval === "annual" ? plan.annualPriceCents : plan.monthlyPriceCents; const available = plan.checkout[interval]; return <article key={plan.id} data-current={isCurrent}><div className={styles.planIdentity}>{isCurrent ? <span><Sparkles aria-hidden="true" /> PLANO ATUAL</span> : <span>PLANO {plan.code.toUpperCase()}</span>}<strong>{plan.name}</strong><p>{plan.description}</p></div><div className={styles.planPrice}><strong>{money(price, plan.currency)}</strong><span>/{interval === "annual" ? "ano" : "mês"}</span><small>{plan.includedSeats} assento(s) incluído(s)</small></div><ul>{plan.features.slice(0, 4).map((feature) => <li key={feature}><Check aria-hidden="true" />{featureLabels[feature] ?? feature.replaceAll("_", " ")}</li>)}</ul><dl><div><dt>Empresas</dt><dd>{plan.companyLimit}</dd></div><div><dt>Integrações</dt><dd>{plan.integrationLimit}</dd></div><div><dt>Armazenamento</dt><dd>{plan.storageLimitMb} MB</dd></div></dl><button className={isCurrent ? styles.secondaryButton : styles.primaryButton} type="button" disabled={isCurrent || !available || Boolean(busy)} onClick={() => onCheckout(plan)}>{busy === `checkout:${plan.id}` ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : isCurrent ? <CheckCircle2 aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}{isCurrent ? "Plano atual" : available ? "Selecionar" : "Indisponível"}</button></article>; })}</div> : <Empty icon={CreditCard} title="Nenhum plano publicado" text="Os planos ativos aparecerão aqui quando forem liberados pela plataforma." />}
    </section>
  </div>;
}

function InvoicesPanel({ overview, onPortal, busy }: { overview: SaasOverview; onPortal: () => void; busy: string }) {
  return <section className={styles.invoicesPanel}><header><div><span className={styles.eyebrow}>LEDGER DE COBRANÇA</span><h3>Histórico de faturas</h3><p>Valores e estados recebidos do provedor de cobrança.</p></div><button className={styles.secondaryButton} type="button" disabled={busy === "portal"} onClick={onPortal}><ExternalLink aria-hidden="true" /> Portal de cobrança</button></header>
    {overview.invoices.length ? <div className={styles.invoiceList}>{overview.invoices.map((invoice) => <article key={invoice.id} data-tone={statusTone(invoice.status)}><span className={styles.invoiceIcon}><FileText aria-hidden="true" /></span><div><small>FATURA · {invoice.id.slice(0, 8).toUpperCase()}</small><strong>{money(invoice.amountDueCents, invoice.currency)}</strong><span>{date(invoice.periodStartsAt || invoice.createdAt)} → {date(invoice.periodEndsAt)}</span></div><StatusBadge status={invoice.status} /><div className={styles.invoicePaid}><small>Valor pago</small><strong>{money(invoice.amountPaidCents, invoice.currency)}</strong></div>{invoice.hostedInvoiceUrl.startsWith("https://") ? <a href={invoice.hostedInvoiceUrl} target="_blank" rel="noreferrer">Abrir fatura <ExternalLink aria-hidden="true" /></a> : <span className={styles.invoiceUnavailable}>Link indisponível</span>}</article>)}</div> : <Empty icon={FileText} title="Nenhuma fatura emitida" text="Quando o provedor emitir uma cobrança, ela aparecerá nesta linha do tempo." />}
  </section>;
}

function StatusBadge({ status }: { status: string }) { return <StatusPill status={status} label={statusLabels[status] ?? (status === "pending" ? "Pendente" : status)} />; }
function Empty({ icon: Icon, title, text }: { icon: typeof Rocket; title: string; text: string }) { return <div className={styles.empty}><Icon aria-hidden="true" /><strong>{title}</strong><p>{text}</p></div>; }
