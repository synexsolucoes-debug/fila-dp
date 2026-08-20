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
test("interface entrega os nove submenus, BPMN, autosave, exportação e propriedades",async()=>{const [view,modeler,app]=await Promise.all([readFile(new URL("../app/painel/features/processes/ProcessManagementView.tsx",import.meta.url),"utf8"),readFile(new URL("../app/painel/features/processes/ProcessModeler.tsx",import.meta.url),"utf8"),readFile(new URL("../app/painel/WorkspaceApp.tsx",import.meta.url),"utf8")]);for(const label of ["Biblioteca de Processos","Modelador de Processos","Meus Processos","Rascunhos","Em Revisão","Publicados","Arquivados","Histórico de Versões","Configurações"])assert.match(view,new RegExp(label,"u"));assert.match(modeler,/bpmn-js\/lib\/Modeler/u);assert.match(modeler,/commandStack\.changed/u);assert.match(modeler,/saveXML/u);assert.match(modeler,/Criar demanda automaticamente/u);assert.match(view,/setTimeout\(\(\)=>\{void save\(\);\},1200\)/u);assert.match(app,/processManagement/u);assert.match(app,/ProcessManagementView/u);});

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