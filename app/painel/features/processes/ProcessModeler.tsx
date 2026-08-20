"use client";
/* eslint-disable @next/next/no-img-element -- o preview BPMN é um SVG em memória gerado pelo bpmn-js. */

import "bpmn-js/dist/assets/diagram-js.css";
import "bpmn-js/dist/assets/bpmn-font/css/bpmn.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Eye, Focus, Maximize2, Redo2, Save, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import type { ProcessArea, ProcessDefinition, ProcessMember, ProcessStepConfig, ProcessVersionDetail } from "./processes.types";
import { ErrorBanner } from "../shared";
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
  return { id:crypto.randomUUID(),bpmnElementId:element.id,stepType,departmentId:"",responsibleUserId:"",responsibilityMode:"DEPARTMENT",slaValue:0,slaUnit:"hours",slaBusinessDays:false,cutoffTime:"",escalation:{},createDemand:false,demandType:"",requesterDepartmentId:"",responsibleDepartmentId:"",demandPriority:"normal",demandSlaValue:0,demandSlaUnit:"hours",checklistId:"",checklistItems:[],formId:"",requiredDocuments:[],optionalDocuments:[],evidenceRequired:false,requiresApproval:false,approverUserId:"",approverDepartmentId:"",approvalCount:1,approvalMode:"sequential",subprocessProcessId:"",settings:{name:element.name,description:"",instructions:"",internalCode:"",dynamicAssignee:"",notificationTemplate:""} };
}
const csv=(value:string)=>value.split(",").map((item)=>item.trim()).filter(Boolean).slice(0,50);

export function ProcessModeler({version,stepConfigs,areas,members,processes,readOnly,saveState,onDiagramChange,onStepConfigsChange,onSaveNow}:{version:ProcessVersionDetail;stepConfigs:ProcessStepConfig[];areas:ProcessArea[];members:ProcessMember[];processes:ProcessDefinition[];readOnly:boolean;saveState:"idle"|"dirty"|"saving"|"saved"|"error";onDiagramChange:(xml:string,svg:string)=>void;onStepConfigsChange:(next:ProcessStepConfig[])=>void;onSaveNow:()=>void}) {
  const canvasRef=useRef<HTMLDivElement>(null); const shellRef=useRef<HTMLDivElement>(null); const instanceRef=useRef<ModelerLike|null>(null); const changeRef=useRef(onDiagramChange);
  const [selected,setSelected]=useState<ElementInfo|null>(null); const [loadError,setLoadError]=useState(""); const [preview,setPreview]=useState<string|null>(null);
  useEffect(()=>{changeRef.current=onDiagramChange;},[onDiagramChange]);
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
        const canvas = instance.get("canvas") as BpmnService & { scroll?: (delta: { dx: number; dy: number }) => void };
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
        await instance.importXML(version.bpmnXml);
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
  }, [readOnly, version.id, version.bpmnXml]);
  const config=useMemo(()=>selected?stepConfigs.find((item)=>item.bpmnElementId===selected.id)??null:null,[selected,stepConfigs]);
  function patch(patchValue:Partial<ProcessStepConfig>){if(!selected||readOnly)return;const current=config??defaultConfig(selected);const next={...current,...patchValue};onStepConfigsChange(config?stepConfigs.map((item)=>item.id===config.id?next:item):[...stepConfigs,next]);}
  function patchSettings(value:Partial<ProcessStepConfig["settings"]>){if(!selected||readOnly)return;const current=config??defaultConfig(selected);patch({settings:{...current.settings,...value}});}
  function rename(name:string){if(!selected||readOnly)return;try{const element=instanceRef.current?.get("elementRegistry")?.get(selected.id);instanceRef.current?.get("modeling")?.updateProperties(element,{name});}catch{}setSelected((value)=>value?{...value,name}:value);patchSettings({name});}
  function invoke(service:string,method:string,...args:unknown[]){const target=instanceRef.current?.get(service);if(typeof target?.[method]==="function")target[method](...args);}
  async function exportBpmn(){const result=await instanceRef.current?.saveXML?.({format:true});const blob=new Blob([result?.xml||version.bpmnXml],{type:"application/xml;charset=utf-8"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`${version.processCode||"processo"}-v${version.versionMajor}.${version.versionMinor}.bpmn`;a.click();URL.revokeObjectURL(url);}
  async function openPreview(){const result=await instanceRef.current?.saveSVG?.();setPreview(result?.svg||version.svgPreview||"");}
  const saveLabel=saveState==="saving"?"Salvando...":saveState==="dirty"?"Alterações não salvas":saveState==="saved"?"Salvo":saveState==="error"?"Falha ao salvar":"Sem alterações";
  return <div className={styles.modelerShell} ref={shellRef}>
    <div className={styles.modelerToolbar}><div><strong>{version.processName}</strong><span>v{version.versionMajor}.{version.versionMinor} · {readOnly?"somente leitura":"rascunho editável"}</span></div><div className={styles.toolActions}>
      {!readOnly&&<button onClick={()=>invoke("commandStack","undo")}><Undo2/>Desfazer</button>}{!readOnly&&<button onClick={()=>invoke("commandStack","redo")}><Redo2/>Refazer</button>}<button onClick={()=>invoke("canvas","zoom","fit-viewport")}><Focus/></button><button onClick={()=>{const c=instanceRef.current?.get("canvas");c?.zoom(Math.min(4,Number(c?.zoom?.()??1)+.15));}}><ZoomIn/></button><button onClick={()=>{const c=instanceRef.current?.get("canvas");c?.zoom(Math.max(.2,Number(c?.zoom?.()??1)-.15));}}><ZoomOut/></button><button onClick={()=>void openPreview()}><Eye/>Preview</button><button onClick={()=>void exportBpmn()}><Download/>BPMN</button><button onClick={()=>void shellRef.current?.requestFullscreen?.()}><Maximize2/></button>{!readOnly&&<button className={styles.primaryButton} onClick={onSaveNow}><Save/>Salvar</button>}
    </div><span className={styles.saveIndicator} data-state={saveState}>{saveLabel}</span></div>
    {loadError&&<ErrorBanner message={loadError}/>}
    <div className={styles.modelerGrid}><section className={styles.canvasPanel}><div ref={canvasRef} className={styles.bpmnCanvas} tabIndex={0}/></section><aside className={styles.propertiesPanel}>
      {!selected?<div className={styles.propertiesEmpty}><WorkflowHint/></div>:<><header className={styles.propertiesHeader}><span>{selected.type.replace("bpmn:","")}</span><strong>{selected.name||selected.id}</strong><small>{selected.id}</small></header><div className={styles.propertySections}>
        <fieldset disabled={readOnly}><legend>Geral</legend><label>Nome<input value={config?.settings.name??selected.name} onChange={(e)=>rename(e.target.value)}/></label><label>Tipo Vinculato<select value={config?.stepType??defaultConfig(selected).stepType} onChange={(e)=>patch({stepType:e.target.value})}>{Object.entries(stepTypeLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>Código interno<input value={config?.settings.internalCode??""} onChange={(e)=>patchSettings({internalCode:e.target.value})}/></label><label>Descrição<textarea rows={3} value={config?.settings.description??""} onChange={(e)=>patchSettings({description:e.target.value})}/></label><label>Instruções<textarea rows={4} value={config?.settings.instructions??""} onChange={(e)=>patchSettings({instructions:e.target.value})}/></label></fieldset>
        <fieldset disabled={readOnly}><legend>Responsabilidade</legend><label>Modo<select value={config?.responsibilityMode??"DEPARTMENT"} onChange={(e)=>patch({responsibilityMode:e.target.value})}><option value="DEPARTMENT">Departamento / Área</option><option value="USER">Usuário específico</option><option value="DEPARTMENT_MANAGER">Gestor do departamento</option><option value="REQUESTER">Solicitante</option><option value="EMPLOYEE_MANAGER">Gestor do colaborador</option><option value="PROCESS_OWNER">Responsável pelo processo</option><option value="DYNAMIC">Responsável dinâmico</option></select></label><label>Departamento / Área<select value={config?.departmentId??""} onChange={(e)=>patch({departmentId:e.target.value})}><option value="">Não definido</option>{areas.map((a)=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>Usuário<select value={config?.responsibleUserId??""} onChange={(e)=>patch({responsibleUserId:e.target.value})}><option value="">Não definido</option>{members.map((m)=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label></fieldset>
        <fieldset disabled={readOnly}><legend>Prazo / SLA</legend><div className={styles.inlineFields}><label>Valor<input type="number" min={0} value={config?.slaValue??0} onChange={(e)=>patch({slaValue:Number(e.target.value)||0})}/></label><label>Unidade<select value={config?.slaUnit??"hours"} onChange={(e)=>patch({slaUnit:e.target.value as ProcessStepConfig["slaUnit"]})}><option value="minutes">Minutos</option><option value="hours">Horas</option><option value="days">Dias</option></select></label></div><label className={styles.checkLabel}><input type="checkbox" checked={config?.slaBusinessDays??false} onChange={(e)=>patch({slaBusinessDays:e.target.checked})}/> Dias úteis</label><label>Horário limite<input type="time" value={config?.cutoffTime??""} onChange={(e)=>patch({cutoffTime:e.target.value})}/></label></fieldset>
        <fieldset disabled={readOnly}><legend>Demanda</legend><label className={styles.checkLabel}><input type="checkbox" checked={config?.createDemand??false} onChange={(e)=>patch({createDemand:e.target.checked})}/> Criar demanda automaticamente</label>{config?.createDemand&&<><label>Tipo<input value={config.demandType} onChange={(e)=>patch({demandType:e.target.value})}/></label><label>Solicitante<select value={config.requesterDepartmentId} onChange={(e)=>patch({requesterDepartmentId:e.target.value})}><option value="">Herdar</option>{areas.map((a)=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>Responsável<select value={config.responsibleDepartmentId} onChange={(e)=>patch({responsibleDepartmentId:e.target.value})}><option value="">Não definido</option>{areas.map((a)=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label></>}</fieldset>
        <fieldset disabled={readOnly}><legend>Checklist / Documentos</legend><label>Checklist<textarea rows={3} value={(config?.checklistItems??[]).join(", ")} onChange={(e)=>patch({checklistItems:csv(e.target.value)})}/></label><label>Documentos obrigatórios<textarea rows={2} value={(config?.requiredDocuments??[]).join(", ")} onChange={(e)=>patch({requiredDocuments:csv(e.target.value)})}/></label><label className={styles.checkLabel}><input type="checkbox" checked={config?.evidenceRequired??false} onChange={(e)=>patch({evidenceRequired:e.target.checked})}/> Evidência obrigatória</label></fieldset>
        <fieldset disabled={readOnly}><legend>Aprovação</legend><label className={styles.checkLabel}><input type="checkbox" checked={config?.requiresApproval??false} onChange={(e)=>patch({requiresApproval:e.target.checked})}/> Exige aprovação</label>{config?.requiresApproval&&<><label>Aprovador<select value={config.approverUserId} onChange={(e)=>patch({approverUserId:e.target.value})}><option value="">Não definido</option>{members.map((m)=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>Área aprovadora<select value={config.approverDepartmentId} onChange={(e)=>patch({approverDepartmentId:e.target.value})}><option value="">Não definida</option>{areas.map((a)=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label></>}</fieldset>
        <fieldset disabled={readOnly}><legend>Subprocesso</legend><label>Processo<select value={config?.subprocessProcessId??""} onChange={(e)=>patch({subprocessProcessId:e.target.value})}><option value="">Nenhum</option>{processes.filter((p)=>p.id!==version.processId&&p.lifecycleStatus==="published").map((p)=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label></fieldset>
      </div></>}
    </aside></div>
    {preview!==null&&<div className={styles.modalBackdrop} onMouseDown={()=>setPreview(null)}><section className={styles.previewModal} role="dialog" aria-modal="true" onMouseDown={(e)=>e.stopPropagation()}><header><strong>Prévia do processo</strong><button onClick={()=>setPreview(null)}>Fechar</button></header>{preview?<img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview)}`} alt={`Prévia de ${version.processName}`}/>:<p>Nenhuma prévia disponível.</p>}</section></div>}
  </div>;
}
function WorkflowHint(){return <><strong>Selecione um elemento do BPMN</strong><p>Configure área, responsável, SLA, demanda, checklist, documentos, aprovação e subprocesso.</p></>;}
