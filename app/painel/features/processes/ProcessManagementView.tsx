"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Archive, BookOpenCheck, CheckCircle2, Clock3, FilePenLine, FolderArchive, History,
  LayoutTemplate, Plus, Search, Settings2, ShieldCheck, SlidersHorizontal, UserRound, Workflow, X,
} from "lucide-react";
import type { WorkspaceRole } from "@/lib/fila-dp-types";
import { processTemplates, templateShape } from "@/lib/process-templates";
import {
  AnimatedDrawer, AnimatedModal, AnimatedTabs, EmptyState, ErrorBanner, FadeIn, LoadingState,
  MotionCard, StaggerContainer, StaggerItem, StatusPill, type AnimatedTab,
} from "../shared";
import { ProcessModeler } from "./ProcessModeler";
import { processRequest, processStatusLabel, processVersionLabel } from "./processes.api";
import type {
  ProcessCatalogPayload, ProcessDefinition, ProcessOptions, ProcessSection,
  ProcessStepConfig, ProcessVersionDetail, ProcessVersionSummary,
} from "./processes.types";
import styles from "./processes.module.css";

/**
 * Gestão e modelagem de processos (§31 a §40, §73).
 *
 * O que mudou de comportamento, além do desenho:
 *
 *  - **A biblioteca deixa de abrir vazia.** A §37 pede modelagens iniciais para
 *    os processos que o produto já conhece, e criar um processo agora começa
 *    pela galeria delas. O que o template escreve é um rascunho de diagrama e
 *    o tipo de cada etapa — nada de instância, competência ou pagamento, que é
 *    a linha da §38.
 *
 *  - **O filtro de "Arquivados" funcionava pela metade.** A cadeia era
 *    `if (mine) … if (drafts) … if (archived) … else …`, e o `else` só se
 *    ligava ao último `if`: escolher "Meus processos" aplicava o recorte de
 *    dono e, por não ser "archived", aplicava também o "esconda os
 *    arquivados" — o que estava certo — mas "Rascunhos" e "Em revisão"
 *    passavam pelo mesmo caminho por acidente, não por desenho. Agora cada
 *    seção declara o próprio recorte e a exclusão dos arquivados é uma regra
 *    só, explícita.
 *
 *  - **A navegação de seção era uma barra lateral de 220px dentro da página**,
 *    um terceiro nível de menu que nenhuma outra tela tem. Virou a mesma barra
 *    de abas do cabeçalho de processo (§41).
 */

const sectionTabs: ReadonlyArray<AnimatedTab<ProcessSection>> = [
  { id: "library", label: "Biblioteca", icon: BookOpenCheck },
  { id: "modeler", label: "Modelador", icon: Workflow },
  { id: "mine", label: "Meus processos", icon: UserRound },
  { id: "drafts", label: "Rascunhos", icon: FilePenLine },
  { id: "review", label: "Em revisão", icon: Clock3 },
  { id: "published", label: "Publicados", icon: CheckCircle2 },
  { id: "archived", label: "Arquivados", icon: FolderArchive },
  { id: "history", label: "Versões", icon: History },
  { id: "settings", label: "Configurações", icon: Settings2 },
];

/**
 * Recorte de cada seção, declarado uma vez.
 *
 * `archived` é a única que mostra arquivados; todas as outras os escondem, e
 * isso é aplicado fora do mapa, para não depender de cada entrada lembrar.
 */
const sectionFilters: Partial<Record<ProcessSection, (process: ProcessDefinition, currentUserId: string) => boolean>> = {
  mine: (process, currentUserId) => process.ownerUserId === currentUserId,
  drafts: (process) => process.currentVersion?.status === "draft",
  review: (process) => process.currentVersion?.status === "in_review",
  published: (process) => process.lifecycleStatus === "published",
  archived: (process) => process.lifecycleStatus === "archived",
};

const formatMoment = (value: string) =>
  value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";

const field = (data: FormData, name: string) => String(data.get(name) ?? "").trim();

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";
/** `undefined` = nenhum diálogo; `null` = criar; objeto = editar. */
type DialogTarget = ProcessDefinition | null | undefined;

export function ProcessManagementView({ role }: { role: WorkspaceRole }) {
  const [section, setSection] = useState<ProcessSection>("library");
  const [catalog, setCatalog] = useState<ProcessCatalogPayload | null>(null);
  const [options, setOptions] = useState<ProcessOptions>({ currentUserId: "", areas: [], members: [], companies: [] });

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [area, setArea] = useState("");
  const [company, setCompany] = useState("");
  const [owner, setOwner] = useState("");
  const [category, setCategory] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [dialog, setDialog] = useState<DialogTarget>(undefined);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [templateKey, setTemplateKey] = useState("");
  const [corporate, setCorporate] = useState(true);
  const [archiveTarget, setArchiveTarget] = useState<ProcessDefinition | null>(null);

  const [version, setVersion] = useState<ProcessVersionDetail | null>(null);
  const [steps, setSteps] = useState<ProcessStepConfig[]>([]);
  const [serial, setSerial] = useState(0);
  const [savedSerial, setSavedSerial] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextCatalog, nextOptions] = await Promise.all([
        processRequest<ProcessCatalogPayload>("/api/processes"),
        processRequest<ProcessOptions>("/api/processes/options"),
      ]);
      setCatalog(nextCatalog);
      setOptions(nextOptions);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Erro ao carregar processos.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(); });
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  const processes = useMemo(() => catalog?.processes ?? [], [catalog?.processes]);
  const versions = useMemo(() => catalog?.versions ?? [], [catalog?.versions]);
  const permissions = catalog?.permissions ?? { view: false, manage: false, publish: false };
  const currentUserId = catalog?.currentUserId || options.currentUserId;

  /** Quantos recortes avançados estão valendo — o botão de filtros os anuncia,
   *  senão um filtro escondido na gaveta some da vista e a lista fica curta
   *  sem explicação. */
  const advancedCount = [status, area, company, owner, category].filter(Boolean).length;

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    const sectionFilter = sectionFilters[section];
    return processes.filter((process) => {
      // Arquivado só aparece na seção que existe para ele. Regra única, em vez
      // de um `else` pendurado no fim de uma cadeia de `if`.
      if (section === "archived" ? process.lifecycleStatus !== "archived" : process.lifecycleStatus === "archived") return false;
      if (sectionFilter && !sectionFilter(process, currentUserId)) return false;
      if (term && ![process.name, process.code, process.description, process.objective, ...process.tags]
        .some((value) => value.toLowerCase().includes(term))) return false;
      if (status && process.lifecycleStatus !== status) return false;
      if (area && process.ownerDepartmentId !== area) return false;
      if (company && !process.isCorporate && !process.companies.some((item) => item.id === company)) return false;
      if (owner && process.ownerUserId !== owner) return false;
      if (category && process.category !== category) return false;
      return true;
    });
  }, [area, category, company, currentUserId, owner, processes, query, section, status]);

  const save = useCallback(async () => {
    if (!version || version.status !== "draft" || serial <= savedSerial) return true;
    const captured = serial;
    setSaveState("saving");
    try {
      const result = await processRequest<{ version: { revision: number; updatedAt: string } }>(
        `/api/processes/versions/${version.id}`,
        { method: "PATCH", body: JSON.stringify({ revision: version.revision, bpmnXml: version.bpmnXml, svgPreview: version.svgPreview, stepConfigs: steps }) },
      );
      setVersion((current) => current ? { ...current, revision: result.version.revision, updatedAt: result.version.updatedAt } : current);
      setSavedSerial(captured);
      setSaveState(serial > captured ? "dirty" : "saved");
      return true;
    } catch (cause) {
      setSaveState("error");
      setError(cause instanceof Error ? cause.message : "Erro no autosave.");
      return false;
    }
  }, [savedSerial, serial, steps, version]);

  useEffect(() => {
    if (!version || version.status !== "draft" || serial <= savedSerial || saveState === "saving") return;
    const timer = setTimeout(() => { void save(); }, 1200);
    return () => clearTimeout(timer);
  }, [save, saveState, savedSerial, serial, version]);

  const openVersion = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const result = await processRequest<{ version: ProcessVersionDetail; stepConfigs: ProcessStepConfig[] }>(`/api/processes/versions/${id}`);
      setVersion(result.version);
      setSteps(result.stepConfigs);
      setSerial(0);
      setSavedSerial(0);
      setSaveState("idle");
      setSection("modeler");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Erro ao abrir versão.");
    } finally {
      setBusy(false);
    }
  }, []);

  function onDiagramChange(xml: string, svg: string) {
    setVersion((current) => current ? { ...current, bpmnXml: xml, svgPreview: svg } : current);
    setSerial((value) => value + 1);
    setSaveState("dirty");
  }

  function onStepConfigsChange(next: ProcessStepConfig[]) {
    setSteps(next);
    setSerial((value) => value + 1);
    setSaveState("dirty");
  }

  async function sendToReview() {
    if (!version || !(await save())) return;
    setBusy(true);
    try {
      await processRequest(`/api/processes/versions/${version.id}/review`, { method: "POST", body: "{}" });
      setToast("Versão enviada para revisão.");
      await load();
      await openVersion(version.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Erro ao enviar para revisão.");
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!version || (version.status === "draft" && !(await save()))) return;
    setBusy(true);
    try {
      await processRequest(`/api/processes/versions/${version.id}/publish`, { method: "POST", body: "{}" });
      setToast("Versão publicada.");
      await load();
      await openVersion(version.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Erro ao publicar.");
    } finally {
      setBusy(false);
    }
  }

  async function createVersion(process: ProcessDefinition) {
    setBusy(true);
    try {
      const result = await processRequest<{ version: ProcessVersionDetail }>(`/api/processes/${process.id}/versions`, { method: "POST", body: JSON.stringify({ bump: "minor" }) });
      await load();
      await openVersion(result.version.id);
      setToast("Nova versão criada.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Erro ao criar versão.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const existing = dialog || null;
    const payload = {
      name: field(data, "name"), code: field(data, "code"), description: field(data, "description"),
      objective: field(data, "objective"), category: field(data, "category"),
      ownerDepartmentId: field(data, "ownerDepartmentId"), ownerUserId: field(data, "ownerUserId"),
      isCorporate: corporate, companyIds: data.getAll("companyIds").map(String),
      active: data.get("active") === "on", allowManualStart: data.get("allowManualStart") === "on",
      allowAutomaticStart: data.get("allowAutomaticStart") === "on",
      requirePublicationApproval: data.get("requirePublicationApproval") === "on",
      globalSlaValue: Number(field(data, "globalSlaValue")) || 0, globalSlaUnit: field(data, "globalSlaUnit"),
      criticality: field(data, "criticality"), defaultPriority: field(data, "defaultPriority"),
      tags: field(data, "tags"), notes: field(data, "notes"),
      // Só na criação: uma edição não pode redesenhar o diagrama por baixo de
      // quem já o ajustou.
      ...(existing ? {} : { templateKey }),
    };
    setBusy(true);
    try {
      if (existing) {
        await processRequest(`/api/processes/${existing.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        setDialog(undefined);
        setToast("Processo atualizado.");
        await load();
      } else {
        const result = await processRequest<{ version: ProcessVersionDetail }>("/api/processes", { method: "POST", body: JSON.stringify(payload) });
        setDialog(undefined);
        await load();
        await openVersion(result.version.id);
        setToast(templateKey ? "Processo criado a partir da modelagem inicial." : "Processo criado como v1.0.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Erro ao salvar processo.");
    } finally {
      setBusy(false);
    }
  }

  async function archiveProcess(process: ProcessDefinition) {
    setBusy(true);
    try {
      await processRequest(`/api/processes/${process.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...process, companyIds: process.companies.map((item) => item.id), lifecycleStatus: "archived" }),
      });
      setArchiveTarget(null);
      await load();
      setToast("Processo arquivado.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Erro ao arquivar.");
    } finally {
      setBusy(false);
    }
  }

  function startFromTemplate(key: string) {
    setTemplateKey(key);
    setGalleryOpen(false);
    setCorporate(true);
    setDialog(null);
  }

  function clearFilters() {
    setStatus(""); setArea(""); setCompany(""); setOwner(""); setCategory("");
  }

  if (loading) return <LoadingState title="Carregando processos..." text="Preparando biblioteca, versões e responsáveis." />;

  const selectedTemplate = processTemplates.find((template) => template.key === templateKey) ?? null;

  return <div className={styles.workspace}>
    {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}
    {toast && <div className={styles.toast} role="status">{toast}</div>}

    <header className={styles.pageHeader}>
      <div>
        <span className={styles.eyebrow}>GESTÃO E MODELAGEM</span>
        <h2>Processos</h2>
        <p>Processo → versão → BPMN → configuração das etapas → demandas, evidências, movimentações e auditoria.</p>
      </div>
      {permissions.manage && <button type="button" className={styles.primaryButton} onClick={() => setGalleryOpen(true)}>
        <Plus aria-hidden="true" />Novo processo
      </button>}
    </header>

    <div className={styles.moduleBody}>
      <div className={styles.sectionTabsRow}>
        <AnimatedTabs label="Seções da gestão de processos" tabs={sectionTabs} active={section} onChange={setSection} />
      </div>

      <div className={styles.moduleContent}>
        {section === "modeler" ? (
          version ? <>
            <div className={styles.modelerCommand}>
              <button type="button" className={styles.secondaryButton} onClick={() => setSection("library")}>Voltar à biblioteca</button>
              <div>
                {version.status === "draft" && permissions.manage && <button type="button" className={styles.secondaryButton} onClick={() => void sendToReview()} disabled={busy}>Enviar para revisão</button>}
                {permissions.publish && ((!version.requirePublicationApproval && version.status === "draft") || version.status === "in_review")
                  && <button type="button" className={styles.primaryButton} onClick={() => void publish()} disabled={busy}><ShieldCheck aria-hidden="true" />Publicar</button>}
              </div>
            </div>
            <ProcessModeler version={version} stepConfigs={steps} areas={options.areas} members={options.members}
              processes={processes} readOnly={version.status !== "draft"} saveState={saveState}
              onDiagramChange={onDiagramChange} onStepConfigsChange={onStepConfigsChange} onSaveNow={() => void save()} />
          </> : <EmptyState icon={Workflow} title="Nenhuma versão aberta"
            text="Abra um processo pela biblioteca para desenhar o fluxo, configurar as etapas e publicar."
            action={<button type="button" className={styles.secondaryButton} onClick={() => setSection("library")}>Ir para a biblioteca</button>} />
        ) : section === "history" ? (
          <HistoryTable versions={versions} onOpen={openVersion} />
        ) : section === "settings" ? (
          <div className={styles.settingsPanel}>
            <Settings2 aria-hidden="true" />
            <h3>Configurações</h3>
            <p>Esta versão mantém definição e execução separadas: publicar um processo descreve como ele funciona, e não inicia instância nenhuma. A execução real entra na próxima fase sem alterar versões já publicadas.</p>
            <small>Perfil atual: {role}</small>
          </div>
        ) : <>
          <div className={styles.filterBar}>
            <label className={styles.searchField}>
              <Search aria-hidden="true" />
              <input placeholder="Nome, código, descrição ou etiqueta..." value={query}
                onChange={(event) => setQuery(event.target.value)} aria-label="Buscar processo" />
            </label>
            <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filtrar por status">
              <option value="">Todos os status</option>
              {["draft", "in_review", "published", "inactive", "archived"].map((value) => <option key={value} value={value}>{processStatusLabel[value]}</option>)}
            </select>
            <select value={area} onChange={(event) => setArea(event.target.value)} aria-label="Filtrar por área">
              <option value="">Todas as áreas</option>
              {options.areas.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            {/* Empresa, responsável e categoria abrem em gaveta (§46): seis
                controles lado a lado não cabiam no próprio rótulo. */}
            <button type="button" className={styles.filterButton} onClick={() => setFiltersOpen(true)}>
              <SlidersHorizontal aria-hidden="true" />Filtros
              {advancedCount ? <b>{advancedCount}</b> : null}
            </button>
          </div>

          {filtered.length ? <FadeIn>
            <div className={styles.processTableWrap}>
              <table className={styles.processTable}>
                <thead><tr>
                  <th scope="col">Processo</th><th scope="col">Área / responsável</th><th scope="col">Escopo</th>
                  <th scope="col">Versão</th><th scope="col">Status</th><th scope="col">Etapas</th>
                  <th scope="col">Atualizado</th><th scope="col">Ações</th>
                </tr></thead>
                <tbody>
                  {filtered.map((process) => <tr key={process.id}>
                    <td>
                      <strong>{process.name}</strong>
                      <small>{process.code} · {process.category}</small>
                      <p>{process.description || process.objective || "Sem descrição."}</p>
                    </td>
                    <td>{process.ownerDepartmentName || "—"}<small>{process.ownerUserName || "—"}</small></td>
                    <td>{process.isCorporate ? "Corporativo" : process.companies.map((item) => item.name).join(", ")}</td>
                    <td>{process.currentVersion ? processVersionLabel(process.currentVersion.versionMajor, process.currentVersion.versionMinor) : "—"}</td>
                    <td><StatusPill status={process.lifecycleStatus} label={processStatusLabel[process.lifecycleStatus] || process.lifecycleStatus} /></td>
                    <td>{process.stepCount}</td>
                    <td>{formatMoment(process.updatedAt)}</td>
                    <td><div className={styles.rowActions}>
                      {process.currentVersionId && <button type="button" onClick={() => void openVersion(process.currentVersionId)}>Abrir</button>}
                      {permissions.manage && process.lifecycleStatus !== "archived" && <button type="button" onClick={() => { setTemplateKey(""); setDialog(process); setCorporate(process.isCorporate); }}>Editar</button>}
                      {permissions.manage && process.lifecycleStatus === "published" && <button type="button" onClick={() => void createVersion(process)}>Nova versão</button>}
                      {permissions.manage && process.lifecycleStatus !== "archived" && <button type="button" className={styles.dangerText} onClick={() => setArchiveTarget(process)}><Archive aria-hidden="true" />Arquivar</button>}
                    </div></td>
                  </tr>)}
                </tbody>
              </table>
            </div>
          </FadeIn> : <EmptyState icon={BookOpenCheck}
            title={processes.length ? "Nenhum processo com esses filtros" : "A biblioteca ainda está vazia"}
            text={processes.length
              ? "Ajuste a busca ou limpe os filtros avançados para ver os processos do grupo."
              : "Comece por uma das modelagens iniciais — Entrega de EPI, Pagamento PJ ou Demanda entre áreas — e ajuste o fluxo ao seu grupo."}
            action={permissions.manage && !processes.length
              ? <button type="button" className={styles.primaryButton} onClick={() => setGalleryOpen(true)}><LayoutTemplate aria-hidden="true" />Ver modelagens iniciais</button>
              : advancedCount ? <button type="button" className={styles.secondaryButton} onClick={clearFilters}>Limpar filtros</button> : undefined} />}
        </>}
      </div>
    </div>

    <AnimatedDrawer open={filtersOpen} onClose={() => setFiltersOpen(false)} label="Filtros avançados de processos">
      <div className={styles.filterDrawer}>
        <header>
          <strong>Filtros avançados</strong>
          <button type="button" className={styles.filterButton} onClick={() => setFiltersOpen(false)} aria-label="Fechar filtros"><X aria-hidden="true" /></button>
        </header>
        <label>Empresa
          <select value={company} onChange={(event) => setCompany(event.target.value)}>
            <option value="">Todas as empresas</option>
            {options.companies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>Responsável
          <select value={owner} onChange={(event) => setOwner(event.target.value)}>
            <option value="">Todos os responsáveis</option>
            {options.members.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>Categoria
          <input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Ex.: pagamentos" />
        </label>
        <footer>
          <button type="button" className={styles.secondaryButton} onClick={clearFilters}>Limpar</button>
          <button type="button" className={styles.primaryButton} onClick={() => setFiltersOpen(false)}>Aplicar</button>
        </footer>
      </div>
    </AnimatedDrawer>

    <AnimatedModal open={galleryOpen} onClose={() => setGalleryOpen(false)} label="Modelagens iniciais" width={820}>
      <div className={styles.dialogHeader}>
        <h3>Como este processo começa</h3>
        <button type="button" onClick={() => setGalleryOpen(false)}>Fechar</button>
      </div>
      <div className={styles.processForm}>
        <div className={styles.templateGallery}>
          <p>
            As modelagens abaixo são os fluxos que o Vinculato já executa, desenhados por inteiro.
            Elas descrevem <strong>como o processo funciona</strong> — nenhuma delas cria competência,
            entrega ou pagamento. O que você recebe é um rascunho editável na versão 1.0.
          </p>
          <StaggerContainer className={styles.templateGrid}>
            {processTemplates.map((template, index) => {
              const shape = templateShape(template);
              return <StaggerItem key={template.key} index={index}>
                <MotionCard icon={LayoutTemplate} title={template.name} description={template.description}
                  onClick={() => startFromTemplate(template.key)}
                  meta={<span className={styles.templateShape}>
                    <span>{shape.steps} etapas</span>
                    <span>{shape.decisions} decisão</span>
                    <span>{shape.ends === 1 ? "1 fim" : `${shape.ends} fins`}</span>
                  </span>} />
              </StaggerItem>;
            })}
            <StaggerItem index={processTemplates.length}>
              <MotionCard icon={FilePenLine} title="Começar em branco"
                description="Início, uma etapa e fim. Para um processo que não se parece com nenhum dos anteriores."
                onClick={() => startFromTemplate("")} />
            </StaggerItem>
          </StaggerContainer>
        </div>
      </div>
    </AnimatedModal>

    <AnimatedModal open={dialog !== undefined} onClose={() => setDialog(undefined)}
      label={dialog ? "Editar processo" : "Novo processo"} width={880}>
      <ProcessDialog process={dialog ?? null} options={options} corporate={corporate} setCorporate={setCorporate}
        close={() => setDialog(undefined)} submit={submit} busy={busy} template={selectedTemplate} />
    </AnimatedModal>

    <AnimatedModal open={archiveTarget !== null} onClose={() => setArchiveTarget(null)} label="Arquivar processo" width={440}>
      <div className={styles.confirmBody}>
        <FolderArchive aria-hidden="true" />
        <h3>Arquivar {archiveTarget?.name}?</h3>
        <p>O histórico e as versões permanecem preservados. O processo sai da biblioteca e passa a aparecer apenas em Arquivados.</p>
        <div>
          <button type="button" onClick={() => setArchiveTarget(null)}>Cancelar</button>
          <button type="button" className={styles.dangerButton} disabled={busy}
            onClick={() => archiveTarget && void archiveProcess(archiveTarget)}>Arquivar</button>
        </div>
      </div>
    </AnimatedModal>
  </div>;
}

function HistoryTable({ versions, onOpen }: { versions: ProcessVersionSummary[]; onOpen: (id: string) => Promise<void> }) {
  if (!versions.length) {
    return <EmptyState icon={History} title="Nenhuma versão registrada"
      text="Cada publicação e cada rascunho aparecem aqui, com autor e data." />;
  }
  return <div className={styles.historyPanel}>
    <h3>Histórico de versões</h3>
    <div>
      <table>
        <thead><tr>
          <th scope="col">Processo</th><th scope="col">Versão</th><th scope="col">Status</th>
          <th scope="col">Criada por</th><th scope="col">Publicado</th><th scope="col"><span className="sr-only">Ações</span></th>
        </tr></thead>
        <tbody>
          {versions.map((item) => <tr key={item.id}>
            <td>{item.processName}</td>
            <td>{processVersionLabel(item.versionMajor, item.versionMinor)}</td>
            <td><StatusPill status={item.status} label={processStatusLabel[item.status] || item.status} /></td>
            <td>{item.createdByName || "Sistema"}</td>
            <td>{formatMoment(item.publishedAt)}</td>
            <td><button type="button" onClick={() => void onOpen(item.id)}>Visualizar</button></td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </div>;
}

function ProcessDialog({ process, options, corporate, setCorporate, close, submit, busy, template }: {
  process: ProcessDefinition | null;
  options: ProcessOptions;
  corporate: boolean;
  setCorporate: (value: boolean) => void;
  close: () => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
  busy: boolean;
  template: { key: string; name: string; code: string; category: string; description: string; objective: string; tags: readonly string[] } | null;
}) {
  // Numa criação a partir de modelagem, os campos chegam preenchidos com o que
  // o template já sabe — e continuam editáveis. `defaultValue` basta porque o
  // diálogo é remontado a cada abertura.
  const seed = process ?? template;
  return <>
    <div className={styles.dialogHeader}>
      <h3>{process ? "Editar processo" : template ? `Novo processo · ${template.name}` : "Novo processo"}</h3>
      <button type="button" onClick={close}>Fechar</button>
    </div>
    <form className={styles.processForm} onSubmit={submit}>
      <div className={styles.formGrid}>
        <label>Nome<input name="name" required defaultValue={seed?.name ?? ""} /></label>
        <label>Código<input name="code" required disabled={!!process} defaultValue={seed?.code ?? ""} /></label>
        <label className={styles.wideField}>Descrição<textarea name="description" rows={2} defaultValue={seed?.description ?? ""} /></label>
        <label className={styles.wideField}>Objetivo<textarea name="objective" rows={2} defaultValue={seed?.objective ?? ""} /></label>
        <label>Categoria<input name="category" defaultValue={seed?.category ?? "general"} /></label>
        <label>Área
          <select name="ownerDepartmentId" defaultValue={process?.ownerDepartmentId ?? ""}>
            <option value="">Não definida</option>
            {options.areas.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>Responsável
          <select name="ownerUserId" defaultValue={process?.ownerUserId ?? options.currentUserId}>
            <option value="">Não definido</option>
            {options.members.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>Etiquetas<input name="tags" defaultValue={(process?.tags ?? template?.tags ?? []).join(", ")} /></label>
        <label>SLA<input type="number" name="globalSlaValue" min={0} defaultValue={process?.globalSlaValue ?? 0} /></label>
        <label>Unidade
          <select name="globalSlaUnit" defaultValue={process?.globalSlaUnit ?? "hours"}>
            <option value="minutes">Minutos</option><option value="hours">Horas</option><option value="days">Dias</option>
          </select>
        </label>
        <label>Criticidade
          <select name="criticality" defaultValue={process?.criticality ?? "medium"}>
            <option value="low">Baixa</option><option value="medium">Média</option><option value="high">Alta</option><option value="critical">Crítica</option>
          </select>
        </label>
        <label>Prioridade
          <select name="defaultPriority" defaultValue={process?.defaultPriority ?? "normal"}>
            <option value="low">Baixa</option><option value="normal">Normal</option><option value="high">Alta</option><option value="urgent">Urgente</option>
          </select>
        </label>
        <label className={styles.wideField}>Observações<textarea name="notes" rows={2} defaultValue={process?.notes ?? ""} /></label>
      </div>
      <div className={styles.toggleGrid}>
        <label><input type="checkbox" name="active" defaultChecked={process?.active ?? true} />Ativo</label>
        <label><input type="checkbox" checked={corporate} onChange={(event) => setCorporate(event.target.checked)} />Corporativo</label>
        <label><input type="checkbox" name="allowManualStart" defaultChecked={process?.allowManualStart ?? true} />Abertura manual</label>
        <label><input type="checkbox" name="allowAutomaticStart" defaultChecked={process?.allowAutomaticStart ?? false} />Criação automática</label>
        <label><input type="checkbox" name="requirePublicationApproval" defaultChecked={process?.requirePublicationApproval ?? false} />Exigir revisão</label>
      </div>
      {!corporate && <div className={styles.companyPicker}>
        {options.companies.map((item) => <label key={item.id}>
          <input type="checkbox" name="companyIds" value={item.id} defaultChecked={process?.companies.some((entry) => entry.id === item.id)} />{item.name}
        </label>)}
      </div>}
      <footer>
        <button type="button" onClick={close}>Cancelar</button>
        <button type="submit" className={styles.primaryButton} disabled={busy}>
          {busy ? "Salvando..." : process ? "Salvar" : "Criar rascunho v1.0"}
        </button>
      </footer>
    </form>
  </>;
}
