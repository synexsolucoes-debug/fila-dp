import { cleanText } from "./registrations.ts";
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
    "O Fila DP organiza demandas, prazos, competências, conferências e pagamentos auxiliares do DP,",
    "e conecta os sistemas que sua operação já usa. Ele não substitui o ERP de folha, o sistema de ponto,",
    "a Sólides nem o sistema contábil: ele coordena o trabalho entre eles.",
  ].join(" "),
};

/** O que o produto explicitamente não é — exibido no site, não escondido. */
export const productBoundaries = [
  {
    title: "Não é ERP de folha",
    text: "O cálculo oficial da folha continua no seu ERP. O Fila DP prepara movimentações, confere o resultado e registra divergências.",
  },
  {
    title: "Não faz admissão digital",
    text: "A admissão digital é executada integralmente na Sólides. O Fila DP recebe dados de pessoas já admitidas e concilia com o ERP.",
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
    text: "As marcações oficiais continuam no seu sistema de ponto. O Fila DP importa o resultado para conferência.",
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
 */
export const integrationCatalog = [
  { name: "Microsoft Teams", category: "Comunicação", state: "available", note: "Entrada de solicitações por webhook assinado." },
  { name: "E-mail corporativo", category: "Comunicação", state: "available", note: "Caixa de entrada operacional por webhook." },
  { name: "WhatsApp Business", category: "Comunicação", state: "available", note: "Recebimento de solicitações por webhook." },
  { name: "Sankhya", category: "ERP", state: "partial", note: "Conector com credencial por workspace; requer endpoint e homologação com o cliente." },
  { name: "API pública Fila DP", category: "Plataforma", state: "available", note: "Leitura da operação e envio de créditos/descontos PJ, com escopos e idempotência." },
  { name: "Webhooks de saída", category: "Plataforma", state: "available", note: "Eventos assinados com HMAC, repetição e log de entrega." },
  { name: "Sólides", category: "Admissão", state: "planned", note: "Aguarda recurso oficial e credenciais. A admissão permanece na Sólides." },
  { name: "Caju", category: "Benefícios", state: "planned", note: "Complemento é controle assistido com exportação; não há integração oficial implementada." },
  { name: "Domínio, Senior, TOTVS, Alterdata e outros ERPs", category: "ERP", state: "planned", note: "Arquitetura de conectores pronta; cada integração exige documentação e homologação." },
  { name: "Sistemas de ponto", category: "Ponto", state: "planned", note: "Importação para conferência; o módulo de ponto ainda não faz parte do produto." },
] as const;

export const integrationStateLabels: Record<string, string> = {
  available: "Disponível",
  partial: "Parcial",
  planned: "Preparado",
};

export const faqEntries = [
  {
    question: "O Fila DP substitui meu sistema de folha?",
    answer: "Não. O cálculo oficial continua no seu ERP. O Fila DP organiza as demandas e movimentações que alimentam a folha e confere o resultado que volta dela.",
  },
  {
    question: "Como fica a admissão feita na Sólides?",
    answer: "A admissão digital é executada integralmente na Sólides. O Fila DP não cria fluxo concorrente: ele recebe os dados de quem já foi admitido e concilia com o ERP quando houver meio oficial de integração.",
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
    answer: "Sim. A API pública usa chave com escopos, limite por minuto e idempotência nas escritas. Os webhooks de saída são assinados com HMAC e possuem repetição com log de entrega.",
  },
] as const;

/* -------------------------------------------------------------------------- */
/* Captação de contato                                                         */
/* -------------------------------------------------------------------------- */

export const leadInterests = ["demonstracao", "planos", "integracoes", "suporte", "outro"] as const;
export type LeadInterest = typeof leadInterests[number];

export const leadInterestLabels: Record<LeadInterest, string> = {
  demonstracao: "Agendar uma demonstração",
  planos: "Falar sobre planos e condições",
  integracoes: "Tirar dúvidas sobre integrações",
  suporte: "Suporte a cliente atual",
  outro: "Outro assunto",
};

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
