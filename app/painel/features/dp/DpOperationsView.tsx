"use client";

import { useState } from "react";
import { WeekTab } from "./WeekTab";
import { CalendarTab } from "./CalendarTab";
import { OccurrencesTab } from "./OccurrencesTab";
import { AlertsTab } from "./AlertsTab";
import { DashboardTab } from "./DashboardTab";
import { SettingsTab } from "./SettingsTab";
import styles from "./dp.module.css";

/**
 * DP Operacional (Fases 2 a 5): a semana de cada analista, o calendário do
 * mês, as ocorrências fora do prazo de corte, os alertas do Sankhya e o painel
 * da gestão. A aba vai no endereço (`?aba=`) para o link levar direto a ela.
 */
const TABS = [
  { id: "semana", label: "Minha semana" },
  { id: "calendario", label: "Calendário" },
  { id: "ocorrencias", label: "Ocorrências" },
  { id: "alertas", label: "Alertas" },
  { id: "painel", label: "Painel" },
  { id: "rotinas", label: "Rotinas e regras" },
] as const;
type TabId = typeof TABS[number]["id"];

export function DpOperationsView({ canManage, initialTab = "" }: { canManage: boolean; initialTab?: string }) {
  const [tab, setTab] = useState<TabId>(() => TABS.find((item) => item.id === initialTab)?.id ?? "semana");

  function select(next: TabId) {
    setTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("aba", next);
    window.history.replaceState(window.history.state, "", url);
  }

  return <div className={styles.root}>
    <div className={styles.tabs} role="tablist" aria-label="DP Operacional">
      {TABS.map((item) => <button key={item.id} type="button" role="tab" id={`dp-tab-${item.id}`} aria-selected={tab === item.id}
        aria-controls={`dp-panel-${item.id}`} className={styles.tab} onClick={() => select(item.id)}>{item.label}</button>)}
    </div>
    <div role="tabpanel" id={`dp-panel-${tab}`} aria-labelledby={`dp-tab-${tab}`}>
      {tab === "semana" && <WeekTab />}
      {tab === "calendario" && <CalendarTab canManage={canManage} />}
      {tab === "ocorrencias" && <OccurrencesTab canManage={canManage} />}
      {tab === "alertas" && <AlertsTab canManage={canManage} />}
      {tab === "painel" && <DashboardTab canManage={canManage} />}
      {tab === "rotinas" && <SettingsTab canManage={canManage} />}
    </div>
  </div>;
}
