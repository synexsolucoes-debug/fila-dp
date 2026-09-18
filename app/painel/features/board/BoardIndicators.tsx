"use client";

import { AlertTriangle, Info, TriangleAlert } from "lucide-react";
import type { BoardAlert, DemandFilters, DemandIndicators, IndicatorId } from "./board.model";
import { indicatorFilters } from "./board.model";
import styles from "./board.module.css";

const ORDER: Array<{ id: IndicatorId; label: string; tone: string }> = [
  { id: "open", label: "abertas", tone: "neutral" },
  { id: "unassigned", label: "sem responsável", tone: "info" },
  { id: "dueToday", label: "vencem hoje", tone: "warn" },
  { id: "overdue", label: "atrasadas", tone: "danger" },
  { id: "completed", label: "concluídas", tone: "ok" },
  { id: "critical", label: "SLA crítico", tone: "danger" },
];

const ALERT_ICON = { danger: TriangleAlert, warn: AlertTriangle, info: Info } as const;

/**
 * A faixa de indicadores, e a faixa de alertas logo abaixo dela.
 *
 * Cada número é um botão que abre o próprio recorte, e clicar de novo desfaz.
 * A alternativa — informar e deixar a pessoa remontar o filtro na mão — é a que
 * o painel tinha, e a reconstrução manual quase nunca batia com a conta: o
 * indicador dizia sete atrasadas e o filtro montado a seguir mostrava nove.
 *
 * "Abertas" é o estado de repouso e por isso nunca fica marcado: o que ele faz
 * é desfazer, e é o caminho de volta quando qualquer outro está ligado.
 */
export function BoardIndicators({ indicators, filters, alerts, onToggle, onAlert }: {
  indicators: DemandIndicators;
  filters: DemandFilters;
  alerts: readonly BoardAlert[];
  onToggle: (indicator: IndicatorId) => void;
  onAlert: (alert: BoardAlert) => void;
}) {
  const ligado = (id: IndicatorId) => {
    if (id === "open") return false;
    const alvo = indicatorFilters[id];
    return (Object.entries(alvo) as Array<[keyof DemandFilters, string]>)
      .every(([key, value]) => filters[key] === value);
  };

  return <>
    <div className={styles.indicators} role="group" aria-label="Indicadores operacionais">
      {ORDER.map((item) => (
        <button
          key={item.id}
          type="button"
          className={styles.indicator}
          data-tone={item.tone}
          data-active={ligado(item.id) || undefined}
          aria-pressed={item.id === "open" ? undefined : ligado(item.id)}
          onClick={() => onToggle(item.id)}
        >
          <strong>{indicators[item.id]}</strong>
          <span>{item.label}</span>
        </button>
      ))}
    </div>

    {alerts.length > 0 && (
      <div className={styles.alerts} role="status">
        {alerts.map((alert) => {
          const Icon = ALERT_ICON[alert.tone];
          const Elemento = alert.filters ? "button" : "span";
          return (
            <Elemento
              key={alert.id}
              className={styles.alert}
              data-tone={alert.tone}
              {...(alert.filters ? { type: "button" as const, onClick: () => onAlert(alert) } : {})}
            >
              <Icon aria-hidden="true" />
              {alert.text}
            </Elemento>
          );
        })}
      </div>
    )}
  </>;
}
