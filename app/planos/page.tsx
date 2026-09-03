import Link from "next/link";
import type { Metadata } from "next";
import { getD1 } from "@/db";
import { SiteHero, SiteShell, siteStyles as styles } from "../site/SiteShell";
import { selfSignupEnabled } from "@/lib/saas";
import {
  commercialCommitments, describePlanOffer, planLimitBehaviour, type PlanCatalogRow, type PlanOffer,
} from "@/lib/marketing";

export const metadata: Metadata = {
  alternates: { canonical: "/planos" },
  title: "Planos e limites | Vinculato",
  description: "Preços, limites e módulos de cada plano, lidos do catálogo do produto. O que ainda não pode ser contratado sozinho aparece como conversa com a equipe, não como oferta.",
};

export const dynamic = "force-dynamic";

type ModuleRow = { plan_code: string; key: string; name: string; description: string; position: number };

type Catalog = {
  /** `false` quando o catálogo não pôde ser lido — não é o mesmo que "sem planos". */
  available: boolean;
  plans: PlanCatalogRow[];
  modules: ModuleRow[];
};

/**
 * A página lê o catálogo persistido e mostra apenas planos ativos.
 *
 * Duas ausências que não podem ser confundidas: catálogo vazio e catálogo
 * indisponível. A versão anterior tratava as duas como "condições sob consulta",
 * o que transformava uma falha de leitura em oferta comercial — o visitante lia
 * "combinamos com você" quando o certo era "não conseguimos consultar agora".
 */
async function loadCatalog(): Promise<Catalog> {
  try {
    const d1 = getD1();
    const plans = await d1.prepare(`SELECT code, name, description, currency, monthly_price_cents, annual_price_cents,
        trial_days, included_seats, company_limit, integration_limit, storage_limit_mb, stripe_monthly_price_id
      FROM fdp_saas_plans WHERE status = 'active' ORDER BY position, monthly_price_cents`).all<PlanCatalogRow>();
    // A matriz de módulos por plano é catálogo, não texto de marketing: dizer
    // que API e webhooks estão "em todos os planos" seria falso — o módulo de
    // Integrações começa no plano que o catálogo diz, e é ele quem manda aqui.
    const modules = await d1.prepare(`SELECT plan.code AS plan_code, module.key, module.name, module.description, module.position
      FROM fdp_plan_modules link
      JOIN fdp_saas_plans plan ON plan.id = link.plan_id
      JOIN fdp_modules module ON module.key = link.module_key
      WHERE plan.status = 'active' AND module.status = 'active'
      ORDER BY module.position, plan.position`).all<ModuleRow>();
    return { available: true, plans: plans.results, modules: modules.results };
  } catch {
    return { available: false, plans: [], modules: [] };
  }
}

function PlanCard({ offer }: { offer: PlanOffer }) {
  return (
    <article className={styles.plan} data-recommended={offer.recommended ? "true" : undefined}>
      {offer.recommended && <span className={styles.planFlag}>Mais escolhido</span>}
      <h3>{offer.name}</h3>
      <span className={styles.planPrice}>
        {offer.price}
        <small>{offer.priceNote}</small>
      </span>
      {offer.description && <p className={styles.planDescription}>{offer.description}</p>}
      <ul className={styles.planList}>
        {offer.limits.map((limit) => <li key={limit.label}>{limit.value} — {limit.label.toLowerCase()}</li>)}
      </ul>
      {offer.limitsNote && <p className={styles.planFootnote}>{offer.limitsNote}</p>}
      <Link
        className={offer.contracting === "specialist" ? styles.ghostButton : styles.primaryButton}
        href={offer.ctaHref}
      >
        {offer.ctaLabel}
      </Link>
    </article>
  );
}

export default async function PlanosPage() {
  const catalog = await loadCatalog();
  const signupOpen = selfSignupEnabled();
  const offers = catalog.plans.map((plan) => describePlanOffer(plan, { signupOpen }));

  // Ordem dos módulos pelo catálogo, e só os que algum plano ativo inclui: um
  // conector técnico que não pertence a plano nenhum viraria uma linha inteira
  // de traços.
  const moduleRows = [...new Map(catalog.modules.map((row) => [row.key, row])).values()]
    .sort((a, b) => a.position - b.position);
  const includedIn = new Set(catalog.modules.map((row) => `${row.plan_code}:${row.key}`));

  return (
    <SiteShell active="/planos">
      <SiteHero
        eyebrow="Planos"
        title="Preço, limites e módulos de cada plano"
        description="Esta página mostra o catálogo real do produto. Um plano só exibe contratação direta quando está ativo e com preço configurado no provedor de pagamento; fora disso, a condição é fechada com a equipe — preferimos combinar a anunciar algo que o sistema ainda não cobra."
      />

      <section className={styles.section}>
        {!catalog.available ? (
          <article className={styles.card} role="status">
            <h3>Condição temporariamente indisponível</h3>
            <p>
              Não foi possível consultar o catálogo de planos agora. Nenhum preço é exibido nesta situação: um valor
              inventado enquanto a consulta falha valeria menos que a ausência dele. Tente novamente em alguns minutos.
            </p>
            <p className={styles.cardAction}>
              <Link className={styles.primaryButton} href="/contato?assunto=planos">Falar sobre planos</Link>
            </p>
          </article>
        ) : offers.length === 0 ? (
          <article className={styles.card}>
            <h3>Condições sob consulta</h3>
            <p>
              Nenhum plano está publicado no catálogo neste momento. As condições são definidas com a equipe conforme
              número de empresas, volume de colaboradores e integrações necessárias.
            </p>
            <p className={styles.cardAction}>
              <Link className={styles.primaryButton} href="/contato?assunto=planos">Falar sobre planos</Link>
            </p>
          </article>
        ) : (
          <>
            <div className={styles.planGrid}>
              {offers.map((offer) => <PlanCard key={offer.code} offer={offer} />)}
            </div>
            <p className={styles.planNote}>
              Valores mensais por workspace, em reais. Não há preço anual publicado: enquanto ele não estiver configurado
              no catálogo e no provedor de pagamento, anunciá-lo seria vender uma condição que o sistema não sabe cobrar.
            </p>
          </>
        )}
      </section>

      {offers.length > 0 && (
        <section className={styles.section}>
          <h2>Limites lado a lado</h2>
          <p>Os mesmos números dos cartões acima, para comparar de uma vez. Todos vêm do catálogo do produto.</p>
          <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Comparação de limites por plano">
            <table className={styles.table}>
              <caption className={styles.tableCaption}>Limites de cada plano publicado</caption>
              <thead>
                <tr>
                  <th scope="col">Limite</th>
                  {offers.map((offer) => <th key={offer.code} scope="col">{offer.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {["Usuários incluídos", "Empresas", "Integrações conectadas", "Armazenamento de anexos"].map((label) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    {offers.map((offer) => (
                      <td key={offer.code}>{offer.limits.find((limit) => limit.label === label)?.short ?? "—"}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {moduleRows.length > 0 && (
        <section className={styles.section}>
          <h2>Módulos por plano</h2>
          <p>
            Recurso comercial varia com o plano — inclusive API, webhooks e conectores, que fazem parte do módulo de
            Integrações. A tabela abaixo é a mesma lista que libera as telas dentro do produto.
          </p>
          <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Comparação de módulos por plano">
            <table className={styles.table}>
              <caption className={styles.tableCaption}>Módulos incluídos em cada plano</caption>
              <thead>
                <tr>
                  <th scope="col">Módulo</th>
                  {offers.map((offer) => <th key={offer.code} scope="col">{offer.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {moduleRows.map((module) => (
                  <tr key={module.key}>
                    <th scope="row">
                      {module.name}
                      <small className={styles.tableHint}>{module.description}</small>
                    </th>
                    {offers.map((offer) => {
                      const has = includedIn.has(`${offer.code}:${module.key}`);
                      return (
                        <td key={offer.code}>
                          <span className={styles.cellMark} aria-hidden="true">{has ? "●" : "—"}</span>
                          <span className="sr-only">{has ? "incluído" : "não incluído"}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className={styles.section}>
        <h2>O que acontece ao atingir um limite</h2>
        <p>
          O limite recusa a próxima ação e explica por quê. Ele nunca apaga o que já existe, nem interrompe quem está
          trabalhando: a operação em curso continua, e a decisão de liberar espaço ou mudar de plano é sua.
        </p>
        <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Comportamento ao atingir cada limite">
          <table className={styles.table}>
            <caption className={styles.tableCaption}>Comportamento do produto em cada limite</caption>
            <thead>
              <tr><th scope="col">Limite</th><th scope="col">O que o sistema faz</th></tr>
            </thead>
            <tbody>
              {planLimitBehaviour.map((item) => (
                <tr key={item.limit}>
                  <th scope="row">{item.limit}</th>
                  <td>{item.behaviour}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.section}>
        <h2>Segurança: igual em todos os planos</h2>
        <p>
          Isolamento, auditoria e controle de acesso não são recurso comercial e não entram na tabela de módulos. Eles
          valem para qualquer plano, inclusive o gratuito.
        </p>
        <div className={styles.cardGrid}>
          <article className={styles.card}>
            <h3>Isolamento entre clientes</h3>
            <p>Cada workspace é separado no banco por Row Level Security, além da validação na aplicação, com testes automatizados que exigem a negação de acesso cruzado.</p>
          </article>
          <article className={styles.card}>
            <h3>Trilha de auditoria</h3>
            <p>Ator, ação, estado anterior e posterior nas mudanças administrativas, fechamentos, pagamentos e exportações, com identificador de requisição para correlação.</p>
          </article>
          <article className={styles.card}>
            <h3>Permissões por papel e por empresa</h3>
            <p>O acesso é concedido por capacidade e pode ser restrito às empresas que a pessoa realmente atende, dentro do workspace.</p>
          </article>
          <article className={styles.card}>
            <h3>Acesso de suporte controlado</h3>
            <p>O acesso da nossa equipe aos dados do cliente é autorizado, temporário, justificado e auditado. Ele não é concedido por padrão.</p>
          </article>
        </div>
      </section>

      <section className={styles.section} id="condicoes">
        <h2>Contratação, mudança e cancelamento</h2>
        <p>O que vale hoje, incluindo o que ainda é feito pela equipe em vez do painel.</p>
        <div className={styles.cardGrid}>
          {commercialCommitments.map((item) => (
            <article key={item.title} className={styles.card}>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
        <p className={styles.planNote}>
          Dúvida sobre dimensionamento? <Link href="/contato?assunto=planos">Fale sobre planos</Link> ou veja as{" "}
          <Link href="/faq">perguntas frequentes</Link>.
        </p>
      </section>
    </SiteShell>
  );
}
