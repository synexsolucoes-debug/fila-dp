"use client";

import { useEffect, useState } from "react";
import {
  Archive, BookmarkPlus, CalendarDays, Columns3, Focus, LayoutList, Search,
  Settings2, SlidersHorizontal, Star, Users, Workflow, X, type LucideIcon,
} from "lucide-react";
import type { BoardList, Company, WorkspaceMember } from "@/lib/fila-dp-types";
import {
  activeFilterCount, defaultDemandFilters, presetViews,
  type BoardViewMode, type DemandFilters, type DemandSort, type SavedBoardView,
} from "./board.model";
import styles from "./board.module.css";

const MODES: Array<{ id: BoardViewMode; label: string; icon: LucideIcon; hint: string }> = [
  { id: "team", label: "Equipe", icon: Users, hint: "Colunas por responsável" },
  { id: "queue", label: "Minha fila", icon: Star, hint: "Atrasadas, hoje, próximas e aguardando" },
  { id: "kanban", label: "Situação", icon: Columns3, hint: "Colunas por etapa do quadro" },
  { id: "process", label: "Processo", icon: Workflow, hint: "Agrupado por tipo de processo" },
  { id: "table", label: "Lista", icon: LayoutList, hint: "Tabela operacional" },
  { id: "calendar", label: "Calendário", icon: CalendarDays, hint: "Por data de vencimento" },
];

const SORTS: Array<{ id: DemandSort; label: string }> = [
  { id: "due", label: "Prazo mais crítico" },
  { id: "priority", label: "Prioridade" },
  { id: "recent", label: "Mais recentes" },
  { id: "oldest", label: "Mais antigas" },
  { id: "position", label: "Ordem do quadro" },
];

/** Debounce da busca. 250 ms é o intervalo em que uma pausa de digitação já
 *  aconteceu e a espera ainda não é percebida como lentidão. */
const SEARCH_DEBOUNCE_MS = 250;

export type BoardToolbarProps = {
  filters: DemandFilters;
  onFilters: (next: DemandFilters) => void;
  mode: BoardViewMode;
  onMode: (mode: BoardViewMode) => void;
  sort: DemandSort;
  onSort: (sort: DemandSort) => void;
  companies: readonly Company[];
  lists: readonly BoardList[];
  members: readonly WorkspaceMember[];
  processTypes: readonly string[];
  competences: readonly string[];
  currentMemberName: string;
  savedViews: readonly SavedBoardView[];
  onSaveView: () => void;
  onApplyView: (view: SavedBoardView) => void;
  onRemoveView: (id: string) => void;
  focusMode: boolean;
  onFocusMode: (value: boolean) => void;
  /* Exibição do quadro por etapa. Densidade e agrupamento só fazem sentido lá:
     o quadro por responsável já agrupa por pessoa, e a fila e a lista têm
     arranjo próprio. Mostrar os controles nos outros modos ofereceria ajustes
     que não mudariam nada na tela. */
  density: "comfortable" | "compact";
  onDensity: (value: "comfortable" | "compact") => void;
  groupBy: "none" | "company" | "assignee";
  onGroupBy: (value: "none" | "company" | "assignee") => void;
  archivedCount: number;
  onOpenArchive: () => void;
};

/**
 * A barra de comando do quadro: buscar, recortar, escolher o eixo e a ordem.
 *
 * As três perguntas ficam separadas de propósito, porque são de naturezas
 * diferentes e misturá-las é o que torna uma barra de filtros incompreensível:
 * *o que eu quero ver* (busca e filtros), *de que ângulo* (modo) e *em que
 * ordem*. Quando "Kanban" e "Atrasadas" dividem a mesma fileira de botões, nada
 * na tela indica que um troca o formato e o outro esconde demandas.
 */
export function BoardToolbar(props: BoardToolbarProps) {
  const { filters, onFilters } = props;
  const [term, setTerm] = useState(filters.query);
  const [lastQuery, setLastQuery] = useState(filters.query);

  /* A caixa é o dono do texto enquanto se digita; o recorte só recebe o termo
     quando a digitação para. Sem isso, cada tecla refaz o agrupamento do quadro
     inteiro — e num quadro de quinhentas demandas isso aparece como atraso
     entre a tecla e a letra. */
  useEffect(() => {
    if (term === filters.query) return;
    const timer = window.setTimeout(() => onFilters({ ...filters, query: term }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [term, filters, onFilters]);

  /* O caminho de volta: quando o recorte é limpo de fora — indicador, preset,
     "Limpar", endereço colado —, a caixa precisa acompanhar. O ajuste acontece
     durante a renderização, comparando com o valor anterior, e não num efeito:
     um efeito faria a caixa mostrar o termo antigo por um quadro antes de
     apagá-lo, e quem estivesse digitando veria a letra voltar. */
  if (filters.query !== lastQuery) {
    setLastQuery(filters.query);
    if (filters.query === "" && term !== "") setTerm("");
  }

  const ativos = activeFilterCount(filters);
  const presets = presetViews(props.currentMemberName);
  const presetLigado = (preset: ReturnType<typeof presetViews>[number]) =>
    (Object.entries(preset.filters) as Array<[keyof DemandFilters, string]>)
      .every(([key, value]) => filters[key] === value);

  const set = (patch: Partial<DemandFilters>) => onFilters({ ...filters, ...patch });

  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarTop}>
        <label className={styles.search}>
          <Search aria-hidden="true" />
          <input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Buscar demanda, colaborador, empresa ou protocolo"
            aria-label="Buscar no quadro"
          />
        </label>

        <div className={styles.modes} role="group" aria-label="Modo de visualização">
          {MODES.map((mode) => {
            const Icon = mode.icon;
            return (
              <button
                key={mode.id}
                type="button"
                title={mode.hint}
                className={styles.mode}
                data-active={props.mode === mode.id || undefined}
                aria-pressed={props.mode === mode.id}
                onClick={() => props.onMode(mode.id)}
              >
                <Icon aria-hidden="true" />{mode.label}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className={styles.focusToggle}
          data-active={props.focusMode || undefined}
          aria-pressed={props.focusMode}
          onClick={() => props.onFocusMode(!props.focusMode)}
          title="Esconder o que não é o quadro e trabalhar a fila inteira"
        >
          <Focus aria-hidden="true" />Focar
        </button>
      </div>

      <div className={styles.toolbarBottom}>
        <div className={styles.presets} role="group" aria-label="Recortes rápidos">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={styles.preset}
              data-active={presetLigado(preset) || undefined}
              aria-pressed={presetLigado(preset)}
              onClick={() => {
                if (presetLigado(preset)) {
                  const desfeito = { ...filters };
                  for (const key of Object.keys(preset.filters) as Array<keyof DemandFilters>) {
                    desfeito[key] = defaultDemandFilters[key];
                  }
                  onFilters(desfeito);
                  return;
                }
                onFilters({ ...filters, ...preset.filters });
                if (preset.mode) props.onMode(preset.mode);
              }}
            >
              {preset.label}
            </button>
          ))}
          {props.savedViews.map((view) => (
            <span key={view.id} className={styles.savedView}>
              <button type="button" onClick={() => props.onApplyView(view)}>{view.name}</button>
              <button type="button" onClick={() => props.onRemoveView(view.id)} aria-label={`Remover a visualização ${view.name}`}>
                <X aria-hidden="true" />
              </button>
            </span>
          ))}
          <button type="button" className={styles.saveView} onClick={props.onSaveView} title="Guardar este recorte em Meus filtros">
            <BookmarkPlus aria-hidden="true" />Salvar recorte
          </button>
        </div>

        {props.mode === "kanban" && (
          <details className={styles.filters}>
            <summary><Settings2 aria-hidden="true" />Exibição</summary>
            <div className={styles.filterFields}>
              <label><span>Densidade</span>
                <select value={props.density} onChange={(event) => props.onDensity(event.target.value as "comfortable" | "compact")}>
                  <option value="comfortable">Confortável</option>
                  <option value="compact">Compacto</option>
                </select>
              </label>
              <label><span>Agrupar por</span>
                <select value={props.groupBy} onChange={(event) => props.onGroupBy(event.target.value as "none" | "company" | "assignee")}>
                  <option value="none">Sem agrupamento</option>
                  <option value="company">Empresa</option>
                  <option value="assignee">Responsável</option>
                </select>
              </label>
            </div>
          </details>
        )}

        <details className={styles.filters}>
          <summary>
            <SlidersHorizontal aria-hidden="true" />Filtros{ativos > 0 && <b>{ativos}</b>}
          </summary>
          <div className={styles.filterFields}>
            <label><span>Empresa</span>
              <select value={filters.companyId} onChange={(event) => set({ companyId: event.target.value })}>
                <option value="all">Todas</option>
                {props.companies.map((company) => (
                  <option key={company.id} value={company.id}>{company.tradeName || company.legalName}</option>
                ))}
              </select>
            </label>
            <label><span>Processo</span>
              <select value={filters.processType} onChange={(event) => set({ processType: event.target.value })}>
                <option value="all">Todos</option>
                {props.processTypes.map((process) => <option key={process}>{process}</option>)}
              </select>
            </label>
            <label><span>Situação</span>
              <select value={filters.listId} onChange={(event) => set({ listId: event.target.value })}>
                <option value="all">Todas as etapas</option>
                {props.lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
              </select>
            </label>
            <label><span>Responsável</span>
              <select value={filters.assignee} onChange={(event) => set({ assignee: event.target.value })}>
                <option value="all">Todos</option>
                <option value="none">Sem responsável</option>
                {props.members
                  .filter((member) => member.role === "admin" || member.role === "member")
                  .map((member) => <option key={member.userId} value={member.name}>{member.name}</option>)}
              </select>
            </label>
            <label><span>Prioridade</span>
              <select value={filters.priority} onChange={(event) => set({ priority: event.target.value })}>
                <option value="all">Todas</option>
                <option value="urgent">Urgente</option>
                <option value="high">Alta</option>
                <option value="normal">Normal</option>
                <option value="low">Baixa</option>
              </select>
            </label>
            <label><span>Prazo</span>
              <select value={filters.due} onChange={(event) => set({ due: event.target.value })}>
                <option value="all">Todos</option>
                <option value="today">Vence hoje</option>
                <option value="week">Próximos 7 dias</option>
                <option value="overdue">Já atrasados</option>
              </select>
            </label>
            <label><span>SLA</span>
              <select value={filters.sla} onChange={(event) => set({ sla: event.target.value })}>
                <option value="all">Todos</option>
                <option value="safe">No prazo</option>
                <option value="warning">Vence hoje</option>
                <option value="overdue">Atrasado</option>
                <option value="paused">Aguardando retorno</option>
                <option value="completed">Concluído</option>
              </select>
            </label>
            <label><span>Competência</span>
              <select value={filters.competence} onChange={(event) => set({ competence: event.target.value })}>
                <option value="">Todas</option>
                {props.competences.map((competence) => <option key={competence}>{competence}</option>)}
              </select>
            </label>
          </div>
        </details>

        <label className={styles.sort}>
          <span>Ordenar</span>
          <select value={props.sort} onChange={(event) => props.onSort(event.target.value as DemandSort)}>
            {SORTS.map((sort) => <option key={sort.id} value={sort.id}>{sort.label}</option>)}
          </select>
        </label>

        {ativos > 0 && (
          <button type="button" className={styles.clear} onClick={() => { setTerm(""); onFilters({ ...defaultDemandFilters }); }}>
            Limpar
          </button>
        )}

        {/* O arquivo continua a um clique do quadro. Ele saiu da fileira de
            formatos porque não é um formato — é outro conjunto de demandas. */}
        <button type="button" className={styles.archive} onClick={props.onOpenArchive}>
          <Archive aria-hidden="true" />Arquivadas <b>{props.archivedCount}</b>
        </button>
      </div>
    </div>
  );
}
