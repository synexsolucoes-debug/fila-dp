"use client";

import type { CSSProperties } from "react";
import type { AccidentSlice } from "@/lib/work-accidents";
import styles from "./safety.module.css";

/**
 * Os gráficos do dashboard, em SVG escrito à mão.
 *
 * O produto não tem biblioteca de gráficos, e este módulo não é motivo para
 * adicionar uma: são três formas — rosca, linha de doze pontos e barra
 * horizontal — e todas cabem em SVG que herda os tokens de cor do painel. Uma
 * biblioteca traria tema próprio, e o dashboard passaria a destoar do resto do
 * produto no modo escuro. O mapa do corpo, que é tridimensional e por isso não
 * cabe aqui, mora em `BodyMap.tsx` — e segue a mesma regra.
 *
 * Toda forma aqui é decorativa para o leitor de tela (`aria-hidden`): o número
 * que ela representa está escrito ao lado, em texto. Um gráfico que só existe
 * como desenho é um dado que parte das pessoas não recebe.
 */

/** Rosca de uma fatia só: o percentual do tipo sobre o total do período. */
export function DonutRing({ share, label }: { share: number; label: string }) {
  const circumference = 2 * Math.PI * 16;
  const filled = (Math.max(0, Math.min(100, share)) / 100) * circumference;
  return <span className={styles.donut} role="img" aria-label={`${label}: ${share}%`}>
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="16" className={styles.donutTrack} />
      <circle cx="20" cy="20" r="16" className={styles.donutValue}
        strokeDasharray={`${filled} ${circumference - filled}`} strokeDashoffset={circumference / 4} />
    </svg>
    <b>{share}%</b>
  </span>;
}

/**
 * A série do ano, com os doze meses sempre presentes.
 *
 * Mês sem acidente é ponto no zero, e não buraco na linha: o buraco sugere
 * "não medimos", e o zero afirma "não houve" — que é justamente o que o SESMT
 * quer poder mostrar.
 */
export function MonthSeries({ points }: { points: Array<{ month: number; label: string; total: number }> }) {
  const max = Math.max(1, ...points.map((point) => point.total));
  const step = 332 / (points.length - 1 || 1);
  const coordinates = points.map((point, index) => ({
    ...point,
    x: 14 + index * step,
    y: 106 - (point.total / max) * 78,
  }));
  const line = coordinates.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");

  return <div className={styles.series}>
    <svg viewBox="0 0 360 140" className={styles.seriesChart} aria-hidden="true">
      <polyline className={styles.seriesLine} points={line} />
      {coordinates.map((point) => <g key={point.month}>
        <circle className={styles.seriesDot} cx={point.x} cy={point.y} r="4" />
        <text className={styles.seriesValue} x={point.x} y={point.y - 10} textAnchor="middle">{point.total}</text>
        <text className={styles.seriesLabel} x={point.x} y="130" textAnchor="middle">{point.label}</text>
      </g>)}
    </svg>
    {/* A tabela é a versão em texto da linha, para quem não vê o desenho. Ela
        vai dentro de um invólucro escondido, e não escondida ela mesma:
        `width: 1px` não encolhe uma `<table>` — ela se dimensiona pelo conteúdo
        e escapava da página, empurrando 23px de rolagem horizontal no painel
        inteiro em 1024px. Um `<div>` recorta; uma tabela, não. */}
    <div className={styles.srOnly}>
      <table>
        <caption>Acidentes por mês no período selecionado</caption>
        <thead><tr><th scope="col">Mês</th><th scope="col">Acidentes</th></tr></thead>
        <tbody>{points.map((point) => <tr key={point.month}><th scope="row">{point.label}</th><td>{point.total}</td></tr>)}</tbody>
      </table>
    </div>
  </div>;
}

/** Barras por setor, da maior para a menor, com o número escrito na ponta. */
export function SectorBars({ items }: { items: AccidentSlice[] }) {
  const max = Math.max(1, ...items.map((item) => item.total));
  return <ul className={styles.bars}>
    {items.map((item) => <li key={item.key}>
      <span className={styles.barLabel} title={item.label}>{item.label}</span>
      <span className={styles.barTrack} aria-hidden="true">
        <i style={{ "--bar-width": `${(item.total / max) * 100}%` } as CSSProperties} />
      </span>
      <b>{item.total}</b>
    </li>)}
  </ul>;
}
