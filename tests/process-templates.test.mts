import assert from "node:assert/strict";
import test from "node:test";
import { BpmnModdle } from "bpmn-moddle";

import {
  findProcessTemplate, processTemplates, templateBpmnXml, templateShape, templateStepConfigs,
} from "../lib/process-templates.ts";
import { processStepTypes, validBpmnXml } from "../lib/process-management.ts";
import { processGroups } from "../lib/process-navigation.ts";

/**
 * §37: as modelagens iniciais precisam abrir.
 *
 * Um template que não é BPMN válido é pior que nenhum: ele passa em revisão de
 * código — é só uma string —, entra no banco na criação do processo e falha na
 * cara de quem abriu o modelador, com uma mensagem do bpmn-js sobre um
 * elemento que ninguém escreveu à mão.
 *
 * Por isso a conferência não é textual. `bpmn-moddle` é o mesmo analisador que
 * o bpmn-js usa por dentro: se ele lê o XML sem aviso, o modelador lê também.
 * A alternativa — casar `<bpmn:startEvent` com expressão regular — provaria
 * que a string contém aquele texto, não que o diagrama existe.
 */

const moddle = new BpmnModdle();

type ModdleElement = {
  $type: string;
  id?: string;
  name?: string;
  flowElements?: ModdleElement[];
  rootElements?: ModdleElement[];
  sourceRef?: ModdleElement;
  targetRef?: ModdleElement;
  diagrams?: Array<{ plane?: { planeElement?: ModdleElement[] } }>;
  bpmnElement?: ModdleElement;
  waypoint?: unknown[];
  bounds?: { x: number; y: number; width: number; height: number };
};

async function parse(xml: string) {
  const { rootElement, warnings } = await moddle.fromXML(xml) as unknown as
    { rootElement: ModdleElement; warnings: unknown[] };
  return { root: rootElement, warnings };
}

for (const template of processTemplates) {
  test(`o template "${template.name}" é BPMN 2.0 que o modelador consegue abrir`, async () => {
    const xml = templateBpmnXml(template);

    // A mesma porta que a API usa antes de gravar. Um template que não passa
    // aqui seria recusado na criação do processo.
    assert.doesNotThrow(() => validBpmnXml(xml));

    const { root, warnings } = await parse(xml);
    assert.deepEqual(warnings, [], "o analisador do bpmn-js reclamou do diagrama");

    const process = root.rootElements?.find((element) => element.$type === "bpmn:Process");
    assert.ok(process, "o XML não declara um processo");
    assert.equal(process.flowElements?.length, template.nodes.length + template.flows.length,
      "todo nó e todo fluxo precisam existir no XML");
  });

  test(`o template "${template.name}" tem início, fim e nenhum nó solto`, async () => {
    const { root } = await parse(templateBpmnXml(template));
    const process = root.rootElements?.find((element) => element.$type === "bpmn:Process");
    assert.ok(process, "o XML não declara um processo");
    const elements = process.flowElements ?? [];

    const starts = elements.filter((element) => element.$type === "bpmn:StartEvent");
    const ends = elements.filter((element) => element.$type === "bpmn:EndEvent");
    assert.equal(starts.length, 1, "um fluxo com dois inícios não diz por onde começar");
    assert.ok(ends.length >= 1, "todo fluxo precisa terminar em algum lugar");

    // Alcançabilidade a partir do início. Um nó desligado do fluxo é o defeito
    // que passa despercebido no desenho: ele aparece no diagrama e nunca
    // executa.
    const flows = elements.filter((element) => element.$type === "bpmn:SequenceFlow");
    const adjacency = new Map<string, string[]>();
    for (const flow of flows) {
      const from = flow.sourceRef?.id ?? "";
      const to = flow.targetRef?.id ?? "";
      assert.ok(from && to, `fluxo ${flow.id} sem origem ou destino resolvidos`);
      adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
    }

    const seen = new Set<string>([starts[0].id!]);
    const queue = [starts[0].id!];
    while (queue.length) {
      for (const next of adjacency.get(queue.shift()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    const soltos = template.nodes.map((node) => node.id).filter((id) => !seen.has(id));
    assert.deepEqual(soltos, [], "nó que o início não alcança aparece no diagrama e nunca executa");

    // E todo fim é alcançado — um ramo de decisão que não termina é o mesmo
    // defeito pelo outro lado.
    for (const end of ends) assert.ok(seen.has(end.id!), `o fim ${end.id} está desligado do fluxo`);
  });

  test(`o template "${template.name}" chega com o diagrama desenhado`, async () => {
    // Sem DI, o bpmn-js desenha tudo colapsado num canto: tecnicamente válido,
    // ilegível na tela. Foi o que motivou o gerador de waypoints.
    const { root } = await parse(templateBpmnXml(template));
    const plane = root.diagrams?.[0]?.plane;
    assert.ok(plane, "o XML não traz diagrama");

    const desenhados = plane.planeElement ?? [];
    const formas = desenhados.filter((element) => element.$type === "bpmndi:BPMNShape");
    const arestas = desenhados.filter((element) => element.$type === "bpmndi:BPMNEdge");
    assert.equal(formas.length, template.nodes.length, "todo nó precisa de forma no diagrama");
    assert.equal(arestas.length, template.flows.length, "toda ligação precisa de aresta no diagrama");

    for (const forma of formas) {
      assert.ok((forma.bounds?.width ?? 0) > 0 && (forma.bounds?.height ?? 0) > 0,
        `forma sem tamanho em ${forma.bpmnElement?.id}`);
    }
    for (const aresta of arestas) {
      assert.ok((aresta.waypoint?.length ?? 0) >= 2,
        `aresta ${aresta.bpmnElement?.id} sem waypoints: o bpmn-js a colapsaria num ponto`);
    }
  });
}

test("os três fluxos da especificação existem, e apontam para processos do menu", () => {
  // §33, §34 e §35 nomeiam os fluxos; o menu (§25) nomeia os processos. Um
  // template apontando para um processo que não existe no menu é uma modelagem
  // órfã: ela abre, mas ninguém a encontra a partir do trabalho.
  const chaves = processTemplates.map((template) => template.key).sort();
  assert.deepEqual(chaves, ["demanda-entre-areas", "entrega-epi", "pagamento-pj"]);

  const grupos = new Set(processGroups.map((group) => group.id));
  for (const template of processTemplates) {
    assert.ok(grupos.has(template.processGroup),
      `${template.key} aponta para o processo "${template.processGroup}", que não existe no menu`);
  }
});

test("cada fluxo tem a decisão que a especificação desenha", () => {
  // As três figuras da especificação têm um losango cada — e a de EPI tem dois
  // fins, porque "sem saldo" não é a mesma coisa que "entregue". Perder isso na
  // transcrição transformaria a modelagem num fluxo reto que não descreve o
  // processo real.
  assert.deepEqual(templateShape(findProcessTemplate("entrega-epi")!), { steps: 6, decisions: 1, ends: 2 });
  assert.deepEqual(templateShape(findProcessTemplate("pagamento-pj")!), { steps: 8, decisions: 1, ends: 1 });
  assert.deepEqual(templateShape(findProcessTemplate("demanda-entre-areas")!), { steps: 4, decisions: 1, ends: 1 });
});

test("a configuração sugerida cobre toda etapa e não inventa responsável", () => {
  for (const template of processTemplates) {
    const steps = templateStepConfigs(template);
    assert.equal(steps.length, template.nodes.length, `${template.key}: etapa sem configuração`);

    for (const step of steps) {
      assert.ok(processStepTypes.includes(step.stepType),
        `${template.key}/${step.bpmnElementId}: tipo "${step.stepType}" não existe no banco`);
      assert.ok(step.settings.name.length > 0, "etapa sem nome");
      // A §38 e a §90 juntas: o template descreve como o processo funciona. Um
      // responsável ou um SLA plausível preenchido aqui é a pior espécie de
      // dado falso — o que parece configurado e não está.
      assert.deepEqual(Object.keys(step.settings).sort(), ["description", "name"],
        "o template não pode trazer responsável, área nem SLA");
    }
  }
});

test("chave desconhecida não vira template silenciosamente", () => {
  // A rota decide entre diagrama mínimo e template por este retorno. Se ele
  // devolvesse o primeiro da lista para uma chave errada, criar um processo em
  // branco entregaria o fluxo de EPI.
  assert.equal(findProcessTemplate("nao-existe"), null);
  assert.equal(findProcessTemplate(""), null);
  assert.equal(findProcessTemplate(undefined), null);
  assert.equal(findProcessTemplate({ key: "entrega-epi" }), null);
  assert.equal(findProcessTemplate("entrega-epi")?.key, "entrega-epi");
});

test("a rota de criação usa o template e grava as etapas dele", async () => {
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../app/api/processes/route.ts", import.meta.url), "utf8");
  assert.match(route, /const template = findProcessTemplate\(body\.templateKey\);/u);
  // Sem template, o comportamento antigo continua valendo — criar um processo
  // em branco não pode passar a entregar um fluxo pronto.
  assert.match(route, /template \? templateBpmnXml\(template\) : defaultBpmnXml\(name, code \|\| processId\)/u);
  assert.match(route, /const stepConfigs = template \? templateStepConfigs\(template\) : \[\];/u);
  assert.match(route, /INSERT INTO fdp_process_step_configs/u);
  // A trilha registra de qual modelagem o processo nasceu.
  assert.match(route, /templateKey: template\?\.key \?\? ""/u);
});
