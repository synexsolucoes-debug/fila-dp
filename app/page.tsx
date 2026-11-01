import Link from "next/link";
import Image from "next/image";
import { ArrowRight, Check, Plus } from "lucide-react";
import { VinculatoLogo } from "@/app/components/VinculatoLogo";
import { getD1 } from "@/db";
import { selfSignupEnabled } from "@/lib/saas";
import type { Metadata } from "next";
import { SiteMenu } from "@/app/components/SiteMenu";
import {
  audienceSegments, commercialCommitments, describePlanOffer, faqEntries, featureHighlights, integrationCatalog,
  integrationStateLabels, productBoundaries, siteNavigation, SIGNUP_PATH, type PlanCatalogRow,
} from "@/lib/marketing";
import s from "./home.module.css";
import demandasShot from "@/public/site/produto-demandas.webp";
import carteiraShot from "@/public/site/produto-carteira.webp";

/** A home é a única página cuja canônica é a raiz — as outras declaram a sua. */
export const metadata: Metadata = { alternates: { canonical: "/" } };

export const dynamic = "force-dynamic";

const Chevron = () => <ArrowRight className={s.icon} aria-hidden="true" />;

/**
 * A home lê o mesmo catálogo que a página de planos e que a cobrança.
 *
 * Nenhum preço é escrito no código desta página: se o catálogo mudar, a home
 * muda junto. Sem banco disponível na renderização, a seção não inventa
 * condição comercial — ela remete à página de planos.
 */
async function loadPlans(): Promise<{ available: boolean; plans: PlanCatalogRow[] }> {
  try {
    const d1 = getD1();
    const rows = await d1.prepare(`SELECT code, name, description, currency, monthly_price_cents, annual_price_cents,
        trial_days, included_seats, company_limit, integration_limit, storage_limit_mb, stripe_monthly_price_id
      FROM fdp_saas_plans WHERE status = 'active' ORDER BY position, monthly_price_cents`).all<PlanCatalogRow>();
    return { available: true, plans: rows.results };
  } catch {
    return { available: false, plans: [] };
  }
}

/**
 * O mês do DP, que abre a página.
 *
 * Os três primeiros marcos são prazos legais conhecidos de quem faz folha; os
 * dois últimos são o trabalho que o Vinculato organiza. As posições são
 * ilustrativas — o 5º dia útil muda de mês para mês —, e por isso a régua não
 * diz de que mês é.
 */
const TODAY = 18;
const monthMilestones = [
  { day: 5, title: "Salário", note: "até o 5º dia útil" },
  { day: 15, title: "eSocial", note: "eventos periódicos" },
  { day: 20, title: "FGTS Digital", note: "guia do mês" },
  { day: 25, title: "Conferência", note: "retorno do ERP" },
  { day: 30, title: "Fechamento", note: "sem pendência aberta" },
];
const days = Array.from({ length: 30 }, (_, index) => index + 1);

/**
 * Os recursos, agrupados pelo momento do mês em que a equipe os usa.
 *
 * É a mesma lista de `featureHighlights`; o que muda é a ordem de leitura, que
 * acompanha a régua do topo em vez de virar uma grade de cartões.
 */
const monthMoments = [
  { when: "Dias 1 a 20", title: "Ao longo do mês", features: ["Demandas com prazo e SLA", "Movimentações para a folha", "Central de ação"] },
  { when: "Dias 20 a 28", title: "Antes de fechar", features: ["Conferência e conciliação", "Pagamentos PJ", "Pagamento de psicólogos"] },
  { when: "Dia 30", title: "No fechamento", features: ["Competências e fechamento", "Auditoria e permissões"] },
];

const securityItems = [
  { title: "Isolamento entre clientes no banco", text: "Cada registro pertence a um workspace e a separação é aplicada por Row Level Security. Um teste automatizado tenta o acesso cruzado e exige a recusa." },
  { title: "Histórico com antes e depois", text: "Fechamentos, pagamentos, exportações e mudanças administrativas guardam quem fez, quando, e o estado anterior e posterior." },
  { title: "Permissão por papel e por empresa", text: "Cada pessoa vê só as empresas que atende e só faz o que o papel dela permite." },
  { title: "Seus dados saem quando você quiser", text: "O administrador exporta o workspace inteiro em um arquivo, em qualquer plano." },
  { title: "Suporte só com autorização", text: "Nossa equipe só acessa os seus dados com autorização, por tempo limitado e com registro." },
];

function MonthRuler() {
  return (
    <figure className={s.ruler} aria-labelledby="ruler-caption">
      <figcaption id="ruler-caption" className={s.rulerCaption}>
        <span>O mês do DP</span>
        <span className={s.rulerToday}>Hoje, dia {TODAY}</span>
      </figcaption>

      <div className={s.track} style={{ "--today": TODAY } as React.CSSProperties}>
        <ol className={s.days} aria-hidden="true">
          {days.map((day) => (
            <li key={day} data-past={day < TODAY ? "true" : undefined} data-mark={day % 5 === 0 || day === 1 ? "true" : undefined}>
              <span>{day}</span>
            </li>
          ))}
        </ol>
        <div className={s.progress} aria-hidden="true" />
        <div className={s.cursor} aria-hidden="true" />

        <ul className={s.milestones}>
          {monthMilestones.map((item, index) => {
            const state = item.day < TODAY ? "done" : item.day - TODAY <= 3 ? "next" : "later";
            return (
              <li
                key={item.title}
                className={s.milestone}
                data-state={state}
                style={{ "--day": item.day, "--order": index } as React.CSSProperties}
              >
                <span className={s.milestoneDay}>Dia {item.day}</span>
                <strong>
                  {state === "done" && <Check className={s.icon} aria-hidden="true" />}
                  {item.title}
                </strong>
                <span className={s.milestoneNote}>
                  {item.note}
                  {state === "done" ? " · feito" : state === "next" ? ` · em ${item.day - TODAY} dias` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </figure>
  );
}

export default async function Home() {
  const catalog = await loadPlans();
  const signupOpen = selfSignupEnabled();
  const offers = catalog.plans.map((plan) => describePlanOffer(plan, { signupOpen }));
  // A oferta sem custo só aparece quando existe plano de preço zero publicado no
  // catálogo E a criação de conta está habilitada. Fora disso a home não promete
  // um caminho que o produto recusaria.
  const freeSignup = offers.some((offer) => offer.contracting === "free");

  const headerActions = (
    <>
      <Link className="login-link" href="/login">Entrar</Link>
      <Link className={`${s.button} ${s.buttonSmall}`} href="/demonstracao">Agendar demonstração</Link>
    </>
  );

  return (
    <main className={s.page}>
      <a className={s.skip} href="#conteudo">Ir para o conteúdo</a>

      <header className={`${s.header} site-header`}>
        <Link className={s.brand} href="/" aria-label="Vinculato — início">
          <VinculatoLogo size={28} tone="light" priority />
        </Link>
        <nav className={s.nav} aria-label="Navegação principal">
          {siteNavigation.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
        </nav>
        <div className={s.headerActions}>
          <div className={s.headerInline}>{headerActions}</div>
          <SiteMenu actions={headerActions} />
        </div>
      </header>

      <section className={s.hero} id="conteudo">
        <div className={s.heroCopy}>
                    <h1>Sua operação, conectada.</h1>
          <p className={s.lead}>
            Centralize processos, demandas, documentos e integrações em uma plataforma criada para organizar a operação
            do seu Departamento Pessoal. Para escritórios de contabilidade e para o DP de empresas.
          </p>
          <div className={s.actions}>
            {freeSignup
              ? <Link className={s.button} href={SIGNUP_PATH}>Começar grátis <Chevron /></Link>
              : <Link className={s.button} href="/demonstracao">Agendar demonstração <Chevron /></Link>}
            <Link className={`${s.button} ${s.buttonGhost}`} href={freeSignup ? "/demonstracao" : "/planos"}>
              {freeSignup ? "Agendar demonstração" : "Ver planos e limites"}
            </Link>
          </div>
          <ul className={s.heroNotes}>
            <li><Check className={s.icon} aria-hidden="true" /> A folha oficial permanece no seu ERP</li>
            <li><Check className={s.icon} aria-hidden="true" /> A admissão digital continua integralmente na Sólides</li>
          </ul>
        </div>
        <MonthRuler />
      </section>

      {/* Tela real do painel, com empresas e pessoas fictícias. */}
      <figure className={s.shot}>
        <div className={s.shotFrame}>
          <Image
            src={demandasShot}
            alt="Tela de Demandas do Vinculato: pedidos de férias, desligamento e alteração de salário divididos por pessoa da equipe, cada um com empresa, tipo e prazo."
            sizes="(max-width: 1280px) 100vw, 1200px"
            priority
          />
        </div>
        <figcaption>Demandas da equipe, por pessoa, com empresa e prazo. Dados fictícios.</figcaption>
      </figure>

      <section className={s.section} aria-labelledby="audience-title">
        <h2 id="audience-title" className={s.title}>Para quem é</h2>
        <div className={s.compare}>
          <div className={s.compareRow} role="presentation">
            <span className={s.compareLabel} aria-hidden="true" />
            {audienceSegments.map((segment) => (
              <h3 key={segment.id} id={segment.id} className={s.compareHead}>{segment.label}</h3>
            ))}
          </div>
          <div className={s.compareRow}>
            <span className={s.compareLabel}>Como costuma ser</span>
            {audienceSegments.map((segment) => (
              <div key={segment.id} className={s.compareCell}>
                <span className={s.compareMobileHead}>{segment.label}</span>
                <strong>{segment.title}</strong>
                <p>{segment.text}</p>
              </div>
            ))}
          </div>
          <div className={s.compareRow}>
            <span className={s.compareLabel}>No Vinculato</span>
            {audienceSegments.map((segment) => (
              <ul key={segment.id} className={s.compareCell}>
                {segment.points.map((point) => <li key={point}>{point}</li>)}
              </ul>
            ))}
          </div>
        </div>
        <figure className={s.shotSmall}>
          <div className={s.shotFrame}>
            <Image
              src={carteiraShot}
              alt="Carteira do escritório: seis empresas clientes, cada uma com a pessoa titular e a pessoa de backup."
              sizes="(max-width: 1280px) 100vw, 960px"
            />
          </div>
          <figcaption>Para escritórios: cada empresa cliente tem titular e backup. Dados fictícios.</figcaption>
        </figure>
      </section>

      <section className={`${s.section} ${s.month}`} id="como-funciona" aria-labelledby="month-title">
        <h2 id="month-title" className={s.title}>O mês dentro do Vinculato</h2>
        <p className={s.intro}>
          Pedido vira demanda com dono e prazo, a movimentação é aprovada antes de ir para a folha, o retorno do ERP é
          conferido, e o fechamento só sai quando não sobra pendência.
        </p>
        <ol className={s.moments}>
          {monthMoments.map((moment) => (
            <li key={moment.title}>
              <span className={s.when}>{moment.when}</span>
              <h3>{moment.title}</h3>
              <dl>
                {featureHighlights.filter((item) => (moment.features as string[]).includes(item.title)).map((item) => (
                  <div key={item.title}>
                    <dt>{item.title}</dt>
                    <dd>{item.text}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ol>
        <Link className={s.textLink} href="/funcionalidades">Ver todas as funcionalidades <Chevron /></Link>
      </section>

      <section className={s.section} id="integracoes" aria-labelledby="integrations-title">
        <div className={s.split}>
          <div>
            <h2 id="integrations-title" className={s.title}>Integrações</h2>
            <p className={s.intro}>
              O Vinculato não substitui o ERP de folha, o ponto nem a Sólides. Ele conversa com eles, e cada conector
              aparece aqui no estado em que está hoje.
            </p>
            <Link className={s.textLink} href="/integracoes">Detalhes de cada integração <Chevron /></Link>
          </div>
          <table className={s.table}>
            <thead>
              <tr><th scope="col">Sistema</th><th scope="col">Tipo</th><th scope="col">Situação</th></tr>
            </thead>
            <tbody>
              {integrationCatalog.map((item) => (
                <tr key={item.name}>
                  <th scope="row">{item.name}</th>
                  <td>{item.category}</td>
                  <td><span className={s.state} data-state={item.state}>{integrationStateLabels[item.state]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={`${s.section} ${s.security}`} aria-labelledby="security-title">
        <div className={s.split}>
          <h2 id="security-title" className={s.title}>Segurança</h2>
          <dl className={s.securityList}>
            {securityItems.map((item) => (
              <div key={item.title}>
                <dt>{item.title}</dt>
                <dd>{item.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className={s.section} id="planos" aria-labelledby="plans-title">
        <h2 id="plans-title" className={s.title}>Planos</h2>
        <p className={s.intro}>Os preços vêm do mesmo catálogo usado na cobrança. Sem fidelidade e sem multa para sair.</p>

        {!catalog.available ? (
          <div className={s.plansEmpty} role="status">
            <h3>Condição temporariamente indisponível</h3>
            <p>Não foi possível consultar o catálogo agora. Tente de novo em alguns minutos ou fale com a equipe.</p>
            <Link className={s.button} href="/contato?assunto=planos">Falar sobre planos <Chevron /></Link>
          </div>
        ) : offers.length === 0 ? (
          <div className={s.plansEmpty}>
            <h3>Condições sob consulta</h3>
            <p>Nenhum plano está publicado no catálogo neste momento. As condições são definidas com a equipe conforme empresas, volume e integrações.</p>
            <Link className={s.button} href="/contato?assunto=planos">Falar sobre planos <Chevron /></Link>
          </div>
        ) : (
          <div className={s.plans}>
            {offers.map((offer) => (
              <article key={offer.code} className={s.plan} data-recommended={offer.recommended ? "true" : undefined}>
                <div className={s.planHead}>
                  <h3 className={s.planName}>{offer.name}</h3>
                  {offer.recommended && <span className={s.planFlag}>Mais escolhido</span>}
                </div>
                <strong className={s.planPrice}>{offer.price}<small>{offer.priceNote}</small></strong>
                {offer.description && <p className={s.planDescription}>{offer.description}</p>}
                <ul>
                  {offer.limits.map((limit) => (
                    <li key={limit.label}><span>{limit.label}</span><strong>{limit.value}</strong></li>
                  ))}
                </ul>
                <Link className={`${s.button} ${offer.recommended ? "" : s.buttonOutline}`} href={offer.ctaHref}>{offer.ctaLabel} <Chevron /></Link>
              </article>
            ))}
          </div>
        )}

        <dl className={s.commitments}>
          {commercialCommitments.map((item) => (
            <div key={item.title}>
              <dt>{item.title}</dt>
              <dd>{item.text}</dd>
            </div>
          ))}
        </dl>
        <Link className={s.textLink} href="/planos">Limites e módulos de cada plano <Chevron /></Link>
      </section>

      <section className={`${s.section} ${s.boundariesSection}`} aria-labelledby="boundaries-title">
        <div className={s.split}>
          <div>
            <h2 id="boundaries-title" className={s.title}>O que fica fora</h2>
            <p className={s.intro}>Melhor saber antes de contratar.</p>
          </div>
          <dl className={s.securityList}>
            {productBoundaries.map((item) => (
              <div key={item.title}>
                <dt>{item.title}</dt>
                <dd>{item.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className={`${s.section} ${s.faq}`} aria-labelledby="faq-title">
        <div>
          <h2 id="faq-title" className={s.title}>Perguntas frequentes</h2>
          <p className={s.intro}>Não achou a sua? <Link href="/contato">Fale com a equipe</Link>.</p>
        </div>
        <div className={s.faqList}>
          {faqEntries.map((item, index) => (
            <details key={item.question} open={index === 0}>
              <summary>{item.question}<Plus className={s.faqIcon} aria-hidden="true" /></summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className={s.finalCta} aria-labelledby="final-title">
        <p className={s.finalDay}>Dia 30</p>
        <h2 id="final-title">Feche o próximo mês com tudo no mesmo lugar.</h2>
        <p className={s.finalText}>Teste com a sua operação ou veja o produto com a nossa equipe, sem usar dados reais do seu DP.</p>
        <div className={s.actions}>
          {freeSignup
            ? <Link className={s.button} href={SIGNUP_PATH}>Começar grátis <Chevron /></Link>
            : <Link className={s.button} href="/demonstracao">Agendar demonstração <Chevron /></Link>}
          {freeSignup && <Link className={`${s.button} ${s.buttonGhost}`} href="/demonstracao">Agendar demonstração</Link>}
          <Link className={s.textLinkLight} href="/login">Já sou cliente, entrar</Link>
        </div>
      </section>

      <footer className={s.footer}>
        <Link className={s.brand} href="/" aria-label="Vinculato — voltar ao início">
          <VinculatoLogo size={24} tone="light" />
        </Link>
        <nav aria-label="Rodapé">
          {siteNavigation.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
          <Link href="/termos">Termos de uso</Link>
          <Link href="/privacidade">Privacidade</Link>
          <Link href="/subprocessadores">Subprocessadores e DPA</Link>
          <Link href="/recuperar">Recuperar acesso</Link>
        </nav>
        <p className={`${s.boundaryNote} site-boundary-note`}>
          O Vinculato não executa admissão digital, não guarda prontuário psicológico e não faz cálculo tributário nem emite nota fiscal.
        </p>
      </footer>
    </main>
  );
}
