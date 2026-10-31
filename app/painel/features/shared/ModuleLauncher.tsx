"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Search, X } from "lucide-react";
import { VinculatoLogo } from "@/app/components/VinculatoLogo";

/** Como o launchpad do Fiori separa os tiles: pelo tipo de trabalho, não por ordem alfabética. */
export type LauncherSection = "process" | "area" | "support" | "system";

export type LauncherModule = {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  section: LauncherSection;
  /** Número vivo do tile (KPI tile do Fiori): o que está esperando por alguém naquele módulo. */
  metric?: { value: number; label: string; tone?: "neutral" | "attention" };
};

type ModuleLauncherProps = {
  userName: string;
  workspaceName: string;
  modules: readonly LauncherModule[];
  /** No tema escuro o logotipo azul-marinho fica ilegível. */
  theme: "light" | "dark";
  onOpen: (id: string) => void;
  /** Ausente na entrada depois do login: ali a escolha do módulo é o passo
   *  seguinte, e não há tela atrás da janela para onde voltar. */
  onClose?: () => void;
};

const sectionLabels: Record<LauncherSection, string> = {
  process: "Processos",
  area: "Áreas",
  support: "Apoio",
  system: "Sistemas",
};
const sectionOrder: readonly LauncherSection[] = ["process", "area", "system", "support"];

const numberFormat = new Intl.NumberFormat("pt-BR");

/** Busca sem acento e sem caixa: "ferias" acha "Férias". */
function normalize(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * Janela de módulos.
 *
 * É a porta de entrada depois do login e o atalho do topo do painel para trocar
 * de módulo. A lista chega pronta e já recortada pelo plano e pelo papel de
 * quem está olhando — esta janela só desenha. Um módulo que a pessoa não abre
 * não vira cartão, pelo mesmo motivo que não vira item de menu (§30).
 *
 * O desenho é o launchpad do Fiori (docs/engenharia-reversa-design-centi-sap.md
 * §2.2 e §7.2): tiles agrupados pelo tipo de trabalho, com o número vivo de
 * cada módulo, e um campo para quem já sabe o nome do que quer abrir.
 */
export function ModuleLauncher({ userName, workspaceName, modules, theme, onOpen, onClose }: ModuleLauncherProps) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!onClose) return;
    const close = onClose;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* Foco no campo só com mouse e teclado: no celular ele abriria o teclado
     virtual por cima dos tiles que a pessoa veio tocar. */
  useEffect(() => {
    if (modules.length > 4 && window.matchMedia("(pointer: fine)").matches) searchRef.current?.focus();
  }, [modules.length]);

  const filtered = useMemo(() => {
    const term = normalize(query.trim());
    if (!term) return modules;
    return modules.filter((module) => normalize(`${module.label} ${module.description}`).includes(term));
  }, [modules, query]);

  const sections = useMemo(() => sectionOrder
    .map((section) => ({ section, items: filtered.filter((module) => module.section === section) }))
    .filter((group) => group.items.length > 0), [filtered]);

  const firstName = userName.trim().split(/\s+/u)[0] || userName;
  const showSearch = modules.length > 4;

  return (
    <div className="module-launcher" role="dialog" aria-modal="true" aria-labelledby="module-launcher-title">
      <div className="module-launcher-panel">
        <header className="module-launcher-head">
          <VinculatoLogo size={30} tone={theme === "dark" ? "light" : "color"} priority />
          <span className="module-launcher-workspace" title={workspaceName}>{workspaceName}</span>
          {onClose && <button type="button" className="module-launcher-close" onClick={onClose} aria-label="Fechar janela de módulos">
            <X aria-hidden="true" />
          </button>}
        </header>

        <div className="module-launcher-intro">
          <h1 id="module-launcher-title">Olá, {firstName}. Qual módulo você quer abrir?</h1>
          <p>Aparecem aqui apenas os módulos liberados para o seu acesso.</p>
        </div>

        {showSearch && <label className="module-launcher-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Buscar módulo</span>
          <input ref={searchRef} type="search" value={query} placeholder="Buscar módulo"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && filtered.length > 0) {
                event.preventDefault();
                onOpen(filtered[0].id);
              }
            }} />
          {query && <kbd aria-hidden="true">Enter abre {filtered[0]?.label ?? "—"}</kbd>}
        </label>}

        {modules.length === 0 ? (
          <p className="module-launcher-empty">Nenhum módulo foi liberado para o seu acesso. Fale com o administrador do seu grupo.</p>
        ) : sections.length === 0 ? (
          <p className="module-launcher-empty" role="status">Nenhum módulo com “{query.trim()}”.</p>
        ) : sections.map(({ section, items }) => (
          <section key={section} className="module-launcher-section" aria-labelledby={`module-launcher-${section}`}>
            <h2 id={`module-launcher-${section}`}>{sectionLabels[section]}</h2>
            <ul className="module-launcher-grid">
              {items.map((module) => {
                const Icon = module.icon;
                const metric = module.metric;
                return (
                  <li key={module.id}>
                    <button type="button" onClick={() => onOpen(module.id)}
                      aria-label={metric ? `${module.label}: ${numberFormat.format(metric.value)} ${metric.label}` : module.label}>
                      <span className="module-launcher-icon"><Icon aria-hidden="true" /></span>
                      <strong>{module.label}</strong>
                      <small className="module-launcher-description">{module.description}</small>
                      {metric && <span className="module-launcher-metric" data-tone={metric.value > 0 ? metric.tone ?? "neutral" : "neutral"} aria-hidden="true">
                        <b>{numberFormat.format(metric.value)}</b> {metric.label}
                      </span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
