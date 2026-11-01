import Link from "next/link";
import { ArrowRight, Check, Clock3, FileCheck2, LockKeyhole, Plug, Plus, ShieldCheck } from "lucide-react";
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

/** Cada passo do fluxo real: demanda → competência → conferência → fechamento. */
const workflowSteps = [
  { title: "Receba o pedido", text: "Solicitações chegam por e-mail, Teams, WhatsApp ou registro manual e viram demanda com responsável, prazo e histórico." },
  { title: "Trabalhe por competência", text: "Cada empresa tem seu ciclo mensal, com movimentações, obrigações e pendências no mesmo lugar." },
  { title: "Confira antes de fechar", text: "O que foi enviado é comparado com o que voltou do ERP, e cada divergência vira item com dono." },
  { title: "Feche com trilha", text: "O fechamento só avança sem bloqueio aberto, e toda aprovação ou reabertura fica registrada." },
];

const securityItems = [
  { icon: LockKeyhole, title: "Isolamento imposto no banco", text: "Cada registro pertence a um workspace, e a separação é aplicada por Row Level Security, com teste automatizado que tenta o acesso cruzado e exige a recusa." },
  { icon: FileCheck2, title: "Trilha com antes e depois", text: "Mudanças administrativas, fechamentos, pagamentos e exportações registram quem fez, o quê, e o estado anterior e posterior." },
  { icon: ShieldCheck, title: "Permissão por papel e por empresa", text: "O acesso é dado por capacidade e pode ser restrito às empresas que a pessoa atende." },
  { icon: Clock3, title: "Suporte só com autorização", text: "O acesso da nossa equipe aos seus dados é temporário, justificado e auditado. Ele não existe por padrão." },
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
          <p className={s.eyebrow}>Para escritórios de contabilidade e DP de empresas</p>
          <h1>Sua operação, conectada.</h1>
          <p className={s.lead}>
            Centralize processos, demandas, documentos e integrações em uma plataforma criada para organizar a operação
            do seu Departamento Pessoal — e chegue ao fim do mês sabendo o que falta para fechar.
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

      <section className={s.audience} aria-labelledby="audience-title">
        <div className={s.sectionHead}>
          <p className={s.kicker}>Para quem é</p>
          <h2 id="audience-title">O mesmo fechamento, visto de dois lados.</h2>
        </div>
        <div className={s.audienceGrid}>
          {audienceSegments.map((segment) => (
            <article key={segment.id} id={segment.id} className={s.audienceCard} data-segment={segment.id}>
              <p className={s.audienceLabel}>{segment.label}</p>
              <h3>{segment.title}</h3>
              <p>{segment.text}</p>
              <ul>
                {segment.points.map((point) => (
                  <li key={point}><Check className={s.icon} aria-hidden="true" /> {point}</li>
                ))}
              </ul>
              <Link className={s.textLink} href="/demonstracao">Ver na demonstração <Chevron /></Link>
            </article>
          ))}
        </div>
      </section>

      {/* As três garantias desta faixa valem em qualquer plano, inclusive no
          gratuito — é o que as separa de recurso comercial. */}
      <section className={s.proof} aria-label="Garantias válidas em qualquer plano">
        <p><LockKeyhole className={s.icon} aria-hidden="true" /> Isolamento entre clientes aplicado no banco</p>
        <p><FileCheck2 className={s.icon} aria-hidden="true" /> Trilha de auditoria com antes e depois</p>
        <p><Plug className={s.icon} aria-hidden="true" /> Exportação dos seus dados a qualquer momento</p>
      </section>

      <section className={s.section} id="como-funciona" aria-labelledby="flow-title">
        <div className={s.sectionHead}>
          <p className={s.kicker}>Como funciona</p>
          <h2 id="flow-title">Do pedido recebido à competência fechada.</h2>
          <p>Um caminho só, com responsável e prazo em cada etapa, e um fechamento que não avança com pendência aberta.</p>
        </div>
        <ol className={s.flow}>
          {workflowSteps.map((item, index) => (
            <li key={item.title}>
              <span className={s.flowStep}>Etapa {index + 1}</span>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className={`${s.section} ${s.sectionTinted}`} id="recursos" aria-labelledby="features-title">
        <div className={s.sectionHead}>
          <p className={s.kicker}>O que já está no produto</p>
          <h2 id="features-title">Recursos disponíveis hoje, não roteiro de futuro.</h2>
          <p>Cada item corresponde a um módulo entregue. O que ainda não existe aparece como preparado, nunca como pronto.</p>
        </div>
        <div className={s.features}>
          {featureHighlights.map((item) => (
            <article key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
        <Link className={s.textLink} href="/funcionalidades">Ver todas as funcionalidades <Chevron /></Link>
      </section>

      <section className={s.section} id="integracoes" aria-labelledby="integrations-title">
        <div className={s.sectionHead}>
          <p className={s.kicker}>Integrações</p>
          <h2 id="integrations-title">Conectado ao que sua operação já usa.</h2>
          <p>Cada conector aparece com o estado real. Nada é anunciado como pronto antes de funcionar de ponta a ponta.</p>
        </div>
        <ul className={s.integrations}>
          {integrationCatalog.map((item) => (
            <li key={item.name}>
              <div>
                <strong>{item.name}</strong>
                <span className={s.integrationCategory}>{item.category}</span>
              </div>
              <span className={s.state} data-state={item.state}>{integrationStateLabels[item.state]}</span>
            </li>
          ))}
        </ul>
        <Link className={s.textLink} href="/integracoes">Ver detalhes das integrações <Chevron /></Link>
      </section>

      <section className={s.security} aria-labelledby="security-title">
        <div className={s.sectionHead}>
          <p className={s.kicker}>Segurança e rastreabilidade</p>
          <h2 id="security-title">Dado de cliente não se mistura.</h2>
        </div>
        <div className={s.securityGrid}>
          {securityItems.map((item) => (
            <article key={item.title}>
              <item.icon className={s.securityIcon} aria-hidden="true" />
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={s.section} id="planos" aria-labelledby="plans-title">
        <div className={s.sectionHead}>
          <p className={s.kicker}>Planos</p>
          <h2 id="plans-title">Comece pequeno, cresça com a carteira.</h2>
          <p>Os planos vêm do mesmo catálogo que a cobrança usa. Contratação direta só aparece quando o plano está ativo e com preço configurado.</p>
        </div>

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
                  <span className={s.planName}>{offer.name}</span>
                  {offer.recommended && <span className={s.planFlag}>Mais escolhido</span>}
                </div>
                <strong className={s.planPrice}>{offer.price}<small>{offer.priceNote}</small></strong>
                {offer.description && <p className={s.planDescription}>{offer.description}</p>}
                <ul>
                  {offer.limits.map((limit) => (
                    <li key={limit.label}><Check className={s.icon} aria-hidden="true" /> {limit.value} — {limit.label.toLowerCase()}</li>
                  ))}
                </ul>
                <Link className={`${s.button} ${offer.recommended ? "" : s.buttonOutline}`} href={offer.ctaHref}>{offer.ctaLabel} <Chevron /></Link>
              </article>
            ))}
          </div>
        )}

        <div className={s.commitments}>
          {commercialCommitments.map((item) => (
            <article key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
        <Link className={s.textLink} href="/planos">Ver limites, módulos por plano e condições <Chevron /></Link>
      </section>

      <section className={`${s.section} ${s.sectionTinted}`} aria-labelledby="boundaries-title">
        <div className={s.sectionHead}>
          <p className={s.kicker}>Limites do produto</p>
          <h2 id="boundaries-title">O que o Vinculato não faz.</h2>
          <p>Dizer o limite antes da contratação evita a frustração depois.</p>
        </div>
        <dl className={s.boundaries}>
          {productBoundaries.map((item) => (
            <div key={item.title}>
              <dt>{item.title}</dt>
              <dd>{item.text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={`${s.section} ${s.faq}`} aria-labelledby="faq-title">
        <div className={s.sectionHead}>
          <p className={s.kicker}>Perguntas frequentes</p>
          <h2 id="faq-title">Antes de contratar.</h2>
          <p>Se a sua dúvida não estiver aqui, <Link href="/contato">fale com a equipe</Link>.</p>
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
        <h2 id="final-title">Feche o próximo mês com tudo no mesmo lugar.</h2>
        <p>Teste com a sua operação ou veja o produto aberto com a nossa equipe, sem usar dados reais do seu DP.</p>
        <div className={s.actions}>
          {freeSignup
            ? <Link className={`${s.button} ${s.buttonLight}`} href={SIGNUP_PATH}>Começar grátis <Chevron /></Link>
            : <Link className={`${s.button} ${s.buttonLight}`} href="/demonstracao">Agendar demonstração <Chevron /></Link>}
          {freeSignup && <Link className={`${s.button} ${s.buttonGhost}`} href="/demonstracao">Agendar demonstração</Link>}
          <Link className={s.textLinkLight} href="/login">Já sou cliente — entrar</Link>
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
