import { cleanText } from "./clean-text.ts";
import { ApiError } from "./api-errors.ts";

/**
 * Conteúdo e fronteiras do site comercial (§90).
 *
 * As promessas do produto ficam aqui, em um lugar só, para que a página e o
 * teste leiam a mesma verdade. O site não pode anunciar admissão digital
 * própria, prontuário psicológico nem o módulo PJ como cálculo tributário —
 * e também não pode anunciar preço de plano que ainda não é cobrável.
 */
export const siteNavigation = [
  { href: "/solucao", label: "Solução" },
  { href: "/funcionalidades", label: "Funcionalidades" },
  { href: "/integracoes", label: "Integrações" },
  { href: "/planos", label: "Planos" },
  { href: "/faq", label: "FAQ" },
  { href: "/contato", label: "Contato" },
] as const;

export const legalNavigation = [
  { href: "/termos", label: "Termos de uso" },
  { href: "/privacidade", label: "Privacidade" },
  { href: "/subprocessadores", label: "Subprocessadores e DPA" },
] as const;

/** O que o produto é. */
export const productPositioning = {
  headline: "Plataforma de gestão, integração e conferência operacional para Departamento Pessoal.",
  summary: [
    "O Vinculato organiza demandas, prazos, competências, conferências e pagamentos auxiliares do DP,",
    "e conecta os sistemas que sua operação já usa. Ele não substitui o ERP de folha, o sistema de ponto,",
    "a Sólides nem o sistema contábil: ele coordena o trabalho entre eles.",
  ].join(" "),
};

/** O que o produto explicitamente não é — exibido no site, não escondido. */
export const productBoundaries = [
  {
    title: "Não é ERP de folha",
    text: "O cálculo oficial da folha continua no seu ERP. O Vinculato prepara movimentações, confere o resultado e registra divergências.",
  },
  {
    title: "Não faz admissão digital",
    text: "A admissão digital é executada integralmente na Sólides. O Vinculato recebe dados de pessoas já admitidas e concilia com o ERP.",
  },
  {
    title: "Não é sistema clínico",
    text: "O módulo de Psicólogos controla apenas o pagamento das consultas. Não existe prontuário, agenda clínica, diagnóstico ou anotação terapêutica.",
  },
  {
    title: "Não é emissor fiscal nem assessoria tributária",
    text: "O módulo PJ apura administrativamente quanto pagar e qual valor esperar na nota. Ele não emite nota fiscal e não substitui contador.",
  },
  {
    title: "Não é sistema de ponto",
    text: "As marcações oficiais continuam no seu sistema de ponto. O Vinculato importa o resultado para conferência.",
  },
] as const;

export const featureHighlights = [
  {
    title: "Demandas com prazo e SLA",
    text: "Quadro, tabela, calendário e visão por processo, com prazo interno, prazo legal, responsável e histórico auditável.",
  },
  {
    title: "Competências e fechamento",
    text: "Ciclo por empresa e competência, com gates de pré e pós-fechamento, aprovações atribuídas e reabertura justificada.",
  },
  {
    title: "Movimentações para a folha",
    text: "Desligamentos, férias, afastamentos, alterações e demais movimentos preparados, aprovados e rastreados até o ERP.",
  },
  {
    title: "Conferência e conciliação",
    text: "Comparação entre o que foi enviado e o que voltou, com divergências tratáveis em vez de planilhas paralelas.",
  },
  {
    title: "Pagamento de psicólogos",
    text: "Quantas consultas válidas cada profissional realizou na competência e quanto pagar, com valor histórico congelado no lançamento.",
  },
  {
    title: "Pagamentos PJ",
    text: "Quanto o prestador recebe, quanto deve emitir de nota e quanto vai para o meio complementar configurado.",
  },
  {
    title: "Central de ação",
    text: "O painel abre respondendo o que precisa ser feito agora, com indicadores clicáveis por empresa e competência.",
  },
  {
    title: "Auditoria e permissões",
    text: "Papéis granulares, escopo por empresa, trilha com antes e depois, e isolamento entre clientes garantido no banco.",
  },
] as const;

/**
 * Estado real de cada integração. `available` só para o que existe de ponta a
 * ponta; o resto aparece como arquitetura preparada, nunca como pronto.
 *
 * Teams, e-mail e WhatsApp saíram de `available` depois de conferir o que o
 * código faz de fato. O endpoint de entrada existe e é sólido — segredo por
 * workspace vindo do cofre, assinatura conferida, idempotência, isolamento por
 * RLS —, mas ele fala o protocolo do Vinculato, não o do fornecedor:
 *
 *   - o WhatsApp Business exige responder ao GET de verificação da Meta
 *     ecoando `hub.challenge`, sem o qual a URL nem pode ser cadastrada;
 *   - o Microsoft Graph exige devolver o `validationToken` na criação da
 *     assinatura e renová-la antes de expirar;
 *   - um provedor de e-mail assina com o esquema dele, não com o nosso HMAC.
 *
 * Nada disso está implementado. Na prática o cliente precisa de um relay que
 * traduza e assine — o que é exatamente "implantação assistida", e não
 * "disponível". Prometer o contrário venderia uma conexão que não conecta.
 */
export const integrationCatalog = [
  { name: "Microsoft Teams", category: "Comunicação", state: "assisted", note: "Entrada de solicitações por webhook assinado pelo Vinculato. Não há aplicativo publicado no Microsoft Graph: a assinatura de notificações e sua renovação são feitas na implantação, com apoio da nossa equipe." },
  { name: "E-mail corporativo", category: "Comunicação", state: "assisted", note: "Caixa de entrada operacional por webhook assinado pelo Vinculato. O encaminhamento a partir do provedor de e-mail é configurado na implantação." },
  { name: "WhatsApp Business", category: "Comunicação", state: "assisted", note: "Recebimento por webhook assinado pelo Vinculato. A verificação exigida pela Meta e o número oficial são tratados na implantação, com apoio da nossa equipe." },
  { name: "Sankhya", category: "ERP", state: "partial", note: "Conector com credencial por workspace; requer endpoint e homologação com o cliente." },
  { name: "API pública Vinculato", category: "Plataforma", state: "available", note: "Leitura da operação e envio de créditos/descontos PJ, com escopos e idempotência." },
  { name: "Webhooks de saída", category: "Plataforma", state: "available", note: "Eventos assinados com HMAC, repetição e log de entrega." },
  { name: "Sólides", category: "Admissão", state: "partial", note: "Conector oficial de colaboradores: quem é admitido na Sólides vira conciliação no Vinculato. Exige token do cliente e homologação; os arquivos dos documentos permanecem na Sólides. A admissão permanece na Sólides." },
  { name: "Caju", category: "Benefícios", state: "planned", note: "Complemento é controle assistido com exportação; não há integração oficial implementada." },
  { name: "Domínio, Senior, TOTVS, Alterdata e outros ERPs", category: "ERP", state: "planned", note: "Arquitetura de conectores pronta; cada integração exige documentação e homologação." },
  { name: "Sólides DP (Tangerino)", category: "Admissão", state: "partial", note: "Conector oficial de colaboradores: quem é admitido na Sólides DP vira conciliação no Vinculato. Exige token do cliente e homologação; os arquivos dos documentos permanecem na Sólides." },
  { name: "Sistemas de ponto", category: "Ponto", state: "planned", note: "Importação para conferência; o módulo de ponto ainda não faz parte do produto." },
] as const;

export const integrationStateLabels: Record<string, string> = {
  available: "Disponível",
  partial: "Parcial",
  // Funciona, e funciona com ajuda: existe conector, mas a ponta do fornecedor
  // é configurada junto com o cliente. Dizer "disponível" prometeria autonomia
  // que ainda não existe; dizer "preparado" esconderia o que já está pronto.
  assisted: "Implantação assistida",
  planned: "Preparado",
};

export const faqEntries = [
  {
    question: "O Vinculato substitui meu sistema de folha?",
    answer: "Não. O cálculo oficial continua no seu ERP. O Vinculato organiza as demandas e movimentações que alimentam a folha e confere o resultado que volta dela.",
  },
  {
    question: "Como fica a admissão feita na Sólides?",
    answer: "A admissão digital é executada integralmente na Sólides. O Vinculato não cria fluxo concorrente: ele recebe os dados de quem já foi admitido e concilia com o ERP quando houver meio oficial de integração.",
  },
  {
    question: "O módulo de Psicólogos guarda informação clínica?",
    answer: "Não. Ele registra colaborador, psicólogo, data, quantidade e valor da consulta para apurar quanto pagar. Diagnóstico, motivo, evolução e anotação terapêutica são recusados pelo sistema.",
  },
  {
    question: "O módulo PJ calcula impostos?",
    answer: "Não. Ele apura administrativamente o valor devido, informa quanto se espera de nota fiscal segundo o limite que você configurar e separa o complemento. A responsabilidade tributária e a emissão da nota continuam com o prestador e o contador.",
  },
  {
    question: "O limite da nota fiscal é fixo?",
    answer: "Não. O limite é configurado por workspace, empresa, contrato ou prestador, e resolvido nessa ordem de prioridade. Competências já apuradas mantêm o limite que usaram.",
  },
  {
    question: "Como os dados de um cliente ficam separados dos outros?",
    answer: "Cada registro pertence a um workspace e o isolamento é imposto no banco por Row Level Security, além da validação na aplicação. Há testes automatizados que tentam o acesso cruzado e exigem que ele seja negado.",
  },
  {
    question: "Vocês acessam os dados da minha operação?",
    answer: "O acesso de suporte é autorizado, temporário, justificado e auditado. Ele não é concedido por padrão.",
  },
  {
    question: "Existe API e webhook?",
    answer: "Sim, no plano que inclui o módulo de Integrações. A API pública usa chave com escopos, limite por minuto e idempotência nas escritas, e os webhooks de saída são assinados com HMAC, com repetição e log de entrega. A comparação por plano está na página de planos.",
  },
  {
    question: "O plano gratuito expira ou vira cobrança automática?",
    answer: "Não. O Starter é gratuito por tempo indeterminado dentro dos limites publicados: nenhum cartão é pedido para começar e nenhuma cobrança é iniciada sem uma contratação explícita.",
  },
  {
    question: "O que acontece quando eu atinjo um limite do plano?",
    answer: "A ação que ultrapassaria o limite é recusada com a explicação — quantos usuários o plano permite e quantos estão em uso, por exemplo. O que já existe continua acessível: o sistema não apaga usuário, empresa, integração nem anexo por causa de limite.",
  },
  {
    question: "Como faço upgrade ou cancelo?",
    answer: "Upgrade, downgrade e cancelamento são solicitados à equipe pelo formulário de contato e passam a valer no ciclo seguinte; o cancelamento encerra a renovação e mantém o acesso até o fim do período já pago. A troca de plano pelo próprio painel ainda não está disponível, e não anunciamos como pronta.",
  },
  {
    question: "O armazenamento é por workspace? E se eu precisar de mais?",
    answer: "É por workspace e soma os anexos de demandas, EPI e documentos de prestadores. Ao atingir o limite, o envio é recusado com o uso atual e o tamanho do arquivo; remover anexos desnecessários libera espaço, e mudar de plano aumenta o limite.",
  },
] as const;

/**
 * Concordância de número para os limites de plano.
 *
 * "1 integração(ões)" é ruído de gerador, não texto de produto. O site fala a
 * mesma língua do cliente também nos detalhes.
 */
export function pluralize(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}


/* -------------------------------------------------------------------------- */
/* Catálogo comercial: do registro persistido ao que a página mostra           */
/* -------------------------------------------------------------------------- */

/**
 * A linha do catálogo, exatamente como `fdp_saas_plans` a guarda.
 *
 * A home, a página de planos e `/api/site/plans` liam o mesmo SELECT e repetiam
 * a mesma derivação — três cópias da regra de "este plano pode ser contratado
 * sozinho?". Cópia de regra comercial não sobrevive: basta uma das três mudar
 * para o site anunciar um checkout que a outra recusa. A regra passa a morar
 * aqui, e as páginas só a consomem.
 */
export type PlanCatalogRow = {
  code: string;
  name: string;
  description: string;
  currency: string;
  monthly_price_cents: number;
  annual_price_cents: number;
  trial_days: number;
  included_seats: number;
  company_limit: number;
  integration_limit: number;
  storage_limit_mb: number;
  stripe_monthly_price_id: string;
};

/** Plano destacado como recomendação. Um só, e sempre o mesmo em todas as páginas. */
export const RECOMMENDED_PLAN_CODE = "standard";

/**
 * Planos cujo preço e limites fecham em contrato.
 *
 * O catálogo guarda um valor para o Enterprise porque a cobrança e o console
 * precisam de um número — mas ele é referência interna, não oferta publicada:
 * assentos, empresas, integrações e armazenamento são dimensionados caso a
 * caso. Publicar aquele número como preço faria o site prometer uma condição
 * fechada que ninguém contratou assim.
 *
 * Enquanto o catálogo não tiver coluna própria para "negociado", esta lista é a
 * única fonte da distinção — e por isso mora junto do resto do conteúdo
 * comercial, não espalhada nas páginas.
 */
export const negotiatedPlanCodes: readonly string[] = ["enterprise"];

/**
 * Destino do cadastro gratuito.
 *
 * O botão que aponta para cá só é renderizado quando `selfSignupEnabled()`
 * devolve `true`. Hoje ela devolve `false` — nenhuma página do site oferece
 * este caminho, justamente para não abrir um link quebrado. Ligar o cadastro
 * público e publicar a página são a mesma entrega, e `tests/site-launch.test.mts`
 * cobra as duas juntas.
 */
export const SIGNUP_PATH = "/cadastro";

/**
 * Como um plano é contratado hoje.
 *
 * - `free`      — conta criada pelo próprio cliente, sem cobrança.
 * - `checkout`  — contratação direta, com preço configurado no provedor.
 * - `specialist` — condição fechada com a equipe. É o padrão, não a exceção:
 *   um plano só sai daqui quando o catálogo prova que dá para cobrá-lo.
 */
export type PlanContracting = "free" | "checkout" | "specialist";

export type PlanLimit = { label: string; value: string; short: string };

export type PlanOffer = {
  code: string;
  name: string;
  description: string;
  /** "Grátis", "R$ 97,00" ou "Sob consulta". */
  price: string;
  /** A linha miúda embaixo do preço. */
  priceNote: string;
  contracting: PlanContracting;
  ctaLabel: string;
  ctaHref: string;
  recommended: boolean;
  negotiated: boolean;
  limits: PlanLimit[];
  /** Nota sobre os limites, quando eles são ponto de partida e não teto fixo. */
  limitsNote: string;
};

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: (currency || "brl").toUpperCase() }).format(cents / 100);

const storageLabel = (megabytes: number) => (megabytes >= 1024
  ? `${Math.round(megabytes / 1024 * 10) / 10} GB`
  : `${megabytes} MB`);

/**
 * Traduz uma linha do catálogo no que a página mostra.
 *
 * Nenhum preço, limite ou nome de plano é escrito nas páginas: se o catálogo
 * mudar, o site muda junto. O que **não** vem do catálogo é a política de
 * lançamento — quais planos já podem ser contratados sozinhos —, e ela é
 * derivada de fatos verificáveis: preço zero com cadastro aberto, ou preço
 * configurado no provedor de pagamento. Sem essa prova, o plano é conversa com
 * a equipe, e o site não desenha um checkout que não existe.
 */
export function describePlanOffer(plan: PlanCatalogRow, options: { signupOpen: boolean }): PlanOffer {
  const negotiated = negotiatedPlanCodes.includes(plan.code);
  const free = plan.monthly_price_cents === 0;
  const payable = plan.monthly_price_cents > 0 && Boolean(plan.stripe_monthly_price_id);

  const contracting: PlanContracting = negotiated
    ? "specialist"
    : free && options.signupOpen
      ? "free"
      : payable && options.signupOpen
        ? "checkout"
        : "specialist";

  const limits: PlanLimit[] = [
    { label: "Usuários incluídos", value: pluralize(plan.included_seats, "usuário", "usuários"), short: String(plan.included_seats) },
    { label: "Empresas", value: pluralize(plan.company_limit, "empresa", "empresas"), short: String(plan.company_limit) },
    { label: "Integrações conectadas", value: pluralize(plan.integration_limit, "integração", "integrações"), short: String(plan.integration_limit) },
    { label: "Armazenamento de anexos", value: storageLabel(plan.storage_limit_mb), short: storageLabel(plan.storage_limit_mb) },
  ];
  if (plan.trial_days > 0 && !free) {
    limits.push({
      label: "Avaliação",
      value: pluralize(plan.trial_days, "dia", "dias"),
      short: pluralize(plan.trial_days, "dia", "dias"),
    });
  }

  return {
    code: plan.code,
    name: plan.name,
    description: plan.description,
    negotiated,
    recommended: plan.code === RECOMMENDED_PLAN_CODE,
    price: negotiated ? "Sob consulta" : free ? "Grátis" : money(plan.monthly_price_cents, plan.currency),
    priceNote: negotiated
      ? "Limites e condições definidos em contrato"
      : free
        ? "para começar, sem cartão"
        : contracting === "checkout"
          ? "por mês, por workspace"
          : "por mês · contratação com a equipe",
    contracting,
    ctaLabel: contracting === "free"
      ? "Começar grátis"
      : contracting === "checkout"
        ? `Assinar ${plan.name}`
        : "Falar com especialista",
    ctaHref: contracting === "free"
      ? SIGNUP_PATH
      : contracting === "checkout"
        // Contratar exige estar autenticado: a assinatura pertence a um
        // workspace, não a um visitante. O código do plano viaja junto para que
        // a tela de assinatura abra já na condição escolhida.
        ? `/login?return_to=${encodeURIComponent(`/painel?assinar=${plan.code}`)}`
        : `/contato?assunto=planos&plano=${encodeURIComponent(plan.code)}`,
    limits,
    limitsNote: negotiated
      ? "Os números do catálogo são o ponto de partida do dimensionamento, não um teto fixo."
      : "",
  };
}

/**
 * O que acontece quando um limite do plano é atingido.
 *
 * Cada linha corresponde a uma recusa que existe no código, não a uma promessa
 * de comportamento: o convite de usuário, a criação de empresa, a conexão de
 * integração e o envio de anexo têm cada um a sua verificação antes de gravar.
 * Nenhuma delas apaga o que já existe — o que estava lá continua acessível.
 */
export const planLimitBehaviour = [
  {
    limit: "Usuários",
    behaviour: "O convite é recusado com a mensagem dizendo o plano, quantos usuários ele permite e quantos já estão em uso. Quem já tem acesso continua trabalhando.",
  },
  {
    limit: "Empresas",
    behaviour: "O cadastro de uma nova empresa é recusado enquanto o número de empresas ativas estiver no limite. Inativar uma empresa libera a vaga.",
  },
  {
    limit: "Integrações",
    behaviour: "Uma nova conexão não é ativada além do limite. As integrações já conectadas seguem sincronizando normalmente.",
  },
  {
    limit: "Armazenamento",
    behaviour: "O envio do anexo é recusado com o uso atual, o limite e o tamanho do arquivo. Nenhum anexo existente é apagado pelo sistema.",
  },
] as const;

/**
 * Compromissos comerciais publicados.
 *
 * Estão aqui, e não escritos na página, porque o mesmo texto precisa valer nos
 * planos, no FAQ e no rodapé. Cada item descreve o que o produto faz hoje —
 * inclusive quando o que ele faz é "pela equipe, não pelo painel".
 */
export const commercialCommitments = [
  {
    title: "Cancelamento",
    text: "O cancelamento encerra a renovação seguinte e o acesso permanece até o fim do período já pago. Não há multa por encerramento e não há fidelidade mínima nos planos publicados.",
  },
  {
    title: "Mudança de plano",
    text: "Upgrade e downgrade são solicitados à equipe e passam a valer no ciclo seguinte, mantendo o histórico financeiro do workspace. A troca pelo próprio painel ainda não está disponível.",
  },
  {
    title: "Saída com os dados",
    text: "O administrador do grupo exporta os dados do workspace em arquivo único a qualquer momento, sem depender de pedido. Após o encerramento há 30 dias de recuperação antes da eliminação.",
  },
  {
    title: "Suporte",
    text: "Atendimento em dias úteis pelo formulário de contato, com o assunto de suporte. O acesso da nossa equipe aos dados do cliente é autorizado, temporário, justificado e auditado.",
  },
] as const;

/**
 * Dados jurídicos que dependem do proprietário do Vinculato.
 *
 * Razão social, CNPJ, endereço e o nome do encarregado não estão no repositório
 * e não podem ser inventados: um documento legal com identificação fictícia é
 * pior que um documento que declara a lacuna. Cada página legal exibe esta lista
 * para que a pendência apareça para quem lê e para quem publica, em vez de ficar
 * num comentário de código.
 */
export const legalPendingFields = [
  "Razão social e CNPJ do fornecedor",
  "Endereço da sede",
  "Nome e e-mail do encarregado pelo tratamento de dados (DPO)",
  "Foro eleito para os Termos de uso",
] as const;

/**
 * Cookies em uso.
 *
 * A varredura do código encontra um cookie só: o de sessão, `httpOnly`,
 * `SameSite=Lax`, gravado no login e apagado na saída. Não há analytics, pixel
 * de anúncio, mapa de calor nem script de terceiros — e é por isso que não há
 * banner de consentimento: pedir consentimento para o que é estritamente
 * necessário treina a pessoa a clicar em "aceitar" sem ler.
 */
export const cookieUsage = {
  essentialOnly: true,
  summary: "O site e o produto usam um único cookie, o de sessão, necessário para manter quem entrou autenticado. Ele é httpOnly, restrito ao mesmo site e apagado na saída.",
  absent: "Não há cookie de análise, de publicidade, de mapa de calor nem de rede social, e nenhum script de terceiros é carregado nas páginas públicas. Por isso não existe banner de consentimento: ele só seria devido se houvesse cookie não essencial.",
  change: "Se um cookie não essencial passar a existir, esta política será atualizada e o consentimento será pedido antes da gravação.",
} as const;

/* -------------------------------------------------------------------------- */
/* Captação de contato                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Assuntos do formulário de contato.
 *
 * `privacidade` entrou porque a página de privacidade manda o titular pedir
 * acesso, correção, anonimização ou portabilidade justamente por este
 * formulário — e não havia assunto para isso. O pedido chegava como "outro",
 * numa tabela chamada `fdp_marketing_leads`, listada no console sob "Leads
 * comerciais". Indistinguível de quem quer falar de preço, e sem nada marcando
 * o prazo de resposta que a mesma página promete.
 */
export const leadInterests = ["demonstracao", "planos", "integracoes", "suporte", "privacidade", "outro"] as const;
export type LeadInterest = typeof leadInterests[number];

export const leadInterestLabels: Record<LeadInterest, string> = {
  demonstracao: "Agendar uma demonstração",
  planos: "Falar sobre planos e condições",
  integracoes: "Tirar dúvidas sobre integrações",
  suporte: "Suporte a cliente atual",
  privacidade: "Privacidade e direitos do titular (LGPD)",
  outro: "Outro assunto",
};

/**
 * Prazo de resposta declarado na página de privacidade.
 *
 * O número mora aqui para que a página e a fila do console falem do mesmo
 * prazo. Ele é o compromisso já publicado — não uma garantia nova.
 */
export const PRIVACY_REQUEST_DEADLINE_DAYS = 15;

/** Um pedido de titular é um assunto do formulário, não uma tabela à parte. */
export const isPrivacyRequest = (interest: string) => interest === "privacidade";

export type LeadInput = {
  name: string;
  email: string;
  company: string;
  phone: string;
  headcount: string;
  interest: LeadInterest;
  message: string;
  consent: boolean;
};

function validEmail(value: string) {
  return /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/u.test(value) && value.length <= 180;
}

/** Valida o contato recebido do site. Consentimento é obrigatório (LGPD). */
export function sanitizeLead(body: Record<string, unknown>): LeadInput {
  const name = cleanText(body.name, 120);
  const email = cleanText(body.email, 180).toLowerCase();
  const interest = cleanText(body.interest, 30) as LeadInterest;
  if (name.length < 2) throw ApiError.badRequest("Informe seu nome.", "LEAD_NAME_REQUIRED");
  if (!validEmail(email)) throw ApiError.badRequest("Informe um e-mail válido.", "LEAD_EMAIL_INVALID");
  if (!leadInterests.includes(interest)) throw ApiError.badRequest("Selecione o assunto do contato.", "LEAD_INTEREST_INVALID");
  if (body.consent !== true) {
    throw ApiError.badRequest("É necessário concordar com o uso dos dados para retorno do contato.", "LEAD_CONSENT_REQUIRED");
  }
  return {
    name,
    email,
    company: cleanText(body.company, 160),
    phone: cleanText(body.phone, 40),
    headcount: cleanText(body.headcount, 40),
    interest,
    message: cleanText(body.message, 1000),
    consent: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Guarda de promessas                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Termos que o site não pode usar como promessa de funcionalidade.
 * Aparecer em uma negativa ("não faz admissão digital") é correto; aparecer
 * como oferta é violação do §90.
 */
export const prohibitedClaims = [
  { pattern: /admiss[ãa]o digital (?:pr[óo]pria|completa|no fila|integrada ao fila)/iu, reason: "admissão digital própria" },
  { pattern: /prontu[áa]rio/iu, reason: "prontuário psicológico" },
  { pattern: /agenda cl[íi]nica|evolu[çc][ãa]o cl[íi]nica|diagn[óo]stico do colaborador/iu, reason: "gestão clínica" },
  { pattern: /c[áa]lculo tribut[áa]rio|apura[çc][ãa]o de impostos|emiss[ãa]o de nota fiscal pelo fila/iu, reason: "cálculo tributário ou emissão fiscal" },
  { pattern: /substitui (?:o )?(?:erp|contador|sistema de folha)/iu, reason: "substituição de ERP/contador" },
] as const;

/**
 * Marcadores que transformam a menção em negativa.
 *
 * Dizer "não guarda prontuário" é obrigatório pelo próprio §90; o que a guarda
 * precisa impedir é a menção como oferta.
 */
const negationMarkers = /\b(n[ãa]o|nunca|jamais|sem|vedad[oa]|proibid[oa]|dispensa|fora do escopo|permanece n[oa]|continua n[oa])\b/iu;

/**
 * Verifica um texto de marketing contra as fronteiras do produto.
 *
 * A checagem é sensível ao contexto: uma ocorrência acompanhada de negação na
 * mesma vizinhança é considerada declaração de limite, não promessa.
 */
export function findProhibitedClaims(text: string) {
  // A negação precisa estar no mesmo trecho: uma negativa em outra frase não
  // autoriza a promessa seguinte.
  const boundary = /[.!?;\n<>{}"`]/u;
  const segmentAround = (index: number, length: number) => {
    let start = index;
    while (start > 0 && !boundary.test(text[start - 1])) start -= 1;
    let end = index + length;
    while (end < text.length && !boundary.test(text[end])) end += 1;
    return text.slice(start, end);
  };

  const reasons = new Set<string>();
  for (const claim of prohibitedClaims) {
    const pattern = new RegExp(claim.pattern.source, `${claim.pattern.flags.replace("g", "")}g`);
    for (const match of text.matchAll(pattern)) {
      const segment = segmentAround(match.index ?? 0, match[0].length);
      if (negationMarkers.test(segment)) continue;
      reasons.add(claim.reason);
    }
  }
  return [...reasons];
}
