import type { ProcessStepType } from "./process-management.ts";

/**
 * Modelagens iniciais dos processos que o Vinculato já conhece (§37).
 *
 * A queixa da §37 é concreta: quem abre a área de Processos hoje encontra tudo
 * vazio e um botão "Novo Processo" que entrega um diagrama com uma etapa
 * chamada "Nova etapa". Isso não é ponto de partida — é uma folha em branco
 * com moldura.
 *
 * Os três fluxos abaixo são os da §33, §34 e §35, transcritos como estão
 * escritos lá. Não são invenção nem exemplo genérico: são os processos que
 * este produto executa, e é por isso que as etapas casam com os módulos que
 * existem — "Aplicar Caju" é a exportação que `CajuExportPanel` faz, "Validar
 * estoque" é o saldo que o módulo de EPI controla.
 *
 * A §38 é a linha que não se cruza: isto é *template*, a descrição de como o
 * processo funciona. Nada aqui vira instância, competência, entrega ou
 * pagamento. Criar um processo a partir de um template escreve um rascunho de
 * diagrama e a configuração sugerida das etapas — e para por aí, esperando
 * quem o publique. É o que separa uma modelagem inicial de um dado falso em
 * produção, que a §90 proíbe.
 */

export type TemplateNodeType = "start" | "end" | "task" | "userTask" | "serviceTask" | "gateway";

export type TemplateNode = {
  id: string;
  type: TemplateNodeType;
  name: string;
  /** Canto superior esquerdo, em coordenadas do BPMN DI. */
  x: number;
  y: number;
  /** Tipo de etapa do Vinculato, quando ele difere do que o BPMN sugere. */
  stepType?: ProcessStepType;
  /** Uma frase sobre o que a etapa faz. Vira a descrição da etapa. */
  note?: string;
};

export type TemplateFlow = { id: string; from: string; to: string; name?: string };

export type ProcessTemplate = {
  key: string;
  /** Código sugerido; quem cria pode trocar antes de salvar. */
  code: string;
  name: string;
  category: string;
  description: string;
  objective: string;
  tags: readonly string[];
  /** Processo do menu a que a modelagem pertence (`lib/process-navigation.ts`). */
  processGroup: string;
  nodes: readonly TemplateNode[];
  flows: readonly TemplateFlow[];
};

/* -------------------------------------------------------------------------- */
/* Medidas do BPMN                                                            */
/* -------------------------------------------------------------------------- */

/** Tamanhos canônicos do BPMN 2.0 DI. Fugir deles faz o bpmn-js redesenhar o
 *  elemento na primeira edição e o diagrama "pular" na cara de quem abriu. */
const SIZE: Record<TemplateNodeType, { width: number; height: number }> = {
  start: { width: 36, height: 36 },
  end: { width: 36, height: 36 },
  task: { width: 120, height: 80 },
  userTask: { width: 120, height: 80 },
  serviceTask: { width: 120, height: 80 },
  gateway: { width: 50, height: 50 },
};

const BPMN_ELEMENT: Record<TemplateNodeType, string> = {
  start: "startEvent",
  end: "endEvent",
  task: "task",
  userTask: "userTask",
  serviceTask: "serviceTask",
  gateway: "exclusiveGateway",
};

const DEFAULT_STEP_TYPE: Record<TemplateNodeType, ProcessStepType> = {
  start: "START_EVENT",
  end: "END_EVENT",
  task: "TASK",
  userTask: "USER_TASK",
  serviceTask: "SYSTEM_TASK",
  gateway: "GATEWAY",
};

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const center = (node: TemplateNode) => {
  const { width, height } = SIZE[node.type];
  return { x: node.x + width / 2, y: node.y + height / 2 };
};

/**
 * Waypoints ortogonais entre dois elementos.
 *
 * Na mesma linha é uma reta da borda direita do primeiro à borda esquerda do
 * segundo. Em linhas diferentes — que é o caso de todo ramo de decisão — sai
 * pelo lado, anda até a coluna do destino e desce ou sobe. Aresta sem
 * waypoints no DI faz o bpmn-js desenhar tudo colapsado num canto, e o
 * diagrama chega ilegível.
 */
function waypoints(from: TemplateNode, to: TemplateNode) {
  const a = center(from);
  const b = center(to);
  const fromSize = SIZE[from.type];
  const toSize = SIZE[to.type];

  if (Math.abs(a.y - b.y) < 4) {
    return a.x < b.x
      ? [{ x: from.x + fromSize.width, y: a.y }, { x: to.x, y: b.y }]
      : [{ x: from.x, y: a.y }, { x: to.x + toSize.width, y: b.y }];
  }

  // Retorno para trás e para cima (o "Corrigir → Revisão" da §34): sai por
  // baixo, anda de volta e sobe pela coluna do destino.
  if (b.x < a.x) {
    return [
      { x: a.x, y: from.y + (a.y < b.y ? fromSize.height : 0) },
      { x: a.x, y: a.y < b.y ? b.y + toSize.height / 2 + 30 : b.y - toSize.height / 2 - 30 },
      { x: b.x, y: a.y < b.y ? b.y + toSize.height / 2 + 30 : b.y - toSize.height / 2 - 30 },
      { x: b.x, y: a.y < b.y ? to.y + toSize.height : to.y },
    ];
  }

  return [
    { x: from.x + fromSize.width / 2, y: a.y < b.y ? from.y + fromSize.height : from.y },
    { x: b.x, y: a.y < b.y ? from.y + fromSize.height : from.y },
    { x: b.x, y: a.y < b.y ? to.y : to.y + toSize.height },
  ];
}

/** BPMN 2.0 completo, com diagrama, pronto para o modelador abrir e editar. */
export function templateBpmnXml(template: ProcessTemplate) {
  const byId = new Map(template.nodes.map((node) => [node.id, node]));
  const processId = `Process_${template.key.replace(/[^A-Za-z0-9_]/g, "_")}`;

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const flow of template.flows) {
    outgoing.set(flow.from, [...(outgoing.get(flow.from) ?? []), flow.id]);
    incoming.set(flow.to, [...(incoming.get(flow.to) ?? []), flow.id]);
  }

  const elements = template.nodes.map((node) => {
    const tag = `bpmn:${BPMN_ELEMENT[node.type]}`;
    const refs = [
      ...(incoming.get(node.id) ?? []).map((id) => `<bpmn:incoming>${id}</bpmn:incoming>`),
      ...(outgoing.get(node.id) ?? []).map((id) => `<bpmn:outgoing>${id}</bpmn:outgoing>`),
    ].join("");
    return `    <${tag} id="${node.id}" name="${escape(node.name)}">${refs}</${tag}>`;
  }).join("\n");

  const sequences = template.flows.map((flow) =>
    `    <bpmn:sequenceFlow id="${flow.id}"${flow.name ? ` name="${escape(flow.name)}"` : ""} sourceRef="${flow.from}" targetRef="${flow.to}" />`,
  ).join("\n");

  const shapes = template.nodes.map((node) => {
    const { width, height } = SIZE[node.type];
    // O rótulo de evento e de gateway fica FORA da forma no BPMN: sem o
    // `BPMNLabel` o texto some, porque a forma de 36px não o comporta.
    const label = node.type === "start" || node.type === "end" || node.type === "gateway"
      ? `<bpmndi:BPMNLabel><dc:Bounds x="${node.x - 26}" y="${node.y + height + 6}" width="${width + 52}" height="27" /></bpmndi:BPMNLabel>`
      : "";
    return `      <bpmndi:BPMNShape id="${node.id}_di" bpmnElement="${node.id}"${node.type === "gateway" ? ' isMarkerVisible="true"' : ""}><dc:Bounds x="${node.x}" y="${node.y}" width="${width}" height="${height}" />${label}</bpmndi:BPMNShape>`;
  }).join("\n");

  const edges = template.flows.map((flow) => {
    const from = byId.get(flow.from);
    const to = byId.get(flow.to);
    if (!from || !to) throw new Error(`Fluxo ${flow.id} aponta para etapa inexistente.`);
    const points = waypoints(from, to).map((point) => `<di:waypoint x="${Math.round(point.x)}" y="${Math.round(point.y)}" />`).join("");
    const label = flow.name
      ? `<bpmndi:BPMNLabel><dc:Bounds x="${Math.round(points.length ? center(from).x : from.x)}" y="${Math.round(center(from).y) - 26}" width="60" height="16" /></bpmndi:BPMNLabel>`
      : "";
    return `      <bpmndi:BPMNEdge id="${flow.id}_di" bpmnElement="${flow.id}">${points}${label}</bpmndi:BPMNEdge>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Definitions_${template.key}" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="${processId}" name="${escape(template.name)}" isExecutable="false">
${elements}
${sequences}
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1"><bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${processId}">
${shapes}
${edges}
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;
}

/**
 * Configuração sugerida de cada etapa.
 *
 * Só o que o template tem como dizer sem inventar: o tipo da etapa e o nome, e
 * a descrição quando o fluxo original a explica. Responsável, área, SLA e
 * aprovador ficam vazios de propósito — eles dependem do organograma de cada
 * cliente, e preenchê-los com um palpite plausível seria a pior espécie de
 * dado falso: o que parece configurado e não está.
 */
export function templateStepConfigs(template: ProcessTemplate) {
  return template.nodes.map((node) => ({
    bpmnElementId: node.id,
    stepType: node.stepType ?? DEFAULT_STEP_TYPE[node.type],
    settings: { name: node.name, description: node.note ?? "" },
  }));
}

/* -------------------------------------------------------------------------- */
/* Os fluxos                                                                  */
/* -------------------------------------------------------------------------- */

const COLUMN = 170;
const ROW = 130;
const BASE_Y = 200;
/** Y do topo de uma tarefa alinhada com o centro da linha base. */
const taskY = (row = 0) => BASE_Y + row * ROW - SIZE.task.height / 2;
const eventY = (row = 0) => BASE_Y + row * ROW - SIZE.start.height / 2;
const gatewayY = (row = 0) => BASE_Y + row * ROW - SIZE.gateway.height / 2;
const at = (column: number) => 160 + column * COLUMN;

export const processTemplates: readonly ProcessTemplate[] = [
  {
    key: "entrega-epi",
    code: "EPI_ENTREGA",
    name: "Entrega de EPI",
    category: "seguranca-do-trabalho",
    processGroup: "epi",
    description: "Da solicitação do equipamento à movimentação de estoque, passando pela conferência de saldo e pela assinatura do colaborador.",
    objective: "Garantir que todo equipamento entregue tenha saldo conferido, recebimento assinado e movimentação registrada.",
    tags: ["epi", "sesmt", "estoque"],
    nodes: [
      { id: "Evento_Solicitacao", type: "start", name: "Solicitação", x: at(0), y: eventY(),
        note: "Entra pela ficha do colaborador ou por demanda da área." },
      { id: "Etapa_ValidarColaborador", type: "userTask", name: "Validar colaborador", x: at(1), y: taskY(),
        note: "Confere vínculo ativo, função e exigência de EPI para o cargo." },
      { id: "Etapa_ValidarEstoque", type: "userTask", name: "Validar estoque", x: at(2), y: taskY(),
        note: "Confere saldo disponível no local de estoque e a validade do CA." },
      { id: "Decisao_Saldo", type: "gateway", name: "Saldo disponível?", x: at(3), y: gatewayY() },
      { id: "Etapa_Pendencia", type: "userTask", name: "Registrar pendência", x: at(4), y: taskY(1),
        stepType: "DEMAND_CREATION",
        note: "Sem saldo, a entrega vira pendência com prazo em vez de ser recusada em silêncio." },
      { id: "Evento_FimPendencia", type: "end", name: "Aguardando reposição", x: at(5), y: eventY(1) },
      { id: "Etapa_Entrega", type: "userTask", name: "Entrega", x: at(4), y: taskY(),
        note: "Baixa a quantidade entregue e registra o local de retirada." },
      { id: "Etapa_Assinatura", type: "userTask", name: "Assinatura", x: at(5), y: taskY(),
        stepType: "DOCUMENT_REQUEST",
        note: "Comprovante assinado pelo colaborador; é a evidência que a fiscalização pede." },
      { id: "Etapa_Movimentacao", type: "serviceTask", name: "Movimentação", x: at(6), y: taskY(),
        note: "Lança a saída no estoque e no histórico do colaborador." },
      { id: "Evento_Fim", type: "end", name: "Entrega concluída", x: at(7), y: eventY() },
    ],
    flows: [
      { id: "Fluxo_epi_1", from: "Evento_Solicitacao", to: "Etapa_ValidarColaborador" },
      { id: "Fluxo_epi_2", from: "Etapa_ValidarColaborador", to: "Etapa_ValidarEstoque" },
      { id: "Fluxo_epi_3", from: "Etapa_ValidarEstoque", to: "Decisao_Saldo" },
      { id: "Fluxo_epi_4", from: "Decisao_Saldo", to: "Etapa_Entrega", name: "Sim" },
      { id: "Fluxo_epi_5", from: "Decisao_Saldo", to: "Etapa_Pendencia", name: "Não" },
      { id: "Fluxo_epi_6", from: "Etapa_Pendencia", to: "Evento_FimPendencia" },
      { id: "Fluxo_epi_7", from: "Etapa_Entrega", to: "Etapa_Assinatura" },
      { id: "Fluxo_epi_8", from: "Etapa_Assinatura", to: "Etapa_Movimentacao" },
      { id: "Fluxo_epi_9", from: "Etapa_Movimentacao", to: "Evento_Fim" },
    ],
  },
  {
    key: "pagamento-pj",
    code: "PJ_COMPETENCIA",
    name: "Pagamento de prestadores PJ",
    category: "pagamentos",
    processGroup: "pagamentos",
    description: "Abertura da competência, apuração dos valores, ajustes, Caju, revisão e encerramento com aprovação.",
    objective: "Fechar a competência de PJ sem pendência aberta e com o valor aprovado antes do pagamento.",
    tags: ["pagamentos", "prestadores", "competencia"],
    nodes: [
      { id: "Evento_AbrirCompetencia", type: "start", name: "Abrir competência", x: at(0), y: eventY(),
        note: "A competência nasce aberta e só aceita lançamento enquanto estiver assim." },
      { id: "Etapa_CarregarPrestadores", type: "serviceTask", name: "Carregar prestadores", x: at(1), y: taskY(),
        note: "Traz os contratos ativos no período, com limite e meio de pagamento." },
      { id: "Etapa_CalcularValores", type: "serviceTask", name: "Calcular valores", x: at(2), y: taskY(),
        note: "Apura o bruto do contrato e o líquido devido no período." },
      { id: "Etapa_Ajustes", type: "userTask", name: "Aplicar ajustes", x: at(3), y: taskY(),
        note: "Acréscimos e descontos do período, cada um com justificativa." },
      { id: "Etapa_Caju", type: "userTask", name: "Aplicar Caju", x: at(4), y: taskY(),
        note: "Complemento destinado ao meio configurado, dentro do limite do contrato." },
      { id: "Etapa_Revisao", type: "userTask", name: "Revisão", x: at(5), y: taskY(),
        note: "Conferência do total apurado contra o esperado da nota fiscal." },
      { id: "Decisao_Pendencias", type: "gateway", name: "Há pendências?", x: at(6), y: gatewayY() },
      { id: "Etapa_Corrigir", type: "userTask", name: "Corrigir", x: at(5), y: taskY(1),
        note: "Volta para a revisão depois do acerto; a competência não avança com pendência." },
      { id: "Etapa_Aprovar", type: "userTask", name: "Aprovar", x: at(7), y: taskY(),
        stepType: "APPROVAL",
        note: "Decisão registrada com autor e data — é ela que libera o encerramento." },
      { id: "Etapa_Fechar", type: "serviceTask", name: "Fechar competência", x: at(8), y: taskY(),
        note: "Trava lançamentos e congela os valores apurados." },
      { id: "Evento_Fim", type: "end", name: "Competência encerrada", x: at(9), y: eventY() },
    ],
    flows: [
      { id: "Fluxo_pj_1", from: "Evento_AbrirCompetencia", to: "Etapa_CarregarPrestadores" },
      { id: "Fluxo_pj_2", from: "Etapa_CarregarPrestadores", to: "Etapa_CalcularValores" },
      { id: "Fluxo_pj_3", from: "Etapa_CalcularValores", to: "Etapa_Ajustes" },
      { id: "Fluxo_pj_4", from: "Etapa_Ajustes", to: "Etapa_Caju" },
      { id: "Fluxo_pj_5", from: "Etapa_Caju", to: "Etapa_Revisao" },
      { id: "Fluxo_pj_6", from: "Etapa_Revisao", to: "Decisao_Pendencias" },
      { id: "Fluxo_pj_7", from: "Decisao_Pendencias", to: "Etapa_Corrigir", name: "Sim" },
      { id: "Fluxo_pj_8", from: "Etapa_Corrigir", to: "Etapa_Revisao" },
      { id: "Fluxo_pj_9", from: "Decisao_Pendencias", to: "Etapa_Aprovar", name: "Não" },
      { id: "Fluxo_pj_10", from: "Etapa_Aprovar", to: "Etapa_Fechar" },
      { id: "Fluxo_pj_11", from: "Etapa_Fechar", to: "Evento_Fim" },
    ],
  },
  {
    key: "demanda-entre-areas",
    code: "DP_DEMANDA",
    name: "Demanda entre áreas",
    category: "operacao",
    processGroup: "operacao-dp",
    description: "Da abertura pelo solicitante à conclusão, com triagem da área responsável e aprovação quando o caso exige.",
    objective: "Dar rastro e prazo a toda solicitação entre áreas, sem depender de mensagem avulsa.",
    tags: ["demandas", "sla", "triagem"],
    nodes: [
      { id: "Evento_Solicitacao", type: "start", name: "Solicitante abre a demanda", x: at(0), y: eventY(),
        note: "Entra pelo quadro, pelo Inbox ou por integração." },
      { id: "Etapa_Triagem", type: "userTask", name: "Triagem", x: at(1), y: taskY(),
        note: "A área responsável confirma escopo, prioridade e prazo." },
      { id: "Etapa_Execucao", type: "userTask", name: "Execução", x: at(2), y: taskY(),
        note: "Trabalho com checklist e evidências anexadas à demanda." },
      { id: "Decisao_Aprovacao", type: "gateway", name: "Precisa de aprovação?", x: at(3), y: gatewayY() },
      { id: "Etapa_Aprovacao", type: "userTask", name: "Aprovação", x: at(4), y: taskY(1),
        stepType: "APPROVAL",
        note: "Decisão de quem responde pela área, registrada na trilha." },
      { id: "Etapa_Concluir", type: "userTask", name: "Concluir", x: at(5), y: taskY(),
        note: "Fecha a demanda e devolve a resposta ao solicitante." },
      { id: "Evento_Fim", type: "end", name: "Demanda concluída", x: at(6), y: eventY() },
    ],
    flows: [
      { id: "Fluxo_dem_1", from: "Evento_Solicitacao", to: "Etapa_Triagem" },
      { id: "Fluxo_dem_2", from: "Etapa_Triagem", to: "Etapa_Execucao" },
      { id: "Fluxo_dem_3", from: "Etapa_Execucao", to: "Decisao_Aprovacao" },
      { id: "Fluxo_dem_4", from: "Decisao_Aprovacao", to: "Etapa_Aprovacao", name: "Sim" },
      { id: "Fluxo_dem_5", from: "Etapa_Aprovacao", to: "Etapa_Concluir" },
      { id: "Fluxo_dem_6", from: "Decisao_Aprovacao", to: "Etapa_Concluir", name: "Não" },
      { id: "Fluxo_dem_7", from: "Etapa_Concluir", to: "Evento_Fim" },
    ],
  },
] as const;

export function findProcessTemplate(key: unknown) {
  const wanted = typeof key === "string" ? key.trim() : "";
  return processTemplates.find((template) => template.key === wanted) ?? null;
}

/** Resumo para a galeria: quantas etapas e quantas decisões o fluxo tem. */
export function templateShape(template: ProcessTemplate) {
  return {
    steps: template.nodes.filter((node) => node.type !== "start" && node.type !== "end" && node.type !== "gateway").length,
    decisions: template.nodes.filter((node) => node.type === "gateway").length,
    ends: template.nodes.filter((node) => node.type === "end").length,
  };
}
