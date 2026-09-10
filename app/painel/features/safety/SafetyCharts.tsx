"use client";

import type { CSSProperties } from "react";
import { accidentBodyPartLabels, type AccidentBodyPart, type AccidentSlice } from "@/lib/work-accidents";
import styles from "./safety.module.css";

/**
 * Os gráficos do dashboard, em SVG escrito à mão.
 *
 * O produto não tem biblioteca de gráficos, e este módulo não é motivo para
 * adicionar uma: são quatro formas — rosca, linha de doze pontos, barra
 * horizontal e mapa do corpo — e todas cabem em SVG que herda os tokens de cor
 * do painel. Uma biblioteca traria tema próprio, e o dashboard passaria a
 * destoar do resto do produto no modo escuro.
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
    <table className={styles.srOnly}>
      <caption>Acidentes por mês no período selecionado</caption>
      <thead><tr><th scope="col">Mês</th><th scope="col">Acidentes</th></tr></thead>
      <tbody>{points.map((point) => <tr key={point.month}><th scope="row">{point.label}</th><td>{point.total}</td></tr>)}</tbody>
    </table>
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

/**
 * O corpo humano com as regiões atingidas.
 *
 * A figura é simplificada de propósito — cabeça, tronco, membros e as
 * articulações que aparecem na CAT — porque o objetivo é ler o padrão de
 * lesão de longe, não desenhar anatomia. Regiões sem acidente ficam no tom
 * neutro do painel; as atingidas recebem o acento com intensidade proporcional
 * à participação, de modo que a mão que concentra 40% dos casos se destaque da
 * que teve um caso isolado.
 *
 * "Múltiplas regiões" e "Demais" não têm lugar no desenho e aparecem apenas na
 * legenda: pintar o corpo inteiro por causa delas apagaria a informação que o
 * mapa existe para dar.
 */
export function BodyMap({ items }: { items: AccidentSlice[] }) {
  const shares = new Map(items.map((item) => [item.key as AccidentBodyPart, item]));
  const strongest = Math.max(1, ...items.map((item) => item.share));
  const region = (part: AccidentBodyPart) => {
    const slice = shares.get(part);
    return {
      "data-active": slice ? "true" : undefined,
      style: slice ? { "--region-weight": `${0.3 + (slice.share / strongest) * 0.55}` } as CSSProperties : undefined,
    };
  };

  return <div className={styles.bodyMap}>
    <svg viewBox="0 0 220 366" className={styles.bodyFigure} aria-hidden="true">
      <g className={styles.bodyRegion} {...region("skull")}>
        <circle cx="110" cy="42" r="26" />
      </g>
      <g className={styles.bodyRegion} {...region("face")}>
        <ellipse cx="110" cy="52" rx="17" ry="13" />
      </g>
      <g className={styles.bodyRegion} {...region("eyes")}>
        <ellipse cx="102" cy="40" rx="4.5" ry="2.8" />
        <ellipse cx="118" cy="40" rx="4.5" ry="2.8" />
      </g>
      <g className={styles.bodyRegion} {...region("neck")}>
        <rect x="101" y="64" width="18" height="18" rx="6" />
      </g>
      <g className={styles.bodyRegion} {...region("shoulder")}>
        <circle cx="76" cy="94" r="13" />
        <circle cx="144" cy="94" r="13" />
      </g>
      <g className={styles.bodyRegion} {...region("chest")}>
        <rect x="82" y="82" width="56" height="54" rx="16" />
      </g>
      <g className={styles.bodyRegion} {...region("abdomen")}>
        <rect x="85" y="136" width="50" height="32" rx="12" />
      </g>
      <g className={styles.bodyRegion} {...region("lumbar")}>
        <rect x="85" y="168" width="50" height="18" rx="8" />
      </g>
      <g className={styles.bodyRegion} {...region("hip")}>
        <rect x="81" y="186" width="58" height="28" rx="14" />
      </g>
      <g className={styles.bodyRegion} {...region("arm")}>
        <rect x="60" y="96" width="16" height="100" rx="8" />
        <rect x="144" y="96" width="16" height="100" rx="8" />
      </g>
      <g className={styles.bodyRegion} {...region("elbow")}>
        <circle cx="68" cy="150" r="8" />
        <circle cx="152" cy="150" r="8" />
      </g>
      <g className={styles.bodyRegion} {...region("hand")}>
        <ellipse cx="68" cy="206" rx="11" ry="13" />
        <ellipse cx="152" cy="206" rx="11" ry="13" />
      </g>
      <g className={styles.bodyRegion} {...region("fingers")}>
        <ellipse cx="68" cy="222" rx="9" ry="6" />
        <ellipse cx="152" cy="222" rx="9" ry="6" />
      </g>
      <g className={styles.bodyRegion} {...region("leg")}>
        <rect x="88" y="212" width="18" height="118" rx="9" />
        <rect x="114" y="212" width="18" height="118" rx="9" />
      </g>
      <g className={styles.bodyRegion} {...region("knee")}>
        <circle cx="97" cy="278" r="9" />
        <circle cx="123" cy="278" r="9" />
      </g>
      <g className={styles.bodyRegion} {...region("foot")}>
        <ellipse cx="97" cy="338" rx="13" ry="9" />
        <ellipse cx="123" cy="338" rx="13" ry="9" />
      </g>
      <g className={styles.bodyRegion} {...region("toes")}>
        <ellipse cx="97" cy="350" rx="11" ry="5" />
        <ellipse cx="123" cy="350" rx="11" ry="5" />
      </g>
    </svg>
    <ul className={styles.bodyLegend}>
      {items.map((item) => <li key={item.key}>
        <span>{accidentBodyPartLabels[item.key as AccidentBodyPart] ?? item.label}</span>
        <b>{item.share}%</b>
        <small>{item.total}</small>
      </li>)}
    </ul>
  </div>;
}
