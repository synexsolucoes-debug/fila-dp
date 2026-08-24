/**
 * Endereços reais para o painel (§43, §44).
 *
 * O painel inteiro era um estado de React em `/painel`: quinze telas atrás de
 * um `type View`, sem URL. O efeito prático não é estético — é operacional.
 * Não dava para mandar o link de uma demanda para um colega, o botão voltar
 * saía do produto, e recarregar a página perdia onde a pessoa estava. Em um
 * sistema de DP, "manda o link dessa demanda" é a frase mais dita do dia.
 *
 * Este módulo é a tradução, e só ela: estado ⇄ endereço. Ele não conhece React,
 * não toca no DOM e não sabe navegar — por isso pode ser testado inteiro sem
 * navegador, que é o que impede um mapeamento errado de só aparecer em produção.
 *
 * ## O que **não** foi feito, de propósito
 *
 * O painel não virou uma rota por tela do Next. Ele continua sendo um
 * componente que troca de visão por estado; o que mudou é que o estado passou a
 * ter endereço. Reescrever a navegação inteira era a recomendação óbvia e a
 * errada: custaria a reescrita do maior componente do produto para entregar o
 * mesmo que a sincronização de URL entrega (§43, "não reescrever tudo").
 *
 * ## Autorização
 *
 * Nenhuma decisão de acesso mora aqui. Um endereço é um pedido, não uma
 * permissão: quem recusa continua sendo o servidor, na rota de dados. Abrir
 * `/painel/pj` sem o módulo liberado leva à mesma recusa explicada de sempre.
 */

export const panelViews = [
  "overview", "work", "board", "inbox", "planner", "processManagement", "processes",
  "auxiliary", "psychologistPayments", "contractorPayments", "contractorProviders",
  "contractorCycles", "contractorClosings", "contractorAdjustments", "contractorLimits",
  "contractorCaju", "contractorArchive", "timeTracking", "epi", "integrations",
  "agents", "triage", "registrations", "payroll", "indicators",
] as const;
export type PanelView = typeof panelViews[number];

/**
 * Endereço de cada visão, em português.
 *
 * Os segmentos são o vocabulário do cliente, não o do código: quem cola o link
 * no chat da equipe lê "pj/fechamentos" e sabe o que vai abrir.
 */
const VIEW_PATHS: Record<PanelView, string> = {
  overview: "",
  work: "trabalho",
  board: "demandas",
  inbox: "entradas",
  planner: "planner",
  processManagement: "processos",
  processes: "operacao",
  auxiliary: "auxiliares",
  psychologistPayments: "psicologia",
  contractorPayments: "pj",
  contractorProviders: "pj/prestadores",
  contractorCycles: "pj/competencias",
  contractorClosings: "pj/fechamentos",
  contractorAdjustments: "pj/ajustes",
  contractorLimits: "pj/limites",
  contractorCaju: "pj/caju",
  contractorArchive: "pj/arquivo",
  timeTracking: "ponto",
  epi: "epi",
  integrations: "integracoes",
  agents: "agentes",
  triage: "triagem",
  registrations: "cadastros",
  payroll: "folha",
  indicators: "indicadores",
};

/**
 * Visões que abrem um registro pelo endereço.
 *
 * A demanda é o link que se manda para o colega; o item de triagem é o link que
 * se manda para quem sabe de quem ele é. As demais visões não abrem registro, e
 * um identificador pendurado nelas seria um endereço que promete e não entrega.
 */
const VIEWS_WITH_RECORD = new Set<PanelView>(["board", "triage"]);

/* Do endereço para a visão. Ordenado do caminho mais longo para o mais curto:
   sem isso `pj/fechamentos` casaria com `pj` e a pessoa cairia na tela errada. */
const PATH_VIEWS = (Object.entries(VIEW_PATHS) as Array<[PanelView, string]>)
  .filter(([, path]) => path)
  .sort(([, left], [, right]) => right.length - left.length);

export const settingsSections = [
  "general", "companies", "columns", "team", "security", "fields", "templates", "sla", "automations",
] as const;
export type PanelSettingsSection = typeof settingsSections[number];

const SETTINGS_PATHS: Record<PanelSettingsSection, string> = {
  general: "grupo",
  companies: "empresas",
  columns: "colunas",
  team: "acessos",
  security: "seguranca",
  fields: "campos",
  templates: "modelos",
  sla: "sla",
  automations: "automacoes",
};

const SETTINGS_BY_PATH = new Map(
  (Object.entries(SETTINGS_PATHS) as Array<[PanelSettingsSection, string]>)
    .map(([section, path]) => [path, section]),
);

export type PanelLocation = {
  view: PanelView;
  /** Registro aberto dentro da visão — hoje, a demanda. */
  recordId: string;
  /** Configurações abertas, e em qual seção (§46). */
  settings: PanelSettingsSection | null;
  /** Filtro de empresa; vazio significa "todas as que a pessoa enxerga". */
  companyId: string;
};

export const defaultPanelLocation: PanelLocation = {
  view: "overview", recordId: "", settings: null, companyId: "",
};

const clean = (value: unknown, max = 120) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/**
 * Endereço a partir do estado.
 *
 * Sempre absoluto e sempre começando em `/painel`: um caminho relativo
 * dependeria de onde a pessoa está, e o ponto de ter endereço é justamente ele
 * não depender disso.
 */
export function panelPath(location: Partial<PanelLocation>): string {
  const view = location.view && panelViews.includes(location.view) ? location.view : "overview";
  const recordId = clean(location.recordId);
  const settings = location.settings && settingsSections.includes(location.settings) ? location.settings : null;

  const segments: string[] = ["painel"];
  if (settings) {
    segments.push("configuracoes", SETTINGS_PATHS[settings]);
  } else {
    const path = VIEW_PATHS[view];
    if (path) segments.push(...path.split("/"));
    // O registro só faz sentido dentro da visão que sabe abri-lo.
    if (recordId && VIEWS_WITH_RECORD.has(view)) segments.push(encodeURIComponent(recordId));
  }

  const companyId = clean(location.companyId);
  const query = companyId ? `?empresa=${encodeURIComponent(companyId)}` : "";
  return `/${segments.join("/")}${query}`;
}

/**
 * Estado a partir do endereço.
 *
 * Endereço desconhecido não é erro: cai na visão geral. Um 404 aqui puniria a
 * pessoa por um link antigo que alguém mandou meses atrás — e o painel tem
 * exatamente uma resposta útil para isso, que é abrir.
 */
export function parsePanelPath(pathname: string, search = ""): PanelLocation {
  const parameters = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const companyId = clean(parameters.get("empresa"));

  const raw = clean(pathname, 400).replace(/^\/+|\/+$/gu, "");
  const parts = raw.split("/").filter(Boolean);
  if (parts[0] !== "painel") return { ...defaultPanelLocation, companyId };
  const rest = parts.slice(1).map((part) => decodeURIComponent(part));
  if (rest.length === 0) return { ...defaultPanelLocation, companyId };

  if (rest[0] === "configuracoes") {
    const section = SETTINGS_BY_PATH.get(rest[1] ?? "") ?? "general";
    return { view: "overview", recordId: "", settings: section, companyId };
  }

  for (const [view, path] of PATH_VIEWS) {
    const expected = path.split("/");
    if (expected.every((segment, index) => rest[index] === segment)) {
      const extra = rest.slice(expected.length);
      const recordId = VIEWS_WITH_RECORD.has(view) ? clean(extra[0]) : "";
      return { view, recordId, settings: null, companyId };
    }
  }
  return { ...defaultPanelLocation, companyId };
}

/** Endereço de uma demanda — o link que se manda para o colega. */
export function demandPath(cardId: string, companyId = "") {
  return panelPath({ view: "board", recordId: cardId, companyId });
}

/** Endereço de um item de triagem — o link que se manda para quem sabe resolvê-lo. */
export function triagePath(itemId: string) {
  return panelPath({ view: "triage", recordId: itemId });
}

/** Os endereços que o produto promete; usado pela verificação de navegador. */
export function panelRoutes(): string[] {
  return [
    ...panelViews.map((view) => panelPath({ view })),
    ...settingsSections.map((settings) => panelPath({ settings })),
  ];
}
