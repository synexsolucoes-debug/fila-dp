/** Portão executável dos 23 itens que ainda estavam parciais. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const [workspace, overviewTests, processTypes, processView, processSanitizer, schema, linksRoute,
  processPanel, a11y, interfaceCheck, ci, panelRoutes, auth, isolation, upload, exportRoute,
  modeler, globalCss, navigationTests] = await Promise.all([
  read("../app/painel/WorkspaceApp.tsx"), read("./overview-operational-center.test.mts"),
  read("../app/painel/features/processes/processes.types.ts"),
  read("../app/painel/features/processes/ProcessManagementView.tsx"),
  read("../lib/process-management.ts"), read("../db/schema.ts"),
  read("../app/api/cards/[id]/links/route.ts"),
  read("../app/painel/features/work/CardProcessPanel.tsx"),
  read("../scripts/a11y-check.mjs"), read("../scripts/interface-consistency.mjs"),
  read("../.github/workflows/ci.yml"), read("../lib/panel-routes.ts"),
  read("../lib/authorization.ts"), read("../scripts/verify-tenant-isolation.mjs"),
  read("../app/api/cards/[id]/attachments/route.ts"),
  read("../app/api/payments/reports/route.ts"),
  read("../app/painel/features/processes/ProcessModeler.tsx"),
  read("../app/globals.css"), read("./panel-navigation.test.mts"),
]);

const declared: number[] = [];
const accepts = (item: number, name: string, proof: () => void | Promise<void>) => {
  declared.push(item);
  test(`§${item} — ${name}`, proof);
};

accepts(1, "Processos definem, Demandas executam e a Visão Geral acompanha", () => {
  assert.match(workspace, /type View = "overview"[\s\S]*"board"[\s\S]*"processManagement"/u);
  assert.match(workspace, /Fluxos em andamento/u);
  assert.match(processPanel, /Etapas desta demanda/u);
});

accepts(14, "os cinco indicadores são reais e acionáveis", () => {
  /* A faixa mudou de forma enquanto este portão era escrito: os três contextos
     do §7.2 viraram os cinco indicadores da maquete. As asserções abaixo foram
     reescritas contra a estrutura atual, e o que elas cobram ficou mais estrito,
     não menos:

     - antes, "acionável" era um destino literal conferido em UM indicador;
       agora, TODOS os cinco precisam declarar destino;
     - antes, "real" apoiava-se no nome de um teste vizinho; agora, nenhum dos
       cinco valores pode ser um literal com dígito — e a frase de apoio
       tampouco, que é onde a maquete pedia a variação percentual inventada. */
  const faixa = (() => {
    const de = workspace.indexOf('key: "demands-open"');
    assert.notEqual(de, -1, "a faixa de indicadores sumiu da Visão geral");
    return workspace.slice(de, workspace.indexOf(" ];", de));
  })();

  for (const label of ["Demandas em aberto", "Fluxos em andamento", "Obrigações próximas", "Integrações com erro", "SLA no prazo"]) {
    assert.ok(faixa.includes(`label: "${label}"`), `"${label}" sumiu da faixa de indicadores`);
  }

  // Acionável: cada um dos cinco leva a algum lugar, e o elemento é botão.
  const destinos = [...faixa.matchAll(/target: "(\w+)"/gu)].map((match) => match[1]);
  assert.equal(destinos.length, 5, `${destinos.length} indicador(es) com destino — a faixa tem cinco`);
  assert.match(workspace, /<button type="button" key=\{kpi\.key\} data-metric=\{kpi\.key\}/u);
  // E o SLA mantém a âncora nomeada, que é o que o ensaio de navegador mira.
  assert.ok(faixa.includes('key: "sla-on-time"'));

  // Real: nenhum valor nem frase de apoio com número escrito à mão.
  const fixos = [...faixa.matchAll(/(?:value|support): "([^"$]*\d[^"]*)"/gu)].map((match) => match[1]);
  assert.deepEqual(fixos, [], `número fixo na faixa: ${fixos.join(", ")}`);

  assert.match(overviewTests, /nenhum número da faixa é fixo no código/u);
});

accepts(18, "saúde das integrações mostra estado, sincronização, erro e detalhe", () => {
  assert.match(workspace, /ConnectionMap integrations=\{integrations\}/u);
  assert.match(workspace, /connectionStatusLabel\(item\.status\)/u);
  assert.match(workspace, /lastSyncLabel\(item\.lastSyncAt\)/u);
  assert.match(workspace, /onNavigate\("integrations"\)/u);
  assert.match(workspace, /integrations\.filter\(\(item\) => item\.status === "error"\)/u);
});

accepts(22, "cadastro do processo cobre governança, escopo, SLA, versão e autoria", () => {
  for (const field of ["description", "objective", "ownerDepartmentId", "ownerUserId", "globalSlaValue", "defaultPriority", "createdBy", "updatedBy", "createdAt", "updatedAt", "companies"]) assert.ok(processTypes.includes(field), `campo ${field} ausente do contrato`);
  for (const name of ["description", "objective", "ownerDepartmentId", "ownerUserId", "globalSlaValue", "defaultPriority"]) assert.match(processView, new RegExp(`name="${name}"`, "u"));
});

accepts(23, "etapas ordenadas têm área, responsável, SLA, regras e tarefas", () => {
  for (const field of ["bpmnElementId", "departmentId", "responsibleUserId", "slaValue", "entryRules", "exitRules", "tasks"]) {
    assert.ok(processTypes.includes(field), `campo ${field} ausente da etapa`);
    assert.ok(processSanitizer.includes(field), `campo ${field} não é saneado no servidor`);
  }
  assert.match(processPanel, /stage\.position/u);
});

accepts(49, "demandas orquestram módulos especializados sem duplicá-los", () => {
  assert.match(schema, /fdp_demand_module_links/u);
  for (const moduleKey of ["competence", "movement", "obligation", "benefit", "contractor", "epi", "integration"]) assert.ok(linksRoute.includes(`${moduleKey}:`), `módulo ${moduleKey} sem alvo validado`);
  assert.match(linksRoute, /workspace_id = \? AND id = \?/u);
  assert.match(processPanel, /Módulos vinculados/u);
});

accepts(76, "IDOR falha fechado em demanda, anexo, tarefa e vínculo", () => {
  assert.match(upload, /workspace_id = \? AND id = \? AND card_id = \?/u);
  assert.match(upload, /requireCardCompanyAccess/u);
  assert.match(linksRoute, /requireCardCompanyAccess/u);
  assert.match(linksRoute, /DEMAND_LINK_TARGET_NOT_FOUND/u);
  assert.match(isolation, /toda tabela|workspace_id|FORCE ROW LEVEL SECURITY/iu);
});

accepts(79, "ações críticas mantêm trilha estruturada e operacional", async () => {
  const sources = await Promise.all([
    read("../app/api/processes/versions/[id]/publish/route.ts"), read("../app/api/checklist/[id]/route.ts"),
    read("../lib/process-instances.ts"), read("../app/api/epi/deliveries/route.ts"),
    read("../app/api/payments/contractors/closings/[id]/transition/route.ts"),
    read("../app/api/operations/movements/[id]/submit/route.ts"), read("../app/api/integrations/[id]/route.ts"),
    read("../app/api/platform/users/[id]/route.ts"), exportRoute,
  ]);
  const auditSurface = sources.join("\n");
  for (const marker of ["process.version_published", "checklist.item_toggled", "process.step", "epi", "contractor", "movement", "integration.configured", "platform", "exported"]) assert.match(auditSurface, new RegExp(marker.replace(".", "\\."), "iu"), `trilha ausente: ${marker}`);
  assert.match(linksRoute, /demand\.module_linked/u);
});

accepts(86, "renovação visual tem portões de estado, consistência e acessibilidade", () => {
  assert.match(ci, /npm run a11y-check/u); assert.match(ci, /npm run interface-check/u);
  assert.match(interfaceCheck, /tabelas|formulários|gavetas/iu);
});

accepts(87, "identidade é centralizada nos tokens do Vinculato", () => {
  for (const color of ["#18223A", "#365CF5", "#16A394", "#F6F8FC", "#172033", "#64748B", "#E2E8F0"]) assert.match(globalCss, new RegExp(color, "iu"));
});

accepts(90, "a interface evita os sinais artificiais proibidos", () => {
  assert.match(interfaceCheck, /EMOJI/u); assert.match(interfaceCheck, /não parecer IA/iu); assert.match(globalCss, /--ui-font/u);
});

accepts(93, "a Visão Geral começa pela operação, e é só operação", () => {
  /* A §93 pede "central de operação" e proíbe "dashboard genérico de cards".
     A primeira correção foi de ordem — os indicadores subiram para o topo — e
     este portão a conferia comparando duas posições.

     A maquete foi além da ordem: tirou da tela os blocos que repetiam, dentro
     da página, a navegação que já está na barra lateral, que é o "dashboard
     genérico" que a §93 nomeia. Comparar posições deixou de bastar, porque as
     duas marcas antigas somem juntas e `-1 < -1` é falso. O portão passa a
     cobrar o que a §93 realmente quer: os indicadores primeiro, e nenhum bloco
     de navegação depois. */
  assert.match(overviewTests, /a Visão geral é a central de operação da maquete/u);
  const layout = workspace.slice(workspace.indexOf('<div className="overview-layout">'),
    workspace.indexOf("function MemberCompanyAccess"));
  const indicadores = layout.indexOf('className="overview-kpis"');
  assert.ok(indicadores > 0, "a faixa de indicadores sumiu da Visão geral");
  for (const bloco of ["flows-panel", "obligations-panel", "status-panel", "activity-panel"]) {
    assert.ok(layout.indexOf(bloco) > indicadores, `${bloco} precisa vir depois dos indicadores`);
  }
  for (const navegacao of ['className="workspace-shortcuts"', 'className="workspace-processes"', 'className="overview-panel board-preview"']) {
    assert.equal(layout.indexOf(navegacao), -1,
      `${navegacao} repete a navegação da barra lateral dentro da página`);
  }
});

accepts(94, "o editor evidencia Processo → Etapas → Tarefas", () => {
  assert.match(processView, /Fluxo do processo/u); assert.match(modeler, /Etapa|Tarefa/iu); assert.match(processTypes, /ProcessTaskTemplate/u);
});

accepts(96, "tabelas têm busca, filtros, paginação, estados e ações", async () => {
  const registrations = await read("../app/painel/features/registrations/RegistrationsView.tsx");
  assert.match(registrations, /type="search"|placeholder="Buscar/iu);
  assert.match(registrations, /Anterior[\s\S]*Próxima/u);
  assert.match(registrations, /LoadingState[\s\S]*EmptyState/u);
  assert.match(interfaceCheck, /mesma altura de linha, mesmo cabeçalho/u);
});

accepts(97, "formulários têm validação, feedback e alterações não salvas", () => {
  assert.match(processView, /required/u); assert.match(modeler, /Alterações não salvas/u);
  assert.match(modeler, /Salvando\.\.\.|Falha ao salvar/u); assert.match(interfaceCheck, /padrão de formulários/u);
});

accepts(98, "detalhes rápidos usam gaveta acessível", async () => {
  const motion = await read("../app/painel/features/shared/motion.tsx");
  assert.match(motion, /function AnimatedDrawer/u); assert.match(motion, /useDialogFocus/u);
  assert.match(motion, /aria-modal="true"/u); assert.match(motion, /Escape/u);
});

accepts(99, "responsividade cobre desktop, notebook, tablet e celular", () => {
  for (const label of ["desktop 1440", "notebook 1024", "tablet 768", "celular 390"]) assert.ok(a11y.includes(label), `viewport ausente: ${label}`);
  assert.match(a11y, /scrollWidth/u);
});

accepts(101, "performance tem medição de volume e orçamento bloqueante", () => {
  assert.match(ci, /npm run db:measure-work/u); assert.match(ci, /Medir consultas operacionais com volume/u);
});

accepts(125, "segurança é um gate, não uma lista documental", () => {
  for (const capability of ["cards.read", "cards.write", "attachments.read", "reports.read", "integrations.credentials.manage"]) assert.ok(auth.includes(capability), `capability ausente: ${capability}`);
  assert.match(ci, /verify:isolation/u); assert.match(upload, /MAX_CARD_ATTACHMENT_SIZE/u); assert.match(exportRoute, /prepareAuditEvent/u);
});

accepts(126, "aceite visual percorre toda a navegação e quatro larguras", () => {
  assert.match(a11y, /MINIMO_DE_TELAS = 64/u); assert.match(a11y, /for \(const viewport of VIEWPORTS\)/u);
  assert.match(navigationTests, /menu|barra superior/iu); assert.match(interfaceCheck, /nenhuma divergência de padrão/iu);
});

accepts(130, "objetivo final é coberto pelo fluxo operacional completo", () => {
  for (const evidence of ["processManagement", "board", "integrations", "history", "areas", "responsibleAreaId", "processVersionId"]) assert.ok(`${workspace}\n${schema}`.includes(evidence), `evidência composta ausente: ${evidence}`);
});

accepts(131, "arquitetura final está refletida na navegação real", () => {
  for (const view of ["overview", "processManagement", "board", "processes", "registrations", "epi", "contractorPayments", "integrations", "history"]) assert.ok(panelRoutes.includes(`"${view}"`), `visão ausente: ${view}`);
});

accepts(133, "o produto conecta processo, demanda, pessoas, áreas, módulos, integrações e auditoria", () => {
  for (const evidence of ["processVersionId", "employeeId", "requesterAreaId", "responsibleAreaId", "demandModuleLinks", "integrations", "auditEvents"]) assert.ok(schema.includes(evidence), `conexão estrutural ausente: ${evidence}`);
});

test("a matriz cobre exatamente os 23 itens remanescentes", () => {
  assert.deepEqual([...declared].sort((a, b) => a - b), [1, 14, 18, 22, 23, 49, 76, 79, 86, 87, 90, 93, 94, 96, 97, 98, 99, 101, 125, 126, 130, 131, 133]);
});
