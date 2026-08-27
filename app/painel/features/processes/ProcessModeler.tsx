"use client";
/* eslint-disable @next/next/no-img-element -- o preview BPMN é um SVG em memória gerado pelo bpmn-js. */

import "bpmn-js/dist/assets/bpmn-js.css";
import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Eye, Focus, Maximize2, Redo2, Save, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import type { ProcessArea, ProcessCondition, ProcessDefinition, ProcessMember, ProcessStepConfig, ProcessVersionDetail } from "./processes.types";
import { outgoingFlows, parseBpmnGraph } from "@/lib/bpmn-graph";
import { CONDITION_OPERATORS, FACT_LABELS } from "@/lib/process-conditions";
import { AnimatedModal, ErrorBanner } from "../shared";
import { stepTypeLabel } from "./processes.api";
import styles from "./processes.module.css";

type BpmnElement = { id?: string; type?: string; businessObject?: { name?: string } };
type BpmnEvent = { element?: BpmnElement };
type BpmnService = {
  [key: string]: unknown;
  zoom: (...args: unknown[]) => unknown;
  on: (eventName: string, handler: (event: BpmnEvent) => void) => void;
  get: (id: string) => BpmnElement | undefined;
  updateProperties: (element: BpmnElement | undefined, properties: Record<string, unknown>) => void;
  undo: () => void;
  redo: () => void;
};
type ModelerLike = {
  importXML: (xml: string) => Promise<unknown>;
  saveXML?: (options?: Record<string, unknown>) => Promise<{ xml?: string }>;
  saveSVG?: () => Promise<{ svg?: string }>;
  get: (name: string) => BpmnService;
  destroy: () => void;
};
type ElementInfo = { id:string; type:string; name:string };

function defaultConfig(element:ElementInfo):ProcessStepConfig {
  const stepType = element.type === "bpmn:UserTask" ? "USER_TASK" : element.type === "bpmn:ServiceTask" ? "SYSTEM_TASK" : element.type === "bpmn:SubProcess" ? "SUBPROCESS" : element.type.includes("Gateway") ? "GATEWAY" : element.type === "bpmn:Lane" ? "LANE" : element.type === "bpmn:StartEvent" ? "START_EVENT" : element.type === "bpmn:EndEvent" ? "END_EVENT" : "TASK";
  return { id:crypto.randomUUID(),bpmnElementId:element.id,stepType,departmentId:"",responsibleUserId:"",responsibilityMode:"DEPARTMENT",slaValue:0,slaUnit:"hours",slaBusinessDays:false,cutoffTime:"",escalation:{},createDemand:false,demandType:"",requesterDepartmentId:"",responsibleDepartmentId:"",demandPriority:"normal",demandSlaValue:0,demandSlaUnit:"hours",checklistId:"",checklistItems:[],formId:"",requiredDocuments:[],optionalDocuments:[],evidenceRequired:false,requiresApproval:false,approverUserId:"",approverDepartmentId:"",approvalCount:1,approvalMode:"sequential",subprocessProcessId:"",settings:{name:element.name,description:"",instructions:"",internalCode:"",dynamicAssignee:"",notificationTemplate:"",entryRules:[],exitRules:[],transitions:{},blockingIntegrations:[],documentProof:"declared"} };
}
const csv=(value:string)=>value.split(",").map((item)=>item.trim()).filter(Boolean).slice(0,50);

/* Rótulos dos operadores. O motor mede; aqui só se escolhe — e a lista fechada
   é a mesma dos dois lados, importada de `process-conditions`, para a tela
   nunca oferecer um operador que o servidor descartaria em silêncio. */
const operatorLabel:Record<string,string>={equals:"é",not_equals:"não é",in:"está entre",not_in:"não está entre",is_empty:"está vazio",is_not_empty:"está preenchido",greater_than:"é maior que",less_than:"é menor que"};
const noValueOperators=new Set(["is_empty","is_not_empty"]);

/**
 * Editor de uma lista de condições.
 *
 * Uma linha por condição, e a linha lê como uma frase: campo → operador →
 * valor. Quem configura um processo não é programador; a regra precisa ser
 * legível antes de ser editável.
 *
 * O campo é livre de propósito: os fatos conhecidos entram como sugestão no
 * datalist, e `custom:` alcança qualquer campo personalizado do workspace —
 * enumerá-los aqui exigiria carregá-los no modelador só para preencher um
 * select, e deixaria de fora o campo criado depois.
 */
function ConditionRows({rows,onChange,readOnly,emptyLabel}:{rows:ProcessCondition[];onChange:(next:ProcessCondition[])=>void;readOnly:boolean;emptyLabel:string}){
  const update=(index:number,patch:Partial<ProcessCondition>)=>onChange(rows.map((row,i)=>i===index?{...row,...patch}:row));
  return <div className={styles.conditionRows}>
    {rows.length===0&&<p className={styles.conditionEmpty}>{emptyLabel}</p>}
    {rows.map((row,index)=><div className={styles.conditionRow} key={index}>
      <input aria-label="Campo" list="vinculato-condition-fields" value={row.field} placeholder="Campo" onChange={(e)=>update(index,{field:e.target.value})}/>
      <select aria-label="Operador" value={row.operator} onChange={(e)=>update(index,{operator:e.target.value})}>
        {CONDITION_OPERATORS.map((op)=><option key={op} value={op}>{operatorLabel[op]??op}</option>)}
      </select>
      {/* Operador que não usa valor esconde o campo em vez de desabilitá-lo:
          um campo cinza ao lado de "está vazio" só faz perguntar o que vai ali. */}
      {!noValueOperators.has(row.operator)&&<input aria-label="Valor" value={row.value} placeholder="Valor" onChange={(e)=>update(index,{value:e.target.value})}/>}
      <button type="button" className={styles.conditionRemove} aria-label={`Remover condição ${index+1}`} disabled={readOnly} onClick={()=>onChange(rows.filter((_,i)=>i!==index))}>×</button>
    </div>)}
    <button type="button" className={styles.conditionAdd} disabled={readOnly||rows.length>=12} onClick={()=>onChange([...rows,{field:"",operator:"equals",value:""}])}>Adicionar condição</button>
  </div>;
}

export function ProcessModeler({version,stepConfigs,areas,members,processes,readOnly,saveState,onDiagramChange,onStepConfigsChange,onSaveNow}:{version:ProcessVersionDetail;stepConfigs:ProcessStepConfig[];areas:ProcessArea[];members:ProcessMember[];processes:ProcessDefinition[];readOnly:boolean;saveState:"idle"|"dirty"|"saving"|"saved"|"error";onDiagramChange:(xml:string,svg:string)=>void;onStepConfigsChange:(next:ProcessStepConfig[])=>void;onSaveNow:()=>void}) {
  const canvasRef=useRef<HTMLDivElement>(null); const shellRef=useRef<HTMLDivElement>(null); const instanceRef=useRef<ModelerLike|null>(null); const changeRef=useRef(onDiagramChange); const sourceXmlRef=useRef(version.bpmnXml);
  const [selected,setSelected]=useState<ElementInfo|null>(null); const [loadError,setLoadError]=useState(""); const [preview,setPreview]=useState<string|null>(null);
  useEffect(()=>{changeRef.current=onDiagramChange;},[onDiagramChange]);
  /* O XML de origem fica numa referência, e não nas dependências do efeito que
     monta o modelador.
     Cada gravação do autosave devolve o XML serializado para o estado, e um
     efeito que dependesse dele remontaria o bpmn-js no meio da edição —
     perdendo a seleção, o histórico de desfazer e a posição do canvas a cada
     1,2 segundo de digitação. A remontagem tem que acontecer quando muda a
     *versão*, não quando muda o conteúdo que nós mesmos acabamos de gravar. */
  useEffect(()=>{sourceXmlRef.current=version.bpmnXml;},[version.id,version.bpmnXml]);

  /* Entrar e sair da tela cheia, além do observador de tamanho.
     O `ResizeObserver` mais abaixo cobre a maior parte das mudanças de área,
     mas a transição de tela cheia é a que ele pega pior: o navegador troca a
     caixa e pinta antes de o observador entregar a medida nova, e o diagrama
     fica enquadrado para o tamanho anterior por um quadro. O evento avisa na
     hora certa. */
  useEffect(()=>{
    const resizeCanvas=()=>{
      window.requestAnimationFrame(()=>{
        const canvas=instanceRef.current?.get("canvas") as (BpmnService & { resized?: () => void }) | undefined;
        canvas?.resized?.();
        try { canvas?.zoom("fit-viewport"); } catch { /* instância já destruída */ }
      });
    };
    document.addEventListener("fullscreenchange",resizeCanvas);
    return()=>document.removeEventListener("fullscreenchange",resizeCanvas);
  },[]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let observer: ResizeObserver | null = null;
    const container = canvasRef.current;
    if (!container) return;
    container.innerHTML = "";
    setSelected(null);
    setLoadError("");

    /**
     * Enquadra o diagrama na área visível.
     *
     * Chamar `fit-viewport` logo depois do `importXML` não bastava: o modelador
     * abre dentro de um cartão cuja altura só é definitiva no quadro seguinte,
     * e o bpmn-js media a área ainda em zero. O resultado era o diagrama
     * ancorado no canto superior esquerdo, com quase tudo fora da tela — foi o
     * que a conferência no navegador mostrou: 25 elementos desenhados e nenhum
     * deles à vista.
     *
     * Um quadro de espera resolve a abertura; o observador resolve o resto —
     * recolher a barra lateral, entrar em tela cheia ou mudar a janela também
     * mudam a área, e sem ele o diagrama ficava enquadrado para a medida
     * anterior.
     */
    const fit = (instance: ModelerLike) => {
      if (disposed) return;
      try {
        const canvas = instance.get("canvas") as BpmnService & {
          scroll?: (delta: { dx: number; dy: number }) => void;
          resized?: () => void;
        };
        // `resized()` primeiro: o `fit-viewport` calcula contra a medida que o
        // canvas acredita ter, e sem o aviso ele reenquadra para a anterior.
        canvas.resized?.();
        canvas.zoom("fit-viewport");
        // A paleta flutua sobre a borda esquerda do canvas e cobria o início do
        // fluxo — que é justamente o elemento por onde se lê um BPMN. O
        // enquadramento não conhece a paleta, então o desvio é aplicado depois.
        if (!readOnly) canvas.scroll?.({ dx: 74, dy: 0 });
      } catch { /* instância já destruída */ }
    };

    (async () => {
      try {
        const bpmnModule = readOnly
          ? await import("bpmn-js/lib/NavigatedViewer")
          : await import("bpmn-js/lib/Modeler");
        if (disposed) return;
        const Bpmn = bpmnModule.default as new (options: Record<string, unknown>) => ModelerLike;
        // Sem `keyboard.bindTo`: o bpmn-js liga o teclado sozinho desde a v11 e
        // reclama no console de quem ainda passa o elemento — um erro por
        // abertura do modelador, escondendo os que importam.
        const instance = new Bpmn({ container });
        instanceRef.current = instance;
        await instance.importXML(sourceXmlRef.current);
        if (disposed) return;

        fit(instance);
        window.requestAnimationFrame(() => fit(instance));
        observer = new ResizeObserver(() => fit(instance));
        observer.observe(container);

        const eventBus = instance.get("eventBus");
        eventBus.on("element.click", (event: BpmnEvent) => {
          const element = event.element;
          if (!element?.id || element.type === "label") return;
          setSelected({
            id: String(element.id),
            type: String(element.type || ""),
            name: String(element.businessObject?.name || ""),
          });
        });

        if (!readOnly) {
          eventBus.on("commandStack.changed", () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(async () => {
              try {
                const [{ xml }, { svg }] = await Promise.all([
                  instance.saveXML?.({ format: true }) ?? Promise.resolve({ xml: "" }),
                  instance.saveSVG?.() ?? Promise.resolve({ svg: "" }),
                ]);
                if (!disposed && xml) changeRef.current(xml, svg || "");
              } catch {
                if (!disposed) setLoadError("Não foi possível serializar o diagrama.");
              }
            }, 220);
          });
        }
      } catch (error) {
        if (!disposed) setLoadError(error instanceof Error ? error.message : "Não foi possível carregar o BPMN.");
      }
    })();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      observer?.disconnect();
      instanceRef.current?.destroy();
      instanceRef.current = null;
    };
  }, [readOnly, version.id]);
  const config=useMemo(()=>selected?stepConfigs.find((item)=>item.bpmnElementId===selected.id)??null:null,[selected,stepConfigs]);
  const escalation=config?.escalation??{};
  /* As setas que saem do elemento selecionado, lidas do XML da versão.
     Limitação conhecida e deliberada: uma seta recém-desenhada só aparece aqui
     depois de o diagrama ser salvo. Ler o XML vivo do editor a cada traço
     exigiria serializá-lo em toda alteração — caro, e por uma lista que só é
     consultada quando alguém abre este painel. */
  const outgoing=useMemo(()=>{
    if(!selected)return [] as Array<{id:string;name:string;targetLabel:string}>;
    try{
      const graph=parseBpmnGraph(version.bpmnXml);
      return outgoingFlows(graph,selected.id).map((flow)=>({
        id:flow.id, name:flow.name,
        targetLabel:graph.nodes.get(flow.target)?.name||flow.target,
      }));
    }catch{return [];}
  },[selected,version.bpmnXml]);

  function patch(patchValue:Partial<ProcessStepConfig>){if(!selected||readOnly)return;const current=config??defaultConfig(selected);const next={...current,...patchValue};onStepConfigsChange(config?stepConfigs.map((item)=>item.id===config.id?next:item):[...stepConfigs,next]);}
  function patchSettings(value:Partial<ProcessStepConfig["settings"]>){if(!selected||readOnly)return;const current=config??defaultConfig(selected);patch({settings:{...current.settings,...value}});}
  function rename(name:string){if(!selected||readOnly)return;try{const element=instanceRef.current?.get("elementRegistry")?.get(selected.id);instanceRef.current?.get("modeling")?.updateProperties(element,{name});}catch{}setSelected((value)=>value?{...value,name}:value);patchSettings({name});}
  function invoke(service:string,method:string,...args:unknown[]){const target=instanceRef.current?.get(service);if(typeof target?.[method]==="function")target[method](...args);}
  async function exportBpmn(){const result=await instanceRef.current?.saveXML?.({format:true});const blob=new Blob([result?.xml||version.bpmnXml],{type:"application/xml;charset=utf-8"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`${version.processCode||"processo"}-v${version.versionMajor}.${version.versionMinor}.bpmn`;a.click();URL.revokeObjectURL(url);}
  async function openPreview(){const result=await instanceRef.current?.saveSVG?.();setPreview(result?.svg||version.svgPreview||"");}
  /* Alternar, não só entrar: `requestFullscreen` sozinho deixava o único jeito
     de voltar ser a tecla Esc, que ninguém anuncia. */
  async function toggleFullscreen(){
    const shell=shellRef.current;
    if(!shell)return;
    if(document.fullscreenElement===shell){await document.exitFullscreen();return;}
    await shell.requestFullscreen?.();
  }
  const saveLabel=saveState==="saving"?"Salvando...":saveState==="dirty"?"Alterações não salvas":saveState==="saved"?"Salvo":saveState==="error"?"Falha ao salvar":"Sem alterações";
  return <div className={styles.modelerShell} ref={shellRef}>
    <div className={styles.modelerToolbar}><div><strong>{version.processName}</strong><span>v{version.versionMajor}.{version.versionMinor} · {readOnly?"somente leitura":"rascunho editável"}</span></div><div className={styles.toolActions}>
      {!readOnly&&<button onClick={()=>invoke("commandStack","undo")}><Undo2/>Desfazer</button>}{!readOnly&&<button onClick={()=>invoke("commandStack","redo")}><Redo2/>Refazer</button>}<button onClick={()=>invoke("canvas","zoom","fit-viewport")}><Focus/></button><button onClick={()=>{const c=instanceRef.current?.get("canvas");c?.zoom(Math.min(4,Number(c?.zoom?.()??1)+.15));}}><ZoomIn/></button><button onClick={()=>{const c=instanceRef.current?.get("canvas");c?.zoom(Math.max(.2,Number(c?.zoom?.()??1)-.15));}}><ZoomOut/></button><button onClick={()=>void openPreview()}><Eye/>Preview</button><button onClick={()=>void exportBpmn()}><Download/>BPMN</button><button onClick={()=>void toggleFullscreen()} aria-label="Alternar tela cheia"><Maximize2/></button>{!readOnly&&<button className={styles.primaryButton} onClick={onSaveNow}><Save/>Salvar</button>}
    </div><span className={styles.saveIndicator} data-state={saveState}>{saveLabel}</span></div>
    {loadError&&<ErrorBanner message={loadError}/>}
    <div className={styles.modelerGrid}><section className={styles.canvasPanel}><div ref={canvasRef} className={styles.bpmnCanvas} tabIndex={0}/></section><aside className={styles.propertiesPanel}>
      {!selected?<div className={styles.propertiesEmpty}><WorkflowHint/></div>:<><header className={styles.propertiesHeader}><span>{selected.type.replace("bpmn:","")}</span><strong>{selected.name||selected.id}</strong><small>{selected.id}</small></header><div className={styles.propertySections}>
        <fieldset disabled={readOnly}><legend>Geral</legend><label>Nome<input value={config?.settings.name??selected.name} onChange={(e)=>rename(e.target.value)}/></label><label>Tipo Vinculato<select value={config?.stepType??defaultConfig(selected).stepType} onChange={(e)=>patch({stepType:e.target.value})}>{Object.entries(stepTypeLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>Código interno<input value={config?.settings.internalCode??""} onChange={(e)=>patchSettings({internalCode:e.target.value})}/></label><label>Descrição<textarea rows={3} value={config?.settings.description??""} onChange={(e)=>patchSettings({description:e.target.value})}/></label><label>Instruções<textarea rows={4} value={config?.settings.instructions??""} onChange={(e)=>patchSettings({instructions:e.target.value})}/></label></fieldset>
        <fieldset disabled={readOnly}><legend>Responsabilidade</legend><label>Modo<select value={config?.responsibilityMode??"DEPARTMENT"} onChange={(e)=>patch({responsibilityMode:e.target.value})}><option value="DEPARTMENT">Departamento / Área</option><option value="USER">Usuário específico</option><option value="DEPARTMENT_MANAGER">Gestor do departamento</option><option value="REQUESTER">Solicitante</option><option value="EMPLOYEE_MANAGER">Gestor do colaborador</option><option value="PROCESS_OWNER">Responsável pelo processo</option><option value="DYNAMIC">Responsável dinâmico</option></select></label><label>Departamento / Área<select value={config?.departmentId??""} onChange={(e)=>patch({departmentId:e.target.value})}><option value="">Não definido</option>{areas.map((a)=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>Usuário<select value={config?.responsibleUserId??""} onChange={(e)=>patch({responsibleUserId:e.target.value})}><option value="">Não definido</option>{members.map((m)=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>{config?.responsibilityMode==="DYNAMIC"&&<label>Regra de atribuição dinâmica<input value={config.settings.dynamicAssignee} placeholder="Ex.: gestor do solicitante" onChange={(e)=>patchSettings({dynamicAssignee:e.target.value})}/></label>}</fieldset>
        <fieldset disabled={readOnly}><legend>Prazo / SLA</legend><div className={styles.inlineFields}><label>Valor<input type="number" min={0} value={config?.slaValue??0} onChange={(e)=>patch({slaValue:Number(e.target.value)||0})}/></label><label>Unidade<select value={config?.slaUnit??"hours"} onChange={(e)=>patch({slaUnit:e.target.value as ProcessStepConfig["slaUnit"]})}><option value="minutes">Minutos</option><option value="hours">Horas</option><option value="days">Dias</option></select></label></div><label className={styles.checkLabel}><input type="checkbox" checked={config?.slaBusinessDays??false} onChange={(e)=>patch({slaBusinessDays:e.target.checked})}/> Contar somente dias úteis</label><label>Horário limite<input type="time" value={config?.cutoffTime??""} onChange={(e)=>patch({cutoffTime:e.target.value})}/></label><div className={styles.inlineFields}><label>Escalonar após<input type="number" min={0} value={Number(escalation.afterValue??0)} onChange={(e)=>patch({escalation:{...escalation,afterValue:Number(e.target.value)||0}})}/></label><label>Notificar<select value={Boolean(escalation.notifyDepartmentManager)?"manager":Boolean(escalation.notifyOwner)?"owner":"none"} onChange={(e)=>patch({escalation:{...escalation,notifyOwner:e.target.value==="owner",notifyDepartmentManager:e.target.value==="manager"}})}><option value="none">Não notificar</option><option value="owner">Dono do processo</option><option value="manager">Gestor da área</option></select></label></div></fieldset>
        <fieldset disabled={readOnly}><legend>Demanda</legend><label className={styles.checkLabel}><input type="checkbox" checked={config?.createDemand??false} onChange={(e)=>patch({createDemand:e.target.checked})}/> Criar demanda automaticamente</label>{config?.createDemand&&<><label>Tipo de demanda<input value={config.demandType} onChange={(e)=>patch({demandType:e.target.value})}/></label><label>Área solicitante<select value={config.requesterDepartmentId} onChange={(e)=>patch({requesterDepartmentId:e.target.value})}><option value="">Herdar do processo</option>{areas.map((a)=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>Área responsável<select value={config.responsibleDepartmentId} onChange={(e)=>patch({responsibleDepartmentId:e.target.value})}><option value="">Não definida</option>{areas.map((a)=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>Prioridade da demanda<select value={config.demandPriority} onChange={(e)=>patch({demandPriority:e.target.value as ProcessStepConfig["demandPriority"]})}><option value="low">Baixa</option><option value="normal">Normal</option><option value="high">Alta</option><option value="urgent">Urgente</option></select></label><div className={styles.inlineFields}><label>SLA da demanda<input type="number" min={0} value={config.demandSlaValue} onChange={(e)=>patch({demandSlaValue:Number(e.target.value)||0})}/></label><label>Unidade<select value={config.demandSlaUnit} onChange={(e)=>patch({demandSlaUnit:e.target.value as ProcessStepConfig["demandSlaUnit"]})}><option value="minutes">Minutos</option><option value="hours">Horas</option><option value="days">Dias</option></select></label></div></>}</fieldset>
        <fieldset disabled={readOnly}><legend>Checklist / Documentos</legend><label>Modelo de checklist<input value={config?.checklistId??""} onChange={(e)=>patch({checklistId:e.target.value})}/></label><label>Itens do checklist<textarea rows={3} value={(config?.checklistItems??[]).join(", ")} placeholder="Separe os itens por vírgula" onChange={(e)=>patch({checklistItems:csv(e.target.value)})}/></label><label>Formulário<input value={config?.formId??""} placeholder="Código ou identificador do formulário" onChange={(e)=>patch({formId:e.target.value})}/></label><label>Documentos obrigatórios<textarea rows={2} value={(config?.requiredDocuments??[]).join(", ")} onChange={(e)=>patch({requiredDocuments:csv(e.target.value)})}/></label><label>Documentos opcionais<textarea rows={2} value={(config?.optionalDocuments??[]).join(", ")} onChange={(e)=>patch({optionalDocuments:csv(e.target.value)})}/></label><label>Como conferir os obrigatórios<select value={config?.settings.documentProof??"declared"} onChange={(e)=>patchSettings({documentProof:e.target.value as ProcessStepConfig["settings"]["documentProof"]})}><option value="declared">Marcar no checklist basta</option><option value="attached">Exigir um anexo por documento</option></select><small className={styles.fieldsetHint}>Com anexo por documento, a etapa só avança quando o nome do arquivo traz as palavras do documento — “Comprovante de residência” é atendido por <code>comprovante-residencia.pdf</code>. Demandas já abertas seguem a versão que instanciaram.</small></label><label className={styles.checkLabel}><input type="checkbox" checked={config?.evidenceRequired??false} onChange={(e)=>patch({evidenceRequired:e.target.checked})}/> Evidência obrigatória para concluir</label></fieldset>
        <fieldset disabled={readOnly}><legend>Aprovação</legend><label className={styles.checkLabel}><input type="checkbox" checked={config?.requiresApproval??false} onChange={(e)=>patch({requiresApproval:e.target.checked})}/> Exige aprovação</label>{config?.requiresApproval&&<><label>Aprovador<select value={config.approverUserId} onChange={(e)=>patch({approverUserId:e.target.value})}><option value="">Não definido</option>{members.map((m)=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>Área aprovadora<select value={config.approverDepartmentId} onChange={(e)=>patch({approverDepartmentId:e.target.value})}><option value="">Não definida</option>{areas.map((a)=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><div className={styles.inlineFields}><label>Quantidade<input type="number" min={1} max={20} value={config.approvalCount} onChange={(e)=>patch({approvalCount:Number(e.target.value)||1})}/></label><label>Modo<select value={config.approvalMode} onChange={(e)=>patch({approvalMode:e.target.value as ProcessStepConfig["approvalMode"]})}><option value="sequential">Sequencial</option><option value="parallel">Paralelo</option></select></label></div></>}</fieldset>
        {/* Sugestões de campo, uma vez para os três editores. `custom:` alcança
            qualquer campo personalizado — enumerá-los aqui deixaria de fora o
            que for criado depois. */}
        <datalist id="vinculato-condition-fields">{Object.entries(FACT_LABELS).map(([field,label])=><option key={field} value={field}>{label}</option>)}<option value="custom:">Campo personalizado — complete após os dois-pontos</option></datalist>
        <fieldset disabled={readOnly}><legend>Regras da etapa</legend>
          <p className={styles.fieldsetHint}>Medidas contra os dados da demanda. Uma demanda que não atende à regra não avança, e o motivo aparece para quem tentou.</p>
          <span className={styles.conditionGroupLabel}>Para concluir esta etapa</span>
          <ConditionRows readOnly={readOnly} rows={config?.settings.exitRules??[]} emptyLabel="Sem regra: a etapa conclui assim que os requisitos acima forem atendidos."
            onChange={(next)=>patchSettings({exitRules:next})}/>
          <span className={styles.conditionGroupLabel}>Para a demanda entrar nesta etapa</span>
          <ConditionRows readOnly={readOnly} rows={config?.settings.entryRules??[]} emptyLabel="Sem regra: qualquer demanda que o desenho permitir entra aqui."
            onChange={(next)=>patchSettings({entryRules:next})}/>
        </fieldset>
        {outgoing.length>0&&<fieldset disabled={readOnly}><legend>Condição de cada saída</legend>
          <p className={styles.fieldsetHint}>Quando esta etapa tem mais de um caminho, a condição decide qual vale. Saída sem condição continua sempre aberta.</p>
          {outgoing.map((flow)=><div className={styles.conditionFlow} key={flow.id}>
            <span className={styles.conditionFlowHead}>{flow.name||"Sem rótulo"} <em>→ {flow.targetLabel}</em></span>
            <ConditionRows readOnly={readOnly} rows={config?.settings.transitions?.[flow.id]??[]} emptyLabel="Caminho sempre disponível."
              onChange={(next)=>patchSettings({transitions:{...(config?.settings.transitions??{}),[flow.id]:next}})}/>
          </div>)}
        </fieldset>}
        <fieldset disabled={readOnly}><legend>Dependência de integração</legend>
          <p className={styles.fieldsetHint}>Canais que precisam estar sãos para esta etapa concluir. Com o canal em erro, a etapa trava — em vez de dar por feito um trabalho que não chegou do outro lado.</p>
          <label>Canais<input value={(config?.settings.blockingIntegrations??[]).join(", ")} placeholder="Ex.: sankhya, solides" onChange={(e)=>patchSettings({blockingIntegrations:csv(e.target.value).map((item)=>item.toLowerCase())})}/></label>
        </fieldset>
        <fieldset disabled={readOnly}><legend>Comunicação</legend><label>Modelo de notificação<textarea rows={3} value={config?.settings.notificationTemplate??""} placeholder="Mensagem enviada quando a etapa for atribuída" onChange={(e)=>patchSettings({notificationTemplate:e.target.value})}/></label></fieldset>
        <fieldset disabled={readOnly}><legend>Subprocesso</legend><label>Processo<select value={config?.subprocessProcessId??""} onChange={(e)=>patch({subprocessProcessId:e.target.value})}><option value="">Nenhum</option>{processes.filter((p)=>p.id!==version.processId&&p.lifecycleStatus==="published").map((p)=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label></fieldset>
      </div></>}
    </aside></div>
    <AnimatedModal open={preview!==null} onClose={()=>setPreview(null)} label={`Prévia de ${version.processName}`} width={960} className={styles.processPortal}>
      <div className={styles.dialogHeader}><div><span className={styles.eyebrow}>DIAGRAMA BPMN</span><strong>Prévia do processo</strong></div><button type="button" onClick={()=>setPreview(null)}>Fechar</button></div>
      <div className={styles.previewBody}>{preview?<img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview)}`} alt={`Prévia de ${version.processName}`}/>:<p>Nenhuma prévia disponível.</p>}</div>
    </AnimatedModal>
  </div>;
}
function WorkflowHint(){return <><strong>Selecione um elemento do BPMN</strong><p>Configure área, responsável, SLA, demanda, checklist, documentos, aprovação e subprocesso.</p></>;}
