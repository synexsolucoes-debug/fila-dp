import Link from "next/link";
import {
  ArrowRight, ArrowUp, Check, CircleAlert, Clock3, FileCheck2, LockKeyhole, Plug, Plus, ShieldCheck, Workflow,
} from "lucide-react";
import { VinculatoLogo } from "@/app/components/VinculatoLogo";
import { getD1 } from "@/db";
import { selfSignupEnabled } from "@/lib/saas";
import type { Metadata } from "next";
import {
  faqEntries, featureHighlights, integrationCatalog, integrationStateLabels, pluralize, productBoundaries,
  productPositioning, siteNavigation,
} from "@/lib/marketing";

/** A home é a única página cuja canônica é a raiz — as outras declaram a sua. */
export const metadata: Metadata = { alternates: { canonical: "/" } };

export const dynamic = "force-dynamic";

const Chevron = () => <ArrowRight className="inline-icon" aria-hidden="true" />;
const CheckIcon = () => <Check className="mini-icon" aria-hidden="true" />;

type PlanRow = {
  code: string; name: string; description: string; currency: string;
  monthly_price_cents: number; included_seats: number; company_limit: number;
  integration_limit: number; storage_limit_mb: number; stripe_monthly_price_id: string;
};

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

/**
 * A home lê o mesmo catálogo que a página de planos e que a cobrança.
 *
 * Nenhum preço é escrito no código desta página: se o catálogo mudar, a home
 * muda junto. Sem banco disponível na renderização, a seção não inventa
 * condição comercial — ela remete à página de planos.
 */
async function loadPlans(): Promise<PlanRow[]> {
  try {
    const d1 = getD1();
    const rows = await d1.prepare(`SELECT code, name, description, currency, monthly_price_cents,
        included_seats, company_limit, integration_limit, storage_limit_mb, stripe_monthly_price_id
      FROM fdp_saas_plans WHERE status = 'active' ORDER BY position, monthly_price_cents`).all<PlanRow>();
    return rows.results;
  } catch {
    return [];
  }
}

/** Cada passo do fluxo real: demanda → competência → conferência → fechamento. */
const workflowSteps = [
  {
    step: "01",
    title: "Receba e organize",
    text: "Solicitações chegam pela caixa de entrada, por e-mail, Teams, WhatsApp ou registro manual e viram demanda com responsável, prazo e histórico.",
  },
  {
    step: "02",
    title: "Trabalhe por competência",
    text: "Cada empresa tem seu ciclo mensal, com movimentações, obrigações e pendências reunidas no mesmo lugar.",
  },
  {
    step: "03",
    title: "Confira antes de fechar",
    text: "O sistema compara o que foi enviado com o que voltou do ERP e transforma divergência em item tratável, não em planilha paralela.",
  },
  {
    step: "04",
    title: "Feche com trilha",
    text: "O fechamento só avança quando os bloqueios são resolvidos, e cada aprovação, reabertura e ajuste fica registrada com autor, antes e depois.",
  },
];

const painPoints = [
  { number: "01", title: "Pedido sem dono", text: "A solicitação chega por mensagem, some na conversa e volta como urgência dias depois." },
  { number: "02", title: "Competência sem visão", text: "O que falta para fechar o mês vive em planilhas, e-mails e na memória de quem está de férias." },
  { number: "03", title: "Conferência manual", text: "A comparação entre o que foi enviado e o que a folha devolveu é refeita à mão a cada competência." },
];

const securityItems = [
  {
    icon: LockKeyhole,
    title: "Isolamento imposto no banco",
    text: "Cada registro pertence a um workspace e a separação é aplicada por Row Level Security, além da validação na aplicação. Há verificação automatizada que tenta o acesso cruzado e exige que ele seja negado.",
  },
  {
    icon: FileCheck2,
    title: "Trilha com antes e depois",
    text: "Mudanças administrativas, fechamentos, pagamentos e exportações registram ator, ação, estado anterior e estado posterior.",
  },
  {
    icon: ShieldCheck,
    title: "Permissões por papel e por empresa",
    text: "O acesso é concedido por capacidade e pode ser restrito às empresas que a pessoa realmente atende.",
  },
  {
    icon: Clock3,
    title: "Acesso de suporte controlado",
    text: "O acesso da nossa equipe aos dados do cliente é autorizado, temporário, justificado e auditado. Ele não é concedido por padrão.",
  },
];

/** Ilustração da tela de fechamento — exemplo de interface, não dado de cliente. */
function ClosingPanel() {
  return (
    <div className="product-panel" aria-label="Exemplo da tela de fechamento de competência">
      <div className="product-panel-bar">
        <span className="product-panel-path">Competências /</span>
        <strong>Agosto 2026</strong>
        <span className="product-panel-tag">Em conferência</span>
      </div>

      <div className="product-panel-grid">
        <article className="product-metric">
          <span>Movimentações</span>
          <strong>Preparadas</strong>
          <p>Férias, afastamentos, desligamentos e alterações aprovadas antes do envio.</p>
        </article>
        <article className="product-metric">
          <span>Conferência</span>
          <strong>Com divergência</strong>
          <p>O retorno do ERP é comparado item a item e o que não bate vira pendência com responsável.</p>
        </article>
      </div>

      <ul className="product-checklist">
        <li className="is-done"><CheckIcon /> Movimentações aprovadas</li>
        <li className="is-done"><CheckIcon /> Documentos anexados</li>
        <li className="is-blocked"><CircleAlert className="mini-icon" aria-hidden="true" /> Divergência de conferência em aberto</li>
      </ul>

      <div className="product-panel-foot">
        <span>Fechamento bloqueado até a última pendência ser tratada</span>
        <span className="product-panel-action">Ver pendências</span>
      </div>
    </div>
  );
}

export default async function Home() {
  const plans = await loadPlans();
  const signupOpen = selfSignupEnabled();
  const freePlan = plans.find((plan) => plan.monthly_price_cents === 0);
  // A oferta sem custo só aparece quando existe plano de preço zero publicado no
  // catálogo E a criação de conta está habilitada. Fora disso a home não promete
  // um caminho que o produto recusaria.
  const freeSignup = signupOpen && Boolean(freePlan);

  return (
    <main className="home">
      <a className="home-skip" href="#conteudo">Ir para o conteúdo</a>

      <header className="site-header">
        <Link className="brand" href="/" aria-label="Vinculato — início">
          <VinculatoLogo size={30} priority />
        </Link>
        <nav aria-label="Navegação principal">
          {siteNavigation.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
        </nav>
        <div className="header-actions">
          <Link className="login-link" href="/login">Entrar</Link>
          <Link className="button button-small" href="/contato?assunto=demonstracao">Falar com um especialista</Link>
        </div>
      </header>

      <section className="hero" id="conteudo">
        <div className="hero-glow" aria-hidden="true" />
        <div className="hero-copy">
          <div className="eyebrow"><i className="eyebrow-dot" /> Plataforma para Departamento Pessoal</div>
          <h1>Sua operação, conectada.</h1>
          <p className="hero-description">
            Centralize processos, demandas, documentos e integrações em uma plataforma criada para organizar a operação
            do seu Departamento Pessoal.
          </p>
          <div className="hero-actions">
            {freeSignup
              ? <Link className="button" href="/login?modo=criar">Começar grátis <Chevron /></Link>
              : <Link className="button" href="/contato?assunto=demonstracao">Falar com um especialista <Chevron /></Link>}
            {freeSignup
              ? <Link className="button button-secondary" href="/contato?assunto=demonstracao">Falar com um especialista</Link>
              : <Link className="button button-secondary" href="/planos">Ver planos</Link>}
            <Link className="hero-login" href="/login">Entrar</Link>
          </div>
          <div className="hero-notes">
            <span><CheckIcon /> A folha oficial permanece no seu ERP</span>
            <span><CheckIcon /> A admissão digital continua integralmente na Sólides</span>
          </div>
        </div>
        <div className="hero-product"><ClosingPanel /></div>
      </section>

      <section className="proof-bar" aria-label="Garantias da plataforma">
        <p><LockKeyhole className="mini-icon" aria-hidden="true" /> Isolamento entre clientes aplicado no banco</p>
        <p><FileCheck2 className="mini-icon" aria-hidden="true" /> Trilha de auditoria com antes e depois</p>
        <p><Plug className="mini-icon" aria-hidden="true" /> API e webhooks assinados</p>
      </section>

      <section className="section problem-section">
        <div className="section-kicker">O problema que a operação normalizou</div>
        <div className="split-heading">
          <h2>O trabalho do DP não cabe em conversa solta.</h2>
          <p>
            Quando pedido, prazo, documento e conferência vivem em ferramentas diferentes, a equipe gasta o dia
            procurando contexto — e a gestão descobre o problema quando já virou risco.
          </p>
        </div>
        <div className="pain-grid">
          {painPoints.map((item) => (
            <article key={item.number}>
              <span className="pain-icon">{item.number}</span>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
          <article className="solution-card">
            <span className="solution-label">A proposta</span>
            <h3>Uma plataforma que conecta o trabalho, não mais uma caixa de entrada.</h3>
            <p>{productPositioning.summary}</p>
            <Link href="/solucao">Conhecer a solução <Chevron /></Link>
          </article>
        </div>
      </section>

      <section className="section workflow-section" id="como-funciona">
        <div className="workflow-intro">
          <div className="section-kicker light">Como funciona</div>
          <h2>Do pedido recebido à competência fechada.</h2>
          <p>Um caminho só, com responsável e prazo em cada etapa, e um fechamento que não avança com pendência aberta.</p>
        </div>
        <ol className="workflow-list">
          {workflowSteps.map((item) => (
            <li key={item.step}>
              <span>{item.step}</span>
              <div><h3>{item.title}</h3><p>{item.text}</p></div>
            </li>
          ))}
        </ol>
      </section>

      <section className="section features-section" id="recursos">
        <div className="section-kicker">O que já está no produto</div>
        <div className="split-heading">
          <h2>Recursos disponíveis hoje, não roteiro de futuro.</h2>
          <p>Cada item abaixo corresponde a um módulo entregue. O que ainda não existe aparece como preparado, nunca como pronto.</p>
        </div>
        <div className="feature-grid">
          {featureHighlights.map((item, index) => (
            <article key={item.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
        <p className="feature-note">
          <Link href="/funcionalidades">Ver todas as funcionalidades <Chevron /></Link>
        </p>
      </section>

      <section className="section boundaries-section">
        <div className="split-heading">
          <h2>E o que o Vinculato não faz.</h2>
          <p>Dizer o limite antes da contratação evita a frustração depois. Estas fronteiras são parte do produto.</p>
        </div>
        <div className="boundary-grid">
          {productBoundaries.map((item) => (
            <article key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section integrations-section" id="integracoes">
        <div className="section-kicker">Integrações</div>
        <div className="split-heading">
          <h2>Conectado ao que sua operação já usa.</h2>
          <p>Cada conector aparece com o estado real: disponível, parcial ou apenas preparado. Nada é anunciado como pronto antes de funcionar de ponta a ponta.</p>
        </div>
        <div className="integration-grid">
          {integrationCatalog.map((item) => (
            <article key={item.name} className={`integration-card state-${item.state}`}>
              <div className="integration-head">
                <h3>{item.name}</h3>
                <span className={`integration-state state-${item.state}`}>{integrationStateLabels[item.state]}</span>
              </div>
              <p className="integration-category">{item.category}</p>
              <p>{item.note}</p>
            </article>
          ))}
        </div>
        <p className="integration-note"><Link href="/integracoes">Ver detalhes das integrações <Chevron /></Link></p>
      </section>

      <section className="section security-section">
        <div className="section-kicker light">Segurança e rastreabilidade</div>
        <div className="split-heading">
          <h2>Dado de cliente não se mistura.</h2>
          <p>Multi-tenant de verdade significa separação verificada, permissão granular e histórico que sobrevive à auditoria.</p>
        </div>
        <div className="security-grid">
          {securityItems.map((item) => (
            <article key={item.title}>
              <item.icon className="security-icon" aria-hidden="true" />
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section plans-section" id="planos">
        <div className="center-heading">
          <div className="section-kicker">Planos</div>
          <h2>Preço publicado, do catálogo do produto.</h2>
          <p>
            Os planos abaixo vêm do mesmo catálogo que a cobrança usa. Um plano só exibe contratação direta quando está
            ativo e com preço configurado no provedor de pagamento.
          </p>
        </div>

        {plans.length === 0 ? (
          <div className="plans-empty">
            <h3>Condições sob consulta</h3>
            <p>Nenhum plano está publicado no catálogo neste momento. As condições são definidas com a equipe conforme empresas, volume e integrações.</p>
            <Link className="button" href="/contato?assunto=planos">Falar sobre planos <Chevron /></Link>
          </div>
        ) : (
          <div className="plans-grid">
            {plans.map((plan) => {
              const free = plan.monthly_price_cents === 0;
              // O preço vem do catálogo e é exibido como está publicado. O que
              // depende do provedor de pagamento é a contratação direta: sem
              // preço configurado lá, o plano existe mas é contratado com a
              // equipe — a página não simula um checkout que não funciona.
              const payable = plan.monthly_price_cents > 0 && Boolean(plan.stripe_monthly_price_id);
              const selfServe = signupOpen && (free || payable);
              return (
                <article key={plan.code} className="plan-card">
                  <span className="plan-name">{plan.name}</span>
                  <strong className="plan-price">
                    {free ? "Grátis" : money(plan.monthly_price_cents, plan.currency)}
                    <small>{free ? "para começar" : payable ? "por mês" : "por mês · contratação com a equipe"}</small>
                  </strong>
                  {plan.description && <p className="plan-description">{plan.description}</p>}
                  <ul className="plan-list">
                    <li><CheckIcon /> {pluralize(plan.included_seats, "usuário incluído", "usuários incluídos")}</li>
                    <li><CheckIcon /> {pluralize(plan.company_limit, "empresa", "empresas")}</li>
                    <li><CheckIcon /> {pluralize(plan.integration_limit, "integração", "integrações")}</li>
                    <li><CheckIcon /> {Math.round(plan.storage_limit_mb / 1024 * 10) / 10} GB de anexos</li>
                  </ul>
                  <Link
                    className="plan-action"
                    href={selfServe ? "/login" : `/contato?assunto=planos&plano=${encodeURIComponent(plan.code)}`}
                  >
                    {selfServe ? (free ? "Criar conta" : "Contratar") : "Falar com a equipe"} <Chevron />
                  </Link>
                </article>
              );
            })}
          </div>
        )}

        <p className="plans-note">
          <Link href="/planos">Ver limites completos de cada plano <Chevron /></Link>
        </p>
      </section>

      <section className="section faq-section">
        <div>
          <div className="section-kicker">Perguntas frequentes</div>
          <h2>O que costumam perguntar antes de contratar.</h2>
          <p className="faq-aside">Se a sua dúvida não estiver aqui, fale com a equipe: respondemos com o que o produto faz hoje.</p>
        </div>
        <div className="faq-list">
          {faqEntries.map((item, index) => (
            <details key={item.question} open={index === 0}>
              <summary>{item.question}<Plus className="faq-toggle-icon" aria-hidden="true" /></summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="final-cta" id="contato">
        <div>
          <span className="cta-kicker"><Workflow className="mini-icon" aria-hidden="true" /> Sua operação, conectada.</span>
          <h2>Coloque processos, demandas e conferências no mesmo lugar.</h2>
        </div>
        <div className="final-cta-actions">
          {freeSignup
            ? <Link className="button button-light" href="/login?modo=criar">Começar grátis <Chevron /></Link>
            : <Link className="button button-light" href="/contato?assunto=demonstracao">Falar com um especialista <Chevron /></Link>}
          <Link className="demo-link" href="/login">Já sou cliente — entrar</Link>
          <p>A conversa começa pela sua operação, com o produto aberto e sem usar dados reais do seu DP.</p>
        </div>
      </section>

      <footer className="home-footer">
        <Link className="brand footer-brand" href="/" aria-label="Vinculato — voltar ao início">
          <VinculatoLogo size={26} tone="light" />
        </Link>
        <p>Gestão, integração e conferência operacional para Departamento Pessoal.</p>
        <div>
          {siteNavigation.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
          <Link href="/termos">Termos</Link>
          <Link href="/privacidade">Privacidade</Link>
          <Link href="/subprocessadores">Subprocessadores</Link>
          <a href="#conteudo">Voltar ao topo <ArrowUp className="inline-icon" aria-hidden="true" /></a>
        </div>
        <p className="site-boundary-note">
          O Vinculato não executa admissão digital, não guarda prontuário psicológico e não faz cálculo tributário nem emite nota fiscal.
        </p>
      </footer>
    </main>
  );
}

