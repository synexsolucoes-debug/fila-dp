/**
 * Navegação por processo (§25 a §27, §64 a §66, §69, §70).
 *
 * O menu anterior era uma lista de quinze telas sob quatro rótulos de
 * departamento — OPERAÇÃO, PESSOAS E CADASTROS, FINANCEIRO, DADOS E ANÁLISE.
 * Isso responde "de quem é esta tela", que é a pergunta de quem montou o
 * organograma, e não "onde estou no trabalho", que é a de quem opera. Quem
 * apura uma competência de PJ passava por FINANCEIRO para o pagamento, por
 * OPERAÇÃO para os serviços da competência e por PESSOAS para o cadastro do
 * prestador — três seções para um processo só.
 *
 * Aqui os módulos são agrupados pelo processo operacional a que pertencem. A
 * §27 é explícita sobre o que isso *não* é: departamento não é processo. O
 * SESMT participa da Gestão de EPI e o DP participa da análise de desconto do
 * mesmo EPI; nenhum dos dois vira um item de menu, porque nenhum dos dois é um
 * processo.
 *
 * Este módulo é puro de propósito — sem React, sem ícone, sem acesso a banco.
 * O que ele decide é a *estrutura*: quais processos existem, que módulos moram
 * em cada um e em que ordem. O ícone e o rótulo curto de cada módulo continuam
 * no catálogo de telas do painel, que é quem os desenha.
 */

/** Identidade de tela do painel. String livre aqui: o tipo `View` mora no
 *  componente, e importá-lo puxaria React para dentro de um módulo puro. */
export type ProcessNavView = string;

export type ProcessGroupKind =
  /** Um processo operacional: tem início, etapas e fim, e atravessa áreas. */
  | "process"
  /** Apoio: não é processo, é a base ou a leitura sobre a qual eles rodam. */
  | "support";

export type ProcessGroup = {
  id: string;
  /** Nome curto — é o que aparece no menu. */
  label: string;
  /** Uma linha sobre o que o processo faz. Vira o subtítulo do cabeçalho
   *  contextual da §70; um grupo sem isso vira pasta sem explicação. */
  description: string;
  kind: ProcessGroupKind;
  /** Telas do processo, na ordem em que a subnavegação as apresenta. A
   *  primeira é o destino ao entrar no processo. */
  views: readonly ProcessNavView[];
};

/**
 * Os processos do Vinculato.
 *
 * A ordem é a da operação, não a alfabética: a Operação DP vem primeiro porque
 * é onde a maior parte do trabalho diário acontece, e os apoios vêm por
 * último porque são consultados, não executados.
 *
 * Um processo com uma tela só continua sendo um processo — Gestão de EPI é o
 * caso. O que ele não ganha é subnavegação: uma barra de abas com uma aba é
 * ruído. Quem decide isso é `hasSubNavigation`, mais abaixo.
 */
export const processGroups: readonly ProcessGroup[] = [
  {
    id: "operacao-dp",
    label: "Operação DP",
    description: "Competências, demandas, triagem e agenda do departamento pessoal.",
    kind: "process",
    views: ["processes", "board", "inbox", "planner"],
  },
  {
    id: "pagamentos",
    label: "Pagamentos e competências",
    description: "Prestadores, psicólogos, benefícios e folha: da apuração ao encerramento.",
    kind: "process",
    /* O Pagamento PJ ocupa oito destas entradas (§74).
     *
     * Era uma tela só, rolando: totais, lançamentos fixos, exportação Caju e a
     * tabela de fechamentos com treze colunas, um embaixo do outro. Quem
     * precisava conferir um limite de nota rolava por tudo; quem só queria
     * saber quanto sair rolava por tudo. Cada um destes oito destinos tem
     * dados próprios vindos do servidor — nenhum é página vazia esperando
     * conteúdo (§75). "Contratos" não está aqui justamente por isso: não
     * existe a entidade. */
    views: [
      "contractorPayments", "contractorProviders", "contractorCycles", "contractorClosings",
      "contractorAdjustments", "contractorLimits", "contractorCaju", "contractorArchive",
      "psychologistPayments", "auxiliary", "payroll",
    ],
  },
  {
    id: "epi",
    label: "Gestão de EPI",
    description: "Estoque, entrega, devolução, higienização, descarte e análise de desconto.",
    kind: "process",
    views: ["epi"],
  },
  {
    id: "jornada",
    label: "Ponto e jornada",
    description: "Conferência de marcações, tratativa de inconsistências e envio para a folha.",
    kind: "process",
    views: ["timeTracking"],
  },
  {
    id: "desenho",
    label: "Desenho de processos",
    description: "Modelagem, versionamento e publicação dos processos que a operação executa.",
    kind: "support",
    views: ["processManagement"],
  },
  {
    id: "cadastros",
    label: "Cadastros",
    description: "Empresas, colaboradores e estruturas auxiliares que os processos consomem.",
    kind: "support",
    views: ["registrations"],
  },
  {
    id: "analise",
    label: "Relatórios e integrações",
    description: "Indicadores da operação e estado das conexões com os sistemas de origem.",
    kind: "support",
    views: ["indicators", "integrations"],
  },
] as const;

/** A tela que não pertence a processo nenhum: é a porta de entrada para todos. */
export const workspaceHomeView: ProcessNavView = "overview";

/**
 * Grupos que esta pessoa vê, já recortados pelas telas que ela pode abrir.
 *
 * O recorte é o mesmo de sempre — plano contratado e papel, decididos uma vez
 * pelo painel — e chega aqui pronto. A §30 é o motivo de este ser o único
 * caminho: um processo cujas telas estão todas fora do alcance não pode virar
 * item de menu, nem cartão na home. Um menu que oferece o que não abre ensina
 * a desconfiar do menu.
 */
export function visibleProcessGroups(visibleViews: readonly ProcessNavView[]) {
  const allowed = new Set(visibleViews);
  return processGroups
    .map((group) => ({ ...group, views: group.views.filter((view) => allowed.has(view)) }))
    .filter((group) => group.views.length > 0);
}

/** Em que processo mora uma tela. `null` para a home, que não mora em nenhum. */
export function groupOfView(view: ProcessNavView): ProcessGroup | null {
  return processGroups.find((group) => group.views.includes(view)) ?? null;
}

/** Subnavegação só existe com mais de um destino: uma aba sozinha é ruído. */
export function hasSubNavigation(group: Pick<ProcessGroup, "views">) {
  return group.views.length > 1;
}

/**
 * Toda tela do painel pertence a exatamente um processo — ou é a home.
 *
 * Esta conta existe porque o modo de falhar é silencioso: acrescentar uma tela
 * ao catálogo e esquecer de colocá-la num grupo a faz sumir do menu, sem erro
 * de compilação e sem tela em branco. Ela simplesmente não tem mais porta.
 */
export function viewsWithoutProcess(allViews: readonly ProcessNavView[]) {
  const mapped = new Set(processGroups.flatMap((group) => group.views));
  return allViews.filter((view) => view !== workspaceHomeView && !mapped.has(view));
}

/** Telas de um grupo que não existem no catálogo — o erro pelo outro lado. */
export function unknownProcessViews(allViews: readonly ProcessNavView[]) {
  const known = new Set(allViews);
  return processGroups.flatMap((group) => group.views).filter((view) => !known.has(view));
}
