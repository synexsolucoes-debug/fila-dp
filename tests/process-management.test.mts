import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { hasCapability } from "../lib/authorization.ts";
import { defaultBpmnXml, sanitizeProcessStepConfigs, validBpmnXml } from "../lib/process-management.ts";
const migration=await readFile(new URL("../drizzle/postgres/0051_process_management.sql",import.meta.url),"utf8");
test("processo é entidade estruturada com BPMN, empresas, etapas e RLS",()=>{assert.match(migration,/ADD COLUMN "bpmn_xml" text/u);assert.match(migration,/CREATE TABLE "fdp_process_companies"/u);assert.match(migration,/CREATE TABLE "fdp_process_step_configs"/u);assert.match(migration,/FORCE ROW LEVEL SECURITY/u);assert.match(migration,/"department_id" text/u);assert.match(migration,/"create_demand" integer/u);assert.match(migration,/"requires_approval" integer/u);});
test("autosave é otimista e revisão/publicação congelam conteúdo",()=>{assert.match(migration,/fdp_save_process_version_draft/u);assert.match(migration,/p_expected_revision/u);assert.match(migration,/revision=revision\+1/u);assert.match(migration,/OLD.status IN \('in_review','published','retired'\)/u);assert.match(migration,/fdp_process_step_configs_immutable/u);});
test("admissão pode ser modelada como BPMN sem executar admissão oficial",()=>{const xml=defaultBpmnXml("Admissão de Colaborador","ADMISSAO");assert.match(xml,/<bpmn:definitions/u);assert.match(xml,/Admissão de Colaborador/u);assert.doesNotThrow(()=>validBpmnXml(xml));});
test("configuração da etapa é allowlisted",()=>{const [step]=sanitizeProcessStepConfigs([{bpmnElementId:"Activity_1",stepType:"APPROVAL",departmentId:"area-1",slaValue:8,createDemand:true,responsibleDepartmentId:"area-2",requiresApproval:true,approvalCount:2,secret:"drop",settings:{description:"Conferir",hidden:"drop"}}]);assert.equal(step.stepType,"APPROVAL");assert.equal(step.departmentId,"area-1");assert.equal(step.createDemand,true);assert.equal(step.requiresApproval,true);assert.equal(JSON.stringify(step).includes("secret"),false);assert.equal(JSON.stringify(step.settings).includes("hidden"),false);});
test("aliases da especificação usam o RBAC canônico",()=>{assert.equal(hasCapability("admin","process.view"),true);assert.equal(hasCapability("observer","process.view"),true);assert.equal(hasCapability("admin","process.create"),true);assert.equal(hasCapability("member","process.create"),false);assert.equal(hasCapability("admin","process.publish"),true);});
test("APIs validam capability, workspace e auditoria",async()=>{const [list,version,publish]=await Promise.all([readFile(new URL("../app/api/processes/route.ts",import.meta.url),"utf8"),readFile(new URL("../app/api/processes/versions/[id]/route.ts",import.meta.url),"utf8"),readFile(new URL("../app/api/processes/versions/[id]/publish/route.ts",import.meta.url),"utf8")]);assert.match(list,/processes\.read/u);assert.match(list,/workspace\.id/u);assert.match(version,/process\.version_saved/u);assert.match(publish,/process\.version_published/u);});
test("interface entrega as nove seções, BPMN, autosave, exportação e propriedades", async () => {
  const [view, modeler, app] = await Promise.all([
    readFile(new URL("../app/painel/features/processes/ProcessManagementView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/processes/ProcessModeler.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/WorkspaceApp.tsx", import.meta.url), "utf8"),
  ]);

  /* As nove seções, cobradas pelo identificador e não pelo rótulo.
     A versão anterior casava com o texto do botão ("Biblioteca de Processos"),
     e o rótulo é justamente o que muda quando a barra lateral de 220px dentro
     da página vira barra de abas — a §41 pede a segunda. Um teste que reprova
     por encurtar um rótulo reprova por mudança, não por defeito; o
     identificador é o que o resto do código realmente usa. */
  for (const id of ["library", "modeler", "mine", "drafts", "review", "published", "archived", "history", "settings"]) {
    assert.match(view, new RegExp(`id: "${id}", label: "`, "u"), `a seção ${id} sumiu da barra`);
  }
  // E o tipo continua sendo a fonte da lista: uma seção nova sem aba reprova
  // no compilador antes de chegar aqui.
  const types = await readFile(new URL("../app/painel/features/processes/processes.types.ts", import.meta.url), "utf8");
  assert.match(types, /ProcessSection = "library" \| "modeler" \| "mine" \| "drafts" \| "review" \| "published" \| "archived" \| "history" \| "settings"/u);

  assert.match(modeler, /bpmn-js\/lib\/Modeler/u);
  assert.match(modeler, /commandStack\.changed/u);
  assert.match(modeler, /saveXML/u);
  assert.match(modeler, /Criar demanda automaticamente/u);
  assert.match(view, /setTimeout\(\(\) => \{ void save\(\); \}, 1200\)/u);
  assert.match(app, /processManagement/u);
  assert.match(app, /ProcessManagementView/u);
});

test("o recorte de arquivados é uma regra só, e não um `else` pendurado", async () => {
  /* O defeito que a §73 chama de "funcionalidades que não estão funcionando".
     A cadeia era:

       if (section==="mine") …
       if (section==="drafts") …
       if (section==="archived") rows = só arquivados;
       else rows = sem arquivados;

     O `else` liga-se apenas ao último `if`. Para "Rascunhos" e "Em revisão" o
     resultado saía certo por acidente — nenhuma das duas é "archived" —, mas
     bastava alguém inserir um `if` depois para o recorte inverter em silêncio.
     Agora cada seção declara o próprio filtro e os arquivados são uma regra
     explícita, fora do mapa. */
  const view = await readFile(new URL("../app/painel/features/processes/ProcessManagementView.tsx", import.meta.url), "utf8");
  assert.match(view, /const sectionFilters: Partial<Record<ProcessSection,/u);
  assert.match(view, /if \(section === "archived" \? process\.lifecycleStatus !== "archived" : process\.lifecycleStatus === "archived"\) return false;/u);
  assert.doesNotMatch(view, /else\s*rows\s*=/u, "a cadeia de `if` sem chaves não pode voltar");
});

test("criar processo começa pelas modelagens iniciais, e a chave só vale na criação", async () => {
  // §37 e §38: a biblioteca deixa de abrir vazia, e o template descreve o
  // processo sem criar instância. Editar um processo existente não pode
  // reenviar `templateKey` — isso redesenharia o diagrama por baixo de quem já
  // o ajustou.
  const view = await readFile(new URL("../app/painel/features/processes/ProcessManagementView.tsx", import.meta.url), "utf8");
  assert.match(view, /\.\.\.\(existing \? \{\} : \{ templateKey \}\)/u);
  assert.match(view, /processTemplates\.map\(\(template, index\)/u);
  assert.match(view, /onClick=\{\(\) => startFromTemplate\(""\)\}/u, "faltou a opção de começar em branco");
});

test("modelador mantém instância durante autosave e responde ao viewport",async()=>{
  const [modeler,css]=await Promise.all([
    readFile(
      new URL("../app/painel/features/processes/ProcessModeler.tsx",import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/painel/features/processes/processes.module.css",import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(modeler,/bpmn-js\/dist\/assets\/bpmn-js\.css/u);
  assert.match(modeler,/sourceXmlRef/u);
  assert.match(modeler,/fullscreenchange/u);
  assert.match(modeler,/resized/u);
  assert.match(modeler,/toggleFullscreen/u);

  assert.doesNotMatch(
    modeler,
    /\[readOnly,version\.id,version\.bpmnXml\]/u,
    "autosave não pode destruir e recriar o modelador a cada alteração do XML",
  );

  assert.doesNotMatch(
    css,
    /\.workspace svg\{/u,
    "regra genérica de SVG não pode alterar os desenhos internos do bpmn-js",
  );

  assert.match(css,/\.modelerShell:fullscreen/u);
  assert.match(css,/\.bpmnCanvas :global\(\.djs-container\)/u);
});

test("modais portados preservam tokens, controles e prévia acessível", async () => {
  const [view, modeler, css] = await Promise.all([
    readFile(new URL("../app/painel/features/processes/ProcessManagementView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/processes/ProcessModeler.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/painel/features/processes/processes.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(view, /className=\{styles\.processPortal\}/u);
  assert.match(css, /\.processPortal\s*\{[\s\S]*--b: var\(--ui-border\);[\s\S]*--t: var\(--ui-text\);/u);
  assert.match(css, /\.processPortal :is\(input, select, textarea, button\):focus-visible/u);
  assert.match(modeler, /<AnimatedModal open=\{preview!==null\}/u);
  assert.doesNotMatch(modeler, /styles\.(modalBackdrop|previewModal)/u);
});

test("cadastro e abertura entregam ficha operacional e maturidade", async () => {
  const [view, route] = await Promise.all([
    readFile(new URL("../app/painel/features/processes/ProcessManagementView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/processes/[id]/route.ts", import.meta.url), "utf8"),
  ]);
  for (const section of ["Identificação", "Escopo e responsáveis", "Início e publicação", "SLA e prioridade", "Etiquetas e observações"]) {
    assert.match(view, new RegExp(section, "u"));
  }
  assert.match(view, /function ProcessDetail/u);
  assert.match(view, /FICHA OPERACIONAL/u);
  assert.match(view, /className=\{styles\.maturityStrip\}/u);
  assert.match(view, /lifecycleStatus: "restore"/u);
  assert.match(route, /requestedLifecycle === "restore"/u);
  assert.match(route, /process\.restored/u);
});

test("configuração de etapa expõe os campos avançados já persistidos", async () => {
  const modeler = await readFile(new URL("../app/painel/features/processes/ProcessModeler.tsx", import.meta.url), "utf8");
  for (const label of ["Prioridade da demanda", "SLA da demanda", "Documentos opcionais", "Formulário", "Quantidade", "Modo", "Escalonar após", "Regra de atribuição dinâmica", "Modelo de notificação"]) {
    assert.match(modeler, new RegExp(label, "u"), `campo ${label} não foi exposto`);
  }
});

test("edição e ciclo de versões respeitam o escopo de empresa", async () => {
  const [definition, version, review, publish, createVersion, access] = await Promise.all([
    readFile(new URL("../app/api/processes/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/processes/versions/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/processes/versions/[id]/review/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/processes/versions/[id]/publish/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/processes/[id]/versions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/process-access.ts", import.meta.url), "utf8"),
  ]);
  assert.match(definition, /requireProcessCompanyAccess/u);
  assert.match(definition, /definition_id=\?/u, "restauração deve consultar a coluna real da versão");
  assert.doesNotMatch(definition, /fdp_process_versions[^\n]+process_id=\?/u);
  assert.match(version, /await requireScope/u);
  for (const source of [review, publish, createVersion]) assert.match(source, /requireProcessCompanyAccess/u);
  assert.match(access, /fdp_process_companies/u);
  assert.match(access, /COMPANY_ACCESS_REQUIRED/u);
});
