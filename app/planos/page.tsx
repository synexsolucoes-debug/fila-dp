import Link from "next/link";
import type { Metadata } from "next";
import { getD1 } from "@/db";
import { SiteHero, SiteShell, siteStyles as styles } from "../site/SiteShell";
import { selfSignupEnabled } from "@/lib/saas";

export const metadata: Metadata = {
  title: "Planos | Vinculato",
  description: "Planos publicados no catálogo do produto. Condições comerciais que ainda não estão ativas aparecem como conversa com a equipe, não como oferta.",
};

export const dynamic = "force-dynamic";

type PlanRow = {
  code: string; name: string; description: string; currency: string;
  monthly_price_cents: number; annual_price_cents: number; trial_days: number;
  included_seats: number; company_limit: number; integration_limit: number; storage_limit_mb: number;
  stripe_monthly_price_id: string;
};

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

/**
 * A página lê o catálogo persistido e mostra apenas planos ativos.
 *
 * Um plano só exibe preço e botão de contratação quando está ativo e possui
 * preço configurado no provedor de pagamento. Sem isso, ele aparece como
 * condição a combinar — nunca como oferta fechada que o produto não sabe cobrar.
 */
async function loadPlans(): Promise<PlanRow[]> {
  try {
    const d1 = getD1();
    const rows = await d1.prepare(`SELECT code, name, description, currency, monthly_price_cents, annual_price_cents,
        trial_days, included_seats, company_limit, integration_limit, storage_limit_mb, stripe_monthly_price_id
      FROM fdp_saas_plans WHERE status = 'active' ORDER BY position, monthly_price_cents`).all<PlanRow>();
    return rows.results;
  } catch {
    // Sem banco disponível na renderização, a página não inventa preço.
    return [];
  }
}

export default async function PlanosPage() {
  const plans = await loadPlans();
  const signupOpen = selfSignupEnabled();

  return (
    <SiteShell active="/planos">
      <SiteHero
        eyebrow="Planos"
        title="Condições comerciais publicadas"
        description="Esta página mostra o catálogo real do produto. Se um plano ainda não está publicado com preço configurado, ele aparece como conversa com a equipe — preferimos combinar a condição a anunciar algo que o sistema ainda não cobra."
      />

      <section className={styles.section}>
        {plans.length === 0 ? (
          <article className={styles.card}>
            <h3>Condições sob consulta</h3>
            <p>
              Nenhum plano está publicado no catálogo neste momento. As condições são definidas com a equipe conforme
              número de empresas, volume de colaboradores e integrações necessárias.
            </p>
            <p style={{ marginTop: 14 }}>
              <Link className={styles.primaryButton} href="/contato?assunto=planos">Falar sobre planos</Link>
            </p>
          </article>
        ) : (
          <div className={styles.planGrid}>
            {plans.map((plan) => {
              const payable = plan.monthly_price_cents > 0 && Boolean(plan.stripe_monthly_price_id);
              return (
                <article key={plan.code} className={styles.plan}>
                  <h3>{plan.name}</h3>
                  {payable ? (
                    <span className={styles.planPrice}>
                      {money(plan.monthly_price_cents, plan.currency)}
                      <small>por mês{plan.annual_price_cents > 0 ? ` · ${money(plan.annual_price_cents, plan.currency)} no plano anual` : ""}</small>
                    </span>
                  ) : (
                    <span className={styles.planPrice}>
                      Sob consulta
                      <small>condição combinada com a equipe</small>
                    </span>
                  )}
                  {plan.description && <p style={{ color: "var(--site-soft)", fontSize: ".88rem", margin: 0 }}>{plan.description}</p>}
                  <ul className={styles.planList}>
                    <li>{plan.included_seats} usuário(s) incluídos</li>
                    <li>{plan.company_limit} empresa(s)</li>
                    <li>{plan.integration_limit} integração(ões)</li>
                    <li>{Math.round(plan.storage_limit_mb / 1024 * 10) / 10} GB de anexos</li>
                    {plan.trial_days > 0 && <li>{plan.trial_days} dias de avaliação</li>}
                  </ul>
                  <Link
                    className={payable && signupOpen ? styles.primaryButton : styles.ghostButton}
                    href={payable && signupOpen ? "/login" : `/contato?assunto=planos&plano=${encodeURIComponent(plan.code)}`}
                  >
                    {payable && signupOpen ? "Começar agora" : "Falar com a equipe"}
                  </Link>
                </article>
              );
            })}
          </div>
        )}

        <p className={styles.planNote}>
          Cobrança por cartão, Pix ou boleto conforme a condição contratada. Upgrade, downgrade e cancelamento são
          feitos no próprio painel, e o histórico financeiro fica registrado no workspace.
        </p>
      </section>

      <section className={styles.section}>
        <h2>O que está incluído em qualquer condição</h2>
        <div className={styles.cardGrid}>
          <article className={styles.card}><h3>Isolamento entre clientes</h3><p>Cada workspace é separado no banco por Row Level Security, com testes automatizados que exigem a negação de acesso cruzado.</p></article>
          <article className={styles.card}><h3>Auditoria</h3><p>Trilha com ator, ação, antes e depois para mudanças administrativas, fechamentos, pagamentos e exportações.</p></article>
          <article className={styles.card}><h3>API e webhooks</h3><p>Chave com escopos, limite por minuto, idempotência nas escritas e eventos assinados com HMAC.</p></article>
          <article className={styles.card}><h3>Suporte com acesso controlado</h3><p>O acesso da equipe de suporte aos dados do cliente é autorizado, temporário, justificado e auditado.</p></article>
        </div>
      </section>
    </SiteShell>
  );
}
