/**
 * Leitura do BPMN publicado como grafo de etapas.
 *
 * O produto já guardava o diagrama e a configuração de cada elemento; o que
 * faltava era alguém **ler o desenho** para saber que etapa vem depois de qual.
 * Sem isso, "processo publicado" era um documento, não uma definição executável:
 * a transição de etapa não tinha como ser validada contra nada.
 *
 * Duas decisões que valem explicação:
 *
 * 1. **Sem biblioteca.** `bpmn-moddle` existe no projeto, mas só como dependência
 *    de desenvolvimento e ele assume ambiente com DOM. O que o motor precisa do
 *    BPMN é pequeno e estável desde 2011: quem são os nós e quais setas ligam
 *    quem a quem. Um leitor próprio, determinístico e testável com o XML real,
 *    custa menos do que carregar um parser inteiro no caminho de uma transição.
 *
 * 2. **Ignora o que não entende.** Um elemento desconhecido não derruba a
 *    leitura; ele simplesmente não vira nó, e nenhuma seta pode apontar para ele.
 *    Recusar o diagrama inteiro por causa de um artefato de anotação
 *    transformaria uma decoração do desenhista em indisponibilidade do processo.
 *
 * O que este módulo **não** faz: decidir se a transição pode acontecer. Ele
 * responde "para onde o desenho permite ir"; quem decide é
 * `lib/process-instances.ts`, com permissão, requisito e evidência na mão.
 */

export type BpmnNodeRole = "start" | "end" | "task" | "gateway" | "subprocess" | "intermediate";

export type BpmnNode = {
  id: string;
  /** Nome local do elemento no XML (`userTask`, `exclusiveGateway`…). */
  element: string;
  role: BpmnNodeRole;
  name: string;
  outgoing: string[];
  incoming: string[];
};

export type BpmnFlow = { id: string; source: string; target: string; name: string };

export type BpmnGraph = {
  processId: string;
  nodes: Map<string, BpmnNode>;
  flows: BpmnFlow[];
  /** Em ordem de documento: um diagrama com dois inícios continua determinístico. */
  startIds: string[];
  endIds: string[];
};

const NODE_ROLES: Record<string, BpmnNodeRole> = {
  startEvent: "start",
  endEvent: "end",
  task: "task",
  userTask: "task",
  serviceTask: "task",
  scriptTask: "task",
  manualTask: "task",
  sendTask: "task",
  receiveTask: "task",
  businessRuleTask: "task",
  callActivity: "task",
  subProcess: "subprocess",
  transaction: "subprocess",
  exclusiveGateway: "gateway",
  parallelGateway: "gateway",
  inclusiveGateway: "gateway",
  eventBasedGateway: "gateway",
  complexGateway: "gateway",
  intermediateCatchEvent: "intermediate",
  intermediateThrowEvent: "intermediate",
  boundaryEvent: "intermediate",
};

function decodeEntities(value: string) {
  return value
    .replace(/&lt;/gu, "<").replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"').replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gu, "&");
}

type Tag = { name: string; attributes: Record<string, string> };

/**
 * Varredura de tags respeitando aspas.
 *
 * Um `>` dentro de `name="Aprovação > 2 dias"` é legal em XML e quebraria a
 * varredura ingênua por `<[^>]*>`, cortando a tag ao meio e perdendo o
 * `targetRef` que vem depois — ou seja, sumindo com uma seta do processo.
 */
function* scanTags(xml: string): Generator<Tag> {
  let index = 0;
  while (index < xml.length) {
    const start = xml.indexOf("<", index);
    if (start < 0) return;
    if (xml.startsWith("<!--", start)) {
      const end = xml.indexOf("-->", start);
      index = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<?", start) || xml.startsWith("<!", start)) {
      const end = xml.indexOf(">", start);
      index = end < 0 ? xml.length : end + 1;
      continue;
    }
    let cursor = start + 1;
    let quote = "";
    while (cursor < xml.length) {
      const char = xml[cursor];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
      cursor += 1;
    }
    const raw = xml.slice(start + 1, cursor);
    index = cursor + 1;
    if (!raw || raw.startsWith("/")) continue;

    const nameMatch = /^([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)/u.exec(raw);
    if (!nameMatch) continue;
    const attributes: Record<string, string> = {};
    for (const attribute of raw.slice(nameMatch[0].length).matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/gu)) {
      attributes[attribute[1]] = decodeEntities(attribute[3] ?? attribute[4] ?? "");
    }
    yield { name: nameMatch[2], attributes };
  }
}

const emptyNode = (id: string, element: string, role: BpmnNodeRole, name: string): BpmnNode =>
  ({ id, element, role, name, outgoing: [], incoming: [] });

/**
 * Constrói o grafo a partir do XML da versão publicada.
 *
 * Setas cujas pontas não existem entre os nós são descartadas: uma referência
 * pendurada viraria uma transição para lugar nenhum, e o motor precisa poder
 * afirmar que todo destino que ele oferece existe.
 */
export function parseBpmnGraph(xml: unknown): BpmnGraph {
  const source = typeof xml === "string" ? xml : "";
  const nodes = new Map<string, BpmnNode>();
  const rawFlows: BpmnFlow[] = [];
  let processId = "";

  for (const tag of scanTags(source)) {
    if (tag.name === "process" && !processId) {
      processId = tag.attributes.id ?? "";
      continue;
    }
    if (tag.name === "sequenceFlow") {
      const id = tag.attributes.id ?? "";
      const flowSource = tag.attributes.sourceRef ?? "";
      const target = tag.attributes.targetRef ?? "";
      if (id && flowSource && target) rawFlows.push({ id, source: flowSource, target, name: tag.attributes.name ?? "" });
      continue;
    }
    const role = NODE_ROLES[tag.name];
    const id = tag.attributes.id ?? "";
    if (!role || !id || nodes.has(id)) continue;
    nodes.set(id, emptyNode(id, tag.name, role, tag.attributes.name ?? ""));
  }

  const flows = rawFlows.filter((flow) => nodes.has(flow.source) && nodes.has(flow.target));
  for (const flow of flows) {
    nodes.get(flow.source)?.outgoing.push(flow.id);
    nodes.get(flow.target)?.incoming.push(flow.id);
  }

  const ordered = [...nodes.values()];
  return {
    processId,
    nodes,
    flows,
    startIds: ordered.filter((node) => node.role === "start").map((node) => node.id),
    endIds: ordered.filter((node) => node.role === "end").map((node) => node.id),
  };
}

/** Destinos que o desenho autoriza a partir desta etapa, em ordem de documento. */
export function allowedTargets(graph: BpmnGraph, stepId: string): string[] {
  const node = graph.nodes.get(stepId);
  if (!node) return [];
  const byId = new Map(graph.flows.map((flow) => [flow.id, flow]));
  const targets = node.outgoing.map((flowId) => byId.get(flowId)?.target ?? "").filter(Boolean);
  return [...new Set(targets)];
}

/** As setas que saem da etapa, com o rótulo — é o que a tela oferece como botão. */
export function outgoingFlows(graph: BpmnGraph, stepId: string): BpmnFlow[] {
  const node = graph.nodes.get(stepId);
  if (!node) return [];
  const byId = new Map(graph.flows.map((flow) => [flow.id, flow]));
  return node.outgoing.map((flowId) => byId.get(flowId)).filter((flow): flow is BpmnFlow => Boolean(flow));
}

export function isTerminalStep(graph: BpmnGraph, stepId: string) {
  const node = graph.nodes.get(stepId);
  if (!node) return false;
  return node.role === "end" || node.outgoing.length === 0;
}

/**
 * Etapa inicial da instância.
 *
 * É o destino da primeira seta que sai do evento de início — não o evento em
 * si: ninguém trabalha em "Início". Quando o início não leva a lugar nenhum, a
 * própria etapa de início vira a inicial, para que uma instância exista com
 * estado válido em vez de falhar por um desenho incompleto.
 */
export function initialStepId(graph: BpmnGraph): string {
  const startId = graph.startIds[0]
    ?? [...graph.nodes.values()].find((node) => node.incoming.length === 0)?.id
    ?? "";
  if (!startId) return "";
  const [first] = allowedTargets(graph, startId);
  return first || startId;
}

/** Rótulo legível da etapa: o nome do desenho, com o identificador como recurso. */
export function stepLabel(graph: BpmnGraph, stepId: string) {
  const node = graph.nodes.get(stepId);
  return node?.name?.trim() || stepId;
}
