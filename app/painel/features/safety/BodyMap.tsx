"use client";

import { useCallback, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { accidentBodyPartLabels, type AccidentBodyPart, type AccidentSlice } from "@/lib/work-accidents";
import styles from "./safety.module.css";

/**
 * O corpo humano em três dimensões, com as regiões atingidas.
 *
 * A figura gira. Isso não é enfeite: **região lombar e costas só existem por
 * trás**, e um mapa plano de frente precisava desenhá-las por cima do abdômen —
 * duas regiões diferentes no mesmo lugar, que é exatamente o que o mapa existe
 * para separar. Virar o boneco mostra a lombar onde ela está e some com o rosto,
 * que é o que acontece quando se olha alguém pelas costas.
 *
 * ## Como o giro funciona, e por que não há biblioteca 3D
 *
 * São duas ilustrações — de frente e de perfil — montadas como planos reais
 * dentro de um palco com `perspective`, um a 0° e outro a 90°. O palco gira, os
 * dois planos giram junto com ele, e a opacidade de cada um acompanha o ângulo:
 * de frente só a silhueta frontal aparece, de lado só o perfil, e no caminho os
 * dois se sobrepõem já deformados pela perspectiva. É um turntable, a mesma
 * técnica de vitrine de produto — e ele dá o que primitivas geométricas não dão:
 * **anatomia**. Ombro que cai, cintura, panturrilha, pé que aponta para a frente.
 *
 * A primeira versão montou o corpo com cilindros e esferas cruzados. Girava, e
 * era honesta, mas lia como manequim de articulações — e o que este painel
 * precisa é que alguém reconheça o próprio corpo de relance.
 *
 * Nada disso custa dependência: são dois `<svg>` e uma rotação em CSS. Nenhuma
 * biblioteca entra no pacote nem no `npm audit`, e a cor continua vindo dos
 * tokens do painel, de modo que o tema escuro sai de graça.
 *
 * A luz é uma camada só, por cima de toda a silhueta: um degradê de claro em
 * cima à esquerda para escuro embaixo à direita. Ela dá volume sem exigir
 * sombreado desenhado região por região, e gira junto com a ilustração.
 *
 * ## O que a figura mostra
 *
 * Regiões sem acidente ficam no tom neutro do painel; as atingidas recebem o
 * acento com intensidade proporcional à participação, de modo que a mão que
 * concentra 40% dos casos se destaque da que teve um caso isolado.
 *
 * "Múltiplas regiões" e "Demais" não têm lugar no desenho e aparecem apenas na
 * legenda: pintar o corpo inteiro por causa delas apagaria a informação que o
 * mapa existe para dar.
 *
 * Para o leitor de tela a ilustração é decorativa (`aria-hidden`): os números
 * estão escritos na legenda ao lado, e girar um desenho não acrescenta nada a
 * quem não o vê. Os botões de vista existem porque arrastar com o mouse não pode
 * ser o único caminho até as costas.
 */

/** Regiões desenhadas uma vez, no eixo do corpo. */
const FRONT_CENTER: Partial<Record<AccidentBodyPart, string>> = {
  skull: "M110 6c14 0 21 11 21 25 0 10-3 18-9 24H98c-6-6-9-14-9-24 0-14 7-25 21-25Z",
  face: "M110 25c8 0 13 6 13 14 0 8-6 14-13 14s-13-6-13-14c0-8 5-14 13-14Z",
  eyes: "M104 34a3.2 2.2 0 1 1 .1 0Zm12 0a3.2 2.2 0 1 1 .1 0Z",
  neck: "M99 49h22l2 19H97l2-19Z",
  chest: "M92 63h36c12 4 20 14 22 28l-3 33H73l-3-33c2-14 10-24 22-28Z",
  abdomen: "M76 120h68c-2 14-5 26-7 38H83c-2-12-5-24-7-38Z",
  /* A faixa das costas só existe quando o boneco está virado, e é por isso que
     o mapa gira: de frente ela ocuparia o mesmo lugar do abdômen. */
  lumbar: "M79 126h62c-1 14-3 24-5 34H84c-2-10-4-20-5-34Z",
  hip: "M82 154h56c4 14 4 32 0 46H82c-4-14-4-32 0-46Z",
};

/** Regiões pares: desenhadas uma vez e espelhadas no eixo do corpo. */
const FRONT_SIDE: Partial<Record<AccidentBodyPart, string>> = {
  shoulder: "M70 78c4-8 12-13 22-13l4 19c-10 2-16 6-20 12l-6-18Z",
  arm: "M70 80c-8 8-11 22-12 38l-2 52c-1 14 0 26 3 38h16c2-12 1-24 2-38l2-52c1-16 1-30 3-38H70Z",
  elbow: "M67 128a11 13 0 1 1 .1 0Z",
  hand: "M58 202c-5 8-5 22 1 30 6 7 15 5 18-3 2-9 1-20-1-27H58Z",
  fingers: "M59 228c-1 10 4 17 10 16 6-1 9-7 8-15l-1-6-17 5Z",
  leg: "M84 192c-4 16-4 38-2 58l4 48c1 18 2 38 4 50h16c1-12 0-32-1-50l-2-48c0-20 0-42-2-58H84Z",
  knee: "M94 260a12 13 0 1 1 .1 0Z",
  foot: "M88 342c-4 8-4 18 2 20h18c4-2 3-12-1-20H88Z",
  toes: "M88 356c-2 6 0 10 6 10h12c4-1 5-5 3-10H88Z",
};

/**
 * O perfil.
 *
 * Aqui não há espelho: de lado, o braço e a perna do outro lado ficam atrás e a
 * silhueta é uma só. O peito avança, a lombar recua e o pé aponta para a frente
 * — são esses três detalhes que fazem o perfil parecer uma pessoa de lado, e não
 * a mesma figura mais estreita.
 */
const PROFILE: Partial<Record<AccidentBodyPart, string>> = {
  skull: "M105 7c12-2 22 8 22 23 0 10-4 18-10 23h-17c-6-6-9-14-9-23 0-14 4-22 14-23Z",
  face: "M115 24c6 2 9 8 9 15 0 8-4 13-9 13h-4c-3-5-3-19 0-24l4-4Zm9 9 9 4-9 6v-10Z",
  eyes: "M118 34a3 2.1 0 1 1 .1 0Z",
  neck: "M102 49h17l2 19h-21l2-19Z",
  chest: "M96 65c12-5 24 0 30 11 3 15 3 31 0 47H94c-2-16-2-40 2-58Z",
  abdomen: "M94 118h32c-1 16-4 28-6 40H99c-3-12-5-24-5-40Z",
  lumbar: "M90 128h13c0 16-1 26-2 33H91c-3-10-3-22-1-33Z",
  hip: "M94 154h28c6 14 6 32 2 46H93c-7-14-6-32 1-46Z",
  arm: "M100 78c-6 8-8 24-8 40l-1 52c-1 14 0 26 3 38h16c2-12 1-24 2-38l2-52c0-16-1-30-4-40h-10Z",
  elbow: "M101 128a11 13 0 1 1 .1 0Z",
  hand: "M92 202c-5 8-5 22 1 30 6 7 15 5 18-3 2-9 1-20-1-27H92Z",
  fingers: "M93 228c-1 10 4 17 10 16 6-1 9-7 8-15l-1-6-17 5Z",
  leg: "M95 192c-4 16-4 38-2 58l4 48c1 18 2 38 4 50h16c1-12 0-32-1-50l-2-48c0-20-1-42-3-58H95Z",
  knee: "M104 260a12 13 0 1 1 .1 0Z",
  foot: "M96 342c-4 8-4 18 2 20h34c5 0 5-8-2-12l-18-8H96Z",
  toes: "M120 354c8 0 16 3 17 7 1 4-4 6-11 6l-12-2 6-11Z",
};

/** Ordem de pintura: o que está por cima na anatomia vem por último. */
const ORDER: AccidentBodyPart[] = [
  "leg", "knee", "foot", "toes", "hip", "lumbar", "abdomen", "chest",
  "arm", "elbow", "hand", "fingers", "shoulder", "neck", "skull", "face", "eyes",
];

const VIEWS = [
  { label: "Frente", angle: 0 },
  { label: "Lado", angle: 90 },
  { label: "Costas", angle: 180 },
] as const;

/** Menor giro que leva de um ângulo ao outro: virar 10° não pode dar a volta. */
function shortestTurn(from: number, to: number) {
  const delta = ((to - from) % 360 + 540) % 360 - 180;
  return from + delta;
}

/** A vista que o ângulo atual está mostrando, para marcar o botão certo. */
function currentView(spin: number) {
  const normalized = ((spin % 360) + 360) % 360;
  const nearest = VIEWS.reduce((best, view) => {
    const distance = Math.min(Math.abs(normalized - view.angle), 360 - Math.abs(normalized - view.angle));
    return distance < best.distance ? { angle: view.angle, distance } : best;
  }, { angle: -1, distance: Infinity });
  return nearest.distance <= 40 ? nearest.angle : -1;
}

type RegionStyle = (part: AccidentBodyPart) => { "data-active"?: string; style?: CSSProperties };

function Silhouette({ view, facing, region }: {
  view: "front" | "profile";
  /** De costas o rosto some e a lombar aparece: é o corpo, não o desenho. */
  facing: "front" | "back";
  region: RegionStyle;
}) {
  const center: Partial<Record<AccidentBodyPart, string>> = view === "front" ? FRONT_CENTER : PROFILE;
  const pairs: Partial<Record<AccidentBodyPart, string>> = view === "front" ? FRONT_SIDE : {};
  const parts = ORDER
    .filter((part) => center[part] || pairs[part])
    .filter((part) => (facing === "back" ? part !== "face" && part !== "eyes" : part !== "lumbar"));

  const shapes = (part: AccidentBodyPart, fill?: string) => <>
    {center[part] ? <path d={center[part]} fill={fill} /> : null}
    {pairs[part] ? <path d={pairs[part]} fill={fill} /> : null}
    {pairs[part] ? <path d={pairs[part]} fill={fill} transform="translate(220 0) scale(-1 1)" /> : null}
  </>;

  return <svg viewBox="0 0 220 380" className={styles.bodyArt} aria-hidden="true">
    <defs>
      <linearGradient id={`body-light-${view}`} x1="0" y1="0" x2="0.85" y2="1">
        <stop offset="0%" className={styles.lightTop} />
        <stop offset="48%" className={styles.lightMiddle} />
        <stop offset="100%" className={styles.lightBottom} />
      </linearGradient>
    </defs>
    {parts.map((part) => <g key={part} className={styles.bodyRegion} {...region(part)}>{shapes(part)}</g>)}
    {/* A luz vem por cima de tudo, em uma camada só: volume sem sombrear região
        por região, e sem inventar cor — o degradê mistura com o que está abaixo. */}
    <g className={styles.bodyLight}>
      {parts.map((part) => <g key={part}>{shapes(part, `url(#body-light-${view})`)}</g>)}
    </g>
  </svg>;
}

export function BodyMap({ items }: { items: AccidentSlice[] }) {
  const [spin, setSpin] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startSpin: number } | null>(null);

  const shares = new Map(items.map((item) => [item.key as AccidentBodyPart, item]));
  const strongest = Math.max(1, ...items.map((item) => item.share));
  const view = currentView(spin);

  const region: RegionStyle = (part) => {
    const slice = shares.get(part);
    return {
      "data-active": slice ? "true" : undefined,
      style: slice ? { "--region-weight": `${0.34 + (slice.share / strongest) * 0.56}` } as CSSProperties : undefined,
    };
  };

  /* Quanto cada plano aparece. O expoente deixa a troca acontecer perto dos 45°,
     em vez de arrastar os dois meio transparentes por todo o giro — dois
     desenhos a 50% leem como fantasma, não como volume. */
  const radians = (spin * Math.PI) / 180;
  const frontOpacity = Math.abs(Math.cos(radians)) ** 2.2;
  const sideOpacity = Math.abs(Math.sin(radians)) ** 2.2;
  const facing: "front" | "back" = Math.cos(radians) < 0 ? "back" : "front";

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startSpin: spin };
    setDragging(true);
  }, [spin]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    // Meio grau por pixel: a volta inteira cabe num arrasto de tela.
    setSpin(current.startSpin + (event.clientX - current.startX) * 0.6);
  }, []);

  const onPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
  }, []);

  return <div className={styles.bodyMap}>
    <div className={styles.bodyViewport}>
      <div
        className={styles.bodyStage}
        style={{ "--spin": `${spin}deg` } as CSSProperties}
        data-dragging={dragging ? "true" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        aria-hidden="true"
      >
        <div className={styles.bodyFloor} />
        <div className={styles.bodyPlane} data-plane="front" style={{ opacity: frontOpacity }}>
          <Silhouette view="front" facing={facing} region={region} />
        </div>
        <div className={styles.bodyPlane} data-plane="side" style={{ opacity: sideOpacity }}>
          <Silhouette view="profile" facing={facing} region={region} />
        </div>
      </div>
    </div>

    <div className={styles.bodyViews} role="group" aria-label="Vista do corpo">
      {VIEWS.map((item) => <button
        key={item.label}
        type="button"
        className={styles.chip}
        data-selected={view === item.angle}
        aria-pressed={view === item.angle}
        onClick={() => setSpin((current) => shortestTurn(current, item.angle))}
      >{item.label}</button>)}
      <span className={styles.bodyHint}>arraste para girar</span>
    </div>

    <ul className={styles.bodyLegend}>
      {items.map((item) => <li key={item.key}>
        <span>{accidentBodyPartLabels[item.key as AccidentBodyPart] ?? item.label}</span>
        <b>{item.share}%</b>
        <small>{item.total}</small>
      </li>)}
    </ul>
  </div>;
}
