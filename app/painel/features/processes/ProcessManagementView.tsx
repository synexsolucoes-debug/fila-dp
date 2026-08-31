"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Archive, BookOpenCheck, Building2, Clock3, FilePenLine, FileText,
  History, LayoutTemplate, Pencil, Play, Plus, RotateCcw, Search, Settings2, ShieldCheck,
  SlidersHorizontal, UserRound, Workflow, X, Zap,
} from "lucide-react";
import type { WorkspaceRole } from "@/lib/fila-dp-types";
import { processTemplates, templateShape } from "@/lib/process-templates";
import {
  AnimatedDrawer, AnimatedModal, AnimatedTabs, ConfirmDialog, EmptyState, ErrorBanner, FadeIn,
  MotionCard, PageSkeleton, StaggerContainer, StaggerItem, StatusPill, type AnimatedTab,
} from "../shared";
import { ProcessOperationPanel, type ProcessSheetSection } from "../work";
import { ProcessModeler } from "./ProcessModeler";
import { processRequest, processStatusLabel, processVersionLabel } from "./processes.api";
import type {
  ProcessCatalogPayload, ProcessDefinition, ProcessOptions, ProcessPermissions, ProcessSection,
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
  /* Rascunhos, Em revisão, Publicados e Arquivados NÃO entram aqui.
     Cada um deles era uma aba e, logo abaixo, um cartão com contagem que
     chamava exatamente o mesmo `setSection` — o mesmo controle duas vezes,
     empilhado, e o de cima sem os números. Ficou o de baixo, que informa
     quantos há em cada estado; a faixa passa a aparecer também dentro dessas
     seções, para continuar servindo de seletor em vez de sumir ao ser usada. */
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

/** "1 etapa" / "10 etapas". Local porque `lib/marketing.ts` veste o site, e
 *  importar o vocabulário do site dentro do painel embaralha os dois. */
const contar = (total: number, singular: string, plural: string) =>
  `${total} ${total === 1 ? singular : plural}`;

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
  const [detailTarget, setDetailTarget] = useState<ProcessDefinition | null>(null);
  /* O processo aberto na coluna do meio. A biblioteca deixou de ser uma tabela
     de onde se abre uma modal e passou a ser catálogo + ficha + propriedades
     lado a lado: comparar dois processos era fechar e reabrir a modal, e a
     ficha só existia por cima do que a pessoa estava lendo. */
  const [selectedId, setSelectedId] = useState("");

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

  /* A seleção segue o que está à vista: filtrar até sobrar outro conjunto e
     manter aberto um processo que sumiu da lista deixaria a ficha falando de
     algo que a coluna ao lado não mostra mais. Sem seleção, abre o primeiro —
     uma coluna do meio vazia na chegada desperdiça a maior área da tela. */
  const selected = filtered.find((item) => item.id === selectedId) ?? filtered[0] ?? null;

  const maturity = useMemo(() => ({
    drafts: processes.filter((item) => item.lifecycleStatus !== "archived" && item.currentVersion?.status === "draft").length,
    review: processes.filter((item) => item.lifecycleStatus !== "archived" && item.currentVersion?.status === "in_review").length,
    published: processes.filter((item) => item.lifecycleStatus === "published").length,
    archived: processes.filter((item) => item.lifecycleStatus === "archived").length,
  }), [processes]);

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
      setDetailTarget(null);
      await load();
      setToast("Processo arquivado.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Erro ao arquivar.");
    } finally {
      setBusy(false);
    }
  }

  async function restoreProcess(process: ProcessDefinition) {
    setBusy(true);
    try {
      await processRequest(`/api/processes/${process.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...process, active: true, companyIds: process.companies.map((item) => item.id), lifecycleStatus: "restore" }),
      });
      setDetailTarget(null);
      await load();
      setToast("Processo restaurado para a biblioteca.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Erro ao restaurar processo.");
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

  // Esqueleto e não rodopio (§51): a tela é uma biblioteca com filtros e
  // tabela, e o esqueleto já diz essa forma antes de o dado chegar.
  if (loading) return <PageSkeleton label="Carregando a biblioteca de processos" metrics={0} rows={5} />;

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
          <section className={styles.maturityStrip} aria-label="Maturidade operacional da biblioteca">
            <button type="button" onClick={() => setSection("drafts")} data-tone="draft" aria-current={section === "drafts" ? "true" : undefined}>
              <span>Rascunhos</span><strong>{maturity.drafts}</strong><small>Aguardando desenho ou ajuste</small>
            </button>
            <button type="button" onClick={() => setSection("review")} data-tone="review" aria-current={section === "review" ? "true" : undefined}>
              <span>Em revisão</span><strong>{maturity.review}</strong><small>Prontos para decisão</small>
            </button>
            <button type="button" onClick={() => setSection("published")} data-tone="published" aria-current={section === "published" ? "true" : undefined}>
              <span>Publicados</span><strong>{maturity.published}</strong><small>Referências vigentes</small>
            </button>
            <button type="button" onClick={() => setSection("archived")} data-tone="archived" aria-current={section === "archived" ? "true" : undefined}>
              <span>Arquivados</span><strong>{maturity.archived}</strong><small>Histórico preservado</small>
            </button>
          </section>

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
            {/* Catálogo · ficha · propriedades.
                O catálogo responde "quais processos existem", a ficha responde
                "como este funciona" e a coluna da direita responde "em que pé
                ele está". Antes as três respostas moravam em lugares
                diferentes: tabela larga, modal por cima e nada. */}
            <div className={styles.libraryLayout}>

              <aside className={styles.catalogColumn} aria-label="Catálogo de processos">
                <header className={styles.catalogHeader}>
                  <strong>Catálogo de processos</strong>
                  <span>{contar(filtered.length, "processo", "processos")}</span>
                </header>
                <ul className={styles.catalogList}>
                  {filtered.map((process) => <li key={process.id}>
                    <button type="button"
                      className={styles.catalogCard}
                      aria-current={selected?.id === process.id ? "true" : undefined}
                      onClick={() => setSelectedId(process.id)}>
                      <span className={styles.catalogTop}>
                        <strong>{process.name}</strong>
                        <StatusPill status={process.lifecycleStatus} label={processStatusLabel[process.lifecycleStatus] || process.lifecycleStatus} />
                      </span>
                      <small>{process.ownerDepartmentName || "Sem área definida"}</small>
                      <em>
                        {process.currentVersion
                          ? `Versão ${processVersionLabel(process.currentVersion.versionMajor, process.currentVersion.versionMinor)}`
                          : "Sem versão"}
                        {" · "}{contar(process.stepCount, "etapa", "etapas")}
                        {" · "}Atualizado {formatMoment(process.updatedAt)}
                      </em>
                    </button>
                  </li>)}
                </ul>
              </aside>

              <div className={styles.sheetColumn}>
                {selected ? <ProcessDetail process={selected} permissions={permissions} busy={busy} inline
                  versions={(catalog?.versions ?? []).filter((item) => item.processId === selected.id)}
                  close={() => undefined}
                  openVersion={openVersion}
                  openModeler={() => { if (selected.currentVersionId) void openVersion(selected.currentVersionId); }}
                  edit={() => { setTemplateKey(""); setDialog(selected); setCorporate(selected.isCorporate); }}
                  createVersion={() => void createVersion(selected)}
                  archive={() => setArchiveTarget(selected)}
                  restore={() => void restoreProcess(selected)} /> : null}
              </div>

              {selected ? <ProcessProperties process={selected} permissions={permissions} busy={busy}
                openModeler={() => { if (selected.currentVersionId) void openVersion(selected.currentVersionId); }}
                edit={() => { setTemplateKey(""); setDialog(selected); setCorporate(selected.isCorporate); }}
                createVersion={() => void createVersion(selected)}
                archive={() => setArchiveTarget(selected)}
                restore={() => void restoreProcess(selected)} /> : null}

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

    <AnimatedDrawer open={filtersOpen} onClose={() => setFiltersOpen(false)} label="Filtros avançados de processos" className={styles.processPortal}>
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

    <AnimatedModal open={galleryOpen} onClose={() => setGalleryOpen(false)} label="Modelagens iniciais" width={820} className={styles.processPortal}>
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
      label={dialog ? "Editar processo" : "Novo processo"} width={920} className={styles.processPortal}>
      <ProcessDialog process={dialog ?? null} options={options} corporate={corporate} setCorporate={setCorporate}
        close={() => setDialog(undefined)} submit={submit} busy={busy} template={selectedTemplate} />
    </AnimatedModal>

    <AnimatedModal open={detailTarget !== null} onClose={() => setDetailTarget(null)}
      label={`Ficha operacional de ${detailTarget?.name ?? "processo"}`} width={900} className={styles.processPortal}>
      {detailTarget && <ProcessDetail process={detailTarget} permissions={permissions} busy={busy}
        versions={(catalog?.versions ?? []).filter((item) => item.processId === detailTarget.id)}
        openVersion={async (id) => { setDetailTarget(null); await openVersion(id); }}
        close={() => setDetailTarget(null)}
        openModeler={() => { setDetailTarget(null); if (detailTarget.currentVersionId) void openVersion(detailTarget.currentVersionId); }}
        edit={() => { setTemplateKey(""); setDialog(detailTarget); setCorporate(detailTarget.isCorporate); setDetailTarget(null); }}
        createVersion={() => { setDetailTarget(null); void createVersion(detailTarget); }}
        archive={() => { setArchiveTarget(detailTarget); setDetailTarget(null); }}
        restore={() => void restoreProcess(detailTarget)} />}
    </AnimatedModal>

    {/* A confirmação vem do componente compartilhado (§53): ele exige a
        consequência por escrito, prende o foco e não deixa o Esc escapar no
        meio de uma ação já enviada. */}
    <ConfirmDialog
      open={archiveTarget !== null}
      title={`Arquivar ${archiveTarget?.name ?? "processo"}?`}
      consequence="O processo sai da biblioteca e passa a aparecer apenas em Arquivados. O histórico e as versões publicadas permanecem preservados, e nada que já foi executado é alterado."
      confirmLabel="Arquivar processo"
      busy={busy}
      onCancel={() => setArchiveTarget(null)}
      onConfirm={() => archiveTarget && void archiveProcess(archiveTarget)}
    />
  </div>;
}

const criticalityLabel: Record<ProcessDefinition["criticality"], string> = { low: "Baixa", medium: "Média", high: "Alta", critical: "Crítica" };
const priorityLabel: Record<ProcessDefinition["defaultPriority"], string> = { low: "Baixa", normal: "Normal", high: "Alta", urgent: "Urgente" };
const slaUnitLabel: Record<ProcessDefinition["globalSlaUnit"], string> = { minutes: "minutos", hours: "horas", days: "dias" };

/**
 * As seis abas que a §31 pede na ficha do processo.
 *
 * O eixo importa: a barra de seções da página navega o **catálogo** por ciclo de
 * vida ("rascunhos", "publicados"), e a §31 pede navegar **um processo por
 * dentro**. Eram dois eixos diferentes com a mesma aparência, e o segundo não
 * existia: para saber quais documentos a Admissão cobra era preciso abrir o
 * modelador e somar etapa por etapa de cabeça.
 *
 * Quatro das abas leem a mesma resposta da rota da ficha, e por isso saem do
 * mesmo componente montado: quatro componentes fariam quatro pedidos iguais e
 * abririam caminho para quatro leituras divergentes do mesmo processo.
 */
type DetailTab = "flow" | "description" | "documents" | "rules" | "automations" | "versions";

const detailTabs: ReadonlyArray<AnimatedTab<DetailTab>> = [
  { id: "flow", label: "Fluxo do processo", icon: Workflow },
  { id: "description", label: "Descrição", icon: BookOpenCheck },
  { id: "documents", label: "Documentos", icon: FileText },
  { id: "rules", label: "Regras e validações", icon: ShieldCheck },
  { id: "automations", label: "Automações", icon: Zap },
  { id: "versions", label: "Histórico de versões", icon: History },
];

/** As abas que são recorte da ficha carregada — o resto sai do catálogo. */
const sheetSections: Partial<Record<DetailTab, ProcessSheetSection>> = {
  flow: "flow", documents: "documents", rules: "rules", automations: "automations",
};

function ProcessDetail({ process, permissions, busy, versions, openVersion, close, openModeler, edit, createVersion, archive, restore, inline = false }: {
  process: ProcessDefinition;
  permissions: ProcessPermissions;
  busy: boolean;
  versions: ProcessVersionSummary[];
  openVersion: (id: string) => Promise<void>;
  close: () => void;
  /** Na biblioteca a ficha é a coluna do meio, e não uma modal por cima. */
  inline?: boolean;
  openModeler: () => void;
  edit: () => void;
  createVersion: () => void;
  archive: () => void;
  restore: () => void;
}) {
  const archived = process.lifecycleStatus === "archived";
  const [tab, setTab] = useState<DetailTab>("flow");
  const sheetSection = sheetSections[tab];
  return <div className={styles.detailSheet}>
    <header className={styles.detailHeader}>
      <div>
        <span className={styles.eyebrow}>FICHA OPERACIONAL · {process.code}</span>
        <h3>{process.name}</h3>
        <div className={styles.detailStatus}>
          <StatusPill status={process.lifecycleStatus} label={processStatusLabel[process.lifecycleStatus]} />
          <span>{process.category || "Sem categoria"}</span>
          <span>Atualizado {formatMoment(process.updatedAt)}</span>
        </div>
      </div>
      {inline ? null : <button type="button" className={styles.secondaryButton} onClick={close}>Fechar</button>}
    </header>

    {/* Os cinco fatos que decidem se esta versão pode receber demanda hoje,
        antes de qualquer aba: qual versão vale, desde quando, o prazo padrão e
        o tipo. Estavam espalhados entre colunas da tabela e a aba de descrição. */}
    <dl className={styles.detailMeta}>
      <div><dt>Versão</dt><dd>{process.currentVersion
        ? processVersionLabel(process.currentVersion.versionMajor, process.currentVersion.versionMinor) : "—"}</dd></div>
      <div><dt>Publicada em</dt><dd>{process.currentVersion?.publishedAt
        ? formatMoment(process.currentVersion.publishedAt) : "Não publicada"}</dd></div>
      <div><dt>Atualizada em</dt><dd>{formatMoment(process.updatedAt)}</dd></div>
      <div><dt>SLA padrão</dt><dd>{process.globalSlaValue > 0
        ? `${process.globalSlaValue} ${slaUnitLabel[process.globalSlaUnit]}` : "Sem SLA definido"}</dd></div>
      <div><dt>Tipo de processo</dt><dd>{process.category || "Não classificado"}</dd></div>
    </dl>

    {/* A mesma barra da página, e não uma segunda aparência de aba: duas
        gramáticas de navegação na mesma tela fazem a pessoa aprender duas. */}
    <div className={styles.sectionTabsRow}>
      {/* `className` em vez de mexer no componente: `AnimatedTabs` veste várias
          telas, e fazer as abas rolarem em todas elas por causa desta coluna
          seria alterar o que não foi pedido. A variante fica aqui. */}
      <AnimatedTabs tabs={detailTabs} active={tab} onChange={setTab} label="Seções do processo"
        className={inline ? styles.sheetTabs : undefined} />
    </div>

    {tab === "description" ? <ProcessDescription process={process} /> : null}

    {tab === "versions" ? <HistoryTable versions={versions} onOpen={openVersion} /> : null}

    {/* Fluxo, documentos, regras e automações são recortes da mesma ficha, e por
        isso saem do mesmo componente: trocar de aba entre eles não recarrega. */}
    {sheetSection ? <section>
      <ProcessOperationPanel processId={process.id} section={sheetSection} />
    </section> : null}

    {inline ? null : <footer className={styles.detailActions}>
      <div>{archived ? "Processo arquivado — versões e histórico foram preservados." : "Escolha a próxima ação sem perder o contexto da ficha."}</div>
      <span>
        {permissions.manage && archived && <button type="button" className={styles.secondaryButton} onClick={restore} disabled={busy}><RotateCcw aria-hidden="true" />Restaurar</button>}
        {permissions.manage && !archived && <button type="button" className={styles.secondaryButton} onClick={edit}><Pencil aria-hidden="true" />Editar cadastro</button>}
        {permissions.manage && process.lifecycleStatus === "published" && <button type="button" className={styles.secondaryButton} onClick={createVersion} disabled={busy}><Plus aria-hidden="true" />Nova versão</button>}
        {permissions.manage && !archived && <button type="button" className={styles.secondaryButton} onClick={archive}><Archive aria-hidden="true" />Arquivar</button>}
        {process.currentVersionId && <button type="button" className={styles.primaryButton} onClick={openModeler}><Workflow aria-hidden="true" />Abrir modelador</button>}
      </span>
    </footer>}
  </div>;
}

/**
 * A terceira coluna: em que pé este processo está (maquete de Processos).
 *
 * Ela responde o que a ficha não responde. A ficha explica **como o trabalho
 * acontece** — etapas, tarefas, documentos, regras. Esta coluna explica o
 * **estado do próprio processo**: qual versão vale, quem publicou e quando,
 * quantas etapas e tarefas ele prevê, quantas automações dependem dele.
 *
 * Antes esses fatos estavam repartidos entre colunas da tabela, a aba de
 * descrição e o rodapé da modal; decidir "posso mexer neste processo?" exigia
 * percorrer os três.
 */
function ProcessProperties({ process, permissions, busy, openModeler, edit, createVersion, archive, restore }: {
  process: ProcessDefinition;
  permissions: ProcessPermissions;
  busy: boolean;
  openModeler: () => void;
  edit: () => void;
  createVersion: () => void;
  archive: () => void;
  restore: () => void;
}) {
  const archived = process.lifecycleStatus === "archived";
  const escopo = process.isCorporate
    ? "Todas as empresas do grupo"
    : contar(process.companies.length, "empresa", "empresas");

  return <aside className={styles.propertiesColumn} aria-label={`Propriedades de ${process.name}`}>
    <section className={styles.propertiesCard}>
      <header><strong>Propriedades do processo</strong></header>
      <dl>
        <div><dt>Status</dt><dd><StatusPill status={process.lifecycleStatus}
          label={processStatusLabel[process.lifecycleStatus] || process.lifecycleStatus} /></dd></div>
        <div><dt>Versão atual</dt><dd>{process.currentVersion
          ? processVersionLabel(process.currentVersion.versionMajor, process.currentVersion.versionMinor)
          : "Nenhuma"}</dd></div>
        {/* "Publicado por" não existe no catálogo — e inventar um nome aqui
            seria pior que a ausência, porque publicação é ato com responsável. */}
        <div><dt>Publicação</dt><dd>{process.currentVersion?.publishedAt
          ? formatMoment(process.currentVersion.publishedAt) : "Ainda não publicada"}</dd></div>
        <div><dt>Última atualização</dt><dd>{formatMoment(process.updatedAt)}
          {process.updatedByName ? <small>por {process.updatedByName}</small> : null}</dd></div>
        <div><dt>Área responsável</dt><dd>{process.ownerDepartmentName || "Não definida"}</dd></div>
        <div><dt>Responsável</dt><dd>{process.ownerUserName || "Não definido"}</dd></div>
        <div><dt>Escopo</dt><dd>{escopo}</dd></div>
        <div><dt>SLA padrão</dt><dd>{process.globalSlaValue > 0
          ? `${process.globalSlaValue} ${slaUnitLabel[process.globalSlaUnit]}` : "Sem SLA definido"}</dd></div>
        <div><dt>Total de etapas</dt><dd>{process.stepCount}</dd></div>
      </dl>
    </section>

    <section className={styles.propertiesCard}>
      <header><strong>Ações rápidas</strong></header>
      <div className={styles.quickActions}>
        {process.currentVersionId && <button type="button" onClick={openModeler}>
          <Workflow aria-hidden="true" />Abrir modelador</button>}
        {permissions.manage && !archived && <button type="button" onClick={edit}>
          <Pencil aria-hidden="true" />Editar cadastro</button>}
        {permissions.manage && process.lifecycleStatus === "published" && <button type="button" onClick={createVersion} disabled={busy}>
          <Plus aria-hidden="true" />Nova versão</button>}
        {permissions.manage && !archived && <button type="button" className={styles.dangerText} onClick={archive}>
          <Archive aria-hidden="true" />Arquivar processo</button>}
        {permissions.manage && archived && <button type="button" onClick={restore} disabled={busy}>
          <RotateCcw aria-hidden="true" />Restaurar</button>}
      </div>
      {archived ? <p className={styles.propertiesNote}>
        Processo arquivado — versões e histórico foram preservados.
      </p> : null}
    </section>
  </aside>;
}

/** O cadastro do processo (§22), que era a rolagem inteira e agora é uma aba. */
function ProcessDescription({ process }: { process: ProcessDefinition }) {
  return <>
    <section className={styles.detailPurpose}>
      <span>Propósito</span>
      <p>{process.objective || process.description || "Este processo ainda não possui objetivo documentado."}</p>
      {process.description && process.description !== process.objective ? <small>{process.description}</small> : null}
    </section>

    <div className={styles.detailGrid}>
      <section>
        <header><Building2 aria-hidden="true" /><strong>Governança e escopo</strong></header>
        <dl>
          <div><dt>Área dona</dt><dd>{process.ownerDepartmentName || "Não definida"}</dd></div>
          <div><dt>Responsável</dt><dd>{process.ownerUserName || "Não definido"}</dd></div>
          <div><dt>Empresas</dt><dd>{process.isCorporate ? "Todas — processo corporativo" : process.companies.map((item) => item.name).join(", ") || "Nenhuma selecionada"}</dd></div>
        </dl>
      </section>
      <section>
        <header><Play aria-hidden="true" /><strong>Início e publicação</strong></header>
        <dl>
          <div><dt>Abertura</dt><dd>{[process.allowManualStart && "Manual", process.allowAutomaticStart && "Automática"].filter(Boolean).join(" + ") || "Sem regra de início"}</dd></div>
          <div><dt>Publicação</dt><dd>{process.requirePublicationApproval ? "Exige revisão" : "Publicação direta permitida"}</dd></div>
          <div><dt>Disponibilidade</dt><dd>{process.active ? "Ativo" : "Inativo"}</dd></div>
        </dl>
      </section>
      <section>
        <header><Clock3 aria-hidden="true" /><strong>Nível de serviço</strong></header>
        <dl>
          <div><dt>SLA global</dt><dd>{process.globalSlaValue ? `${process.globalSlaValue} ${slaUnitLabel[process.globalSlaUnit]}` : "Não definido"}</dd></div>
          <div><dt>Prioridade</dt><dd>{priorityLabel[process.defaultPriority]}</dd></div>
          <div><dt>Criticidade</dt><dd>{criticalityLabel[process.criticality]}</dd></div>
        </dl>
      </section>
      <section>
        <header><Workflow aria-hidden="true" /><strong>Modelagem vigente</strong></header>
        <dl>
          <div><dt>Versão atual</dt><dd>{process.currentVersion ? processVersionLabel(process.currentVersion.versionMajor, process.currentVersion.versionMinor) : "Sem versão"}</dd></div>
          <div><dt>Estado da versão</dt><dd>{process.currentVersion ? processStatusLabel[process.currentVersion.status] : "Não iniciada"}</dd></div>
          <div><dt>Etapas configuradas</dt><dd>{process.stepCount}</dd></div>
        </dl>
      </section>
    </div>

    {(process.tags.length > 0 || process.notes) && <section className={styles.detailNotes}>
      {process.tags.length > 0 && <div><strong>Etiquetas</strong><span>{process.tags.map((tag) => <b key={tag}>{tag}</b>)}</span></div>}
      {process.notes && <div><strong>Observações</strong><p>{process.notes}</p></div>}
    </section>}
  </>;
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
      <fieldset className={styles.formSection}>
        <legend><span>01</span><strong>Identificação</strong><small>O que este processo representa na organização.</small></legend>
        <div className={styles.formGrid}>
          <label>Nome<input name="name" required autoFocus defaultValue={seed?.name ?? ""} placeholder="Ex.: Aprovação de pagamento PJ" /></label>
          <label>Código<input name="code" required disabled={!!process} defaultValue={seed?.code ?? ""} placeholder="PAGAMENTO_PJ" /></label>
          <label className={styles.wideField}>Descrição<textarea name="description" rows={2} defaultValue={seed?.description ?? ""} placeholder="Explique quando e para que o processo é usado." /></label>
          <label className={styles.wideField}>Objetivo<textarea name="objective" rows={2} defaultValue={seed?.objective ?? ""} placeholder="Descreva o resultado esperado ao final do fluxo." /></label>
          <label>Categoria<input name="category" defaultValue={seed?.category ?? "general"} placeholder="Ex.: pagamentos" /></label>
        </div>
      </fieldset>

      <fieldset className={styles.formSection}>
        <legend><span>02</span><strong>Escopo e responsáveis</strong><small>Quem governa e onde a definição se aplica.</small></legend>
        <div className={styles.formGrid}>
          <label>Área responsável
            <select name="ownerDepartmentId" defaultValue={process?.ownerDepartmentId ?? ""}>
              <option value="">Não definida</option>
              {options.areas.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>Dono do processo
            <select name="ownerUserId" defaultValue={process?.ownerUserId ?? options.currentUserId}>
              <option value="">Não definido</option>
              {options.members.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        </div>
        <div className={styles.toggleGrid}>
          <label><input type="checkbox" name="active" defaultChecked={process?.active ?? true} />Processo ativo</label>
          <label><input type="checkbox" checked={corporate} onChange={(event) => setCorporate(event.target.checked)} />Aplicação corporativa</label>
        </div>
        {!corporate && <div className={styles.companyPicker}>
          <strong>Empresas incluídas</strong>
          {options.companies.map((item) => <label key={item.id}>
            <input type="checkbox" name="companyIds" value={item.id} defaultChecked={process?.companies.some((entry) => entry.id === item.id)} />{item.name}
          </label>)}
        </div>}
      </fieldset>

      <fieldset className={styles.formSection}>
        <legend><span>03</span><strong>Início e publicação</strong><small>Como o processo nasce e qual controle antecede sua vigência.</small></legend>
        <div className={styles.toggleGrid}>
          <label><input type="checkbox" name="allowManualStart" defaultChecked={process?.allowManualStart ?? true} />Permitir abertura manual</label>
          <label><input type="checkbox" name="allowAutomaticStart" defaultChecked={process?.allowAutomaticStart ?? false} />Permitir criação automática</label>
          <label><input type="checkbox" name="requirePublicationApproval" defaultChecked={process?.requirePublicationApproval ?? false} />Exigir revisão para publicar</label>
        </div>
      </fieldset>

      <fieldset className={styles.formSection}>
        <legend><span>04</span><strong>SLA e prioridade</strong><small>Parâmetros padrão usados na leitura operacional do fluxo.</small></legend>
        <div className={styles.formGrid}>
          <label>SLA global<input type="number" name="globalSlaValue" min={0} defaultValue={process?.globalSlaValue ?? 0} /></label>
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
          <label>Prioridade padrão
            <select name="defaultPriority" defaultValue={process?.defaultPriority ?? "normal"}>
              <option value="low">Baixa</option><option value="normal">Normal</option><option value="high">Alta</option><option value="urgent">Urgente</option>
            </select>
          </label>
        </div>
      </fieldset>

      <fieldset className={styles.formSection}>
        <legend><span>05</span><strong>Etiquetas e observações</strong><small>Contexto para busca, governança e manutenção futura.</small></legend>
        <div className={styles.formGrid}>
          <label className={styles.wideField}>Etiquetas<input name="tags" defaultValue={(process?.tags ?? template?.tags ?? []).join(", ")} placeholder="Separe por vírgula: pj, financeiro, mensal" /></label>
          <label className={styles.wideField}>Observações<textarea name="notes" rows={3} defaultValue={process?.notes ?? ""} /></label>
        </div>
      </fieldset>
      <footer>
        <button type="button" onClick={close}>Cancelar</button>
        <button type="submit" className={styles.primaryButton} disabled={busy}>
          {busy ? "Salvando..." : process ? "Salvar" : "Criar rascunho v1.0"}
        </button>
      </footer>
    </form>
  </>;
}
