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
 * para separar. Aqui a lombar fica atrás do tronco, no eixo Z, e aparece quando
 * a pessoa vira o boneco.
 *
 * ## Por que sem biblioteca 3D
 *
 * Cada região é um punhado de planos cruzados girados em torno do próprio eixo,
 * dentro de um palco com `perspective` e `preserve-3d`. De qualquer ângulo pelo
 * menos um plano fica de frente para a câmera, então o volume nunca some — é o
 * mesmo truque das árvores de jogos antigos, e ele custa nada: nenhuma
 * dependência nova entra no pacote nem no `npm audit`, e a cor continua vindo
 * dos tokens do painel, de modo que o tema escuro sai de graça.
 *
 * O sombreado é o que vende o volume: cada plano recebe um degradê de luz para
 * sombra na mesma direção, como se houvesse uma lâmpada acima e à esquerda.
 * Luz e sombra são física, não marca — por isso são as únicas cores aqui que
 * não saem de um token, e mesmo assim entram como mistura sobre a cor da região.
 *
 * A figura é simplificada de propósito — cabeça, tronco, membros e as
 * articulações que aparecem na CAT — porque o objetivo é ler o padrão de lesão
 * de longe, não desenhar anatomia. Regiões sem acidente ficam no tom neutro do
 * painel; as atingidas recebem o acento com intensidade proporcional à
 * participação, de modo que a mão que concentra 40% dos casos se destaque da
 * que teve um caso isolado.
 *
 * "Múltiplas regiões" e "Demais" não têm lugar no desenho e aparecem apenas na
 * legenda: pintar o corpo inteiro por causa delas apagaria a informação que o
 * mapa existe para dar.
 *
 * Para o leitor de tela o boneco é decorativo (`aria-hidden`), como era o
 * desenho plano: os números estão escritos na legenda ao lado, e girar uma
 * figura não acrescenta nada a quem não a vê. Os botões de vista existem
 * porque arrastar com o mouse não pode ser o único jeito de chegar às costas.
 */

/** Um volume do boneco, no espaço do palco (220 × 372 pixels). */
type Volume = {
  part: AccidentBodyPart;
  /** Centro do volume. `x` é o lado esquerdo quando há espelho. */
  x: number;
  y: number;
  /** Profundidade: positivo à frente do tronco, negativo atrás dele. */
  z?: number;
  w: number;
  h: number;
  /** Planos cruzados. `1` é detalhe de frente — um rosto não existe nas costas. */
  planes?: number;
  radius?: string;
  /**
   * Quanto o volume é fundo em relação à própria largura.
   *
   * Sem isso todo volume teria seção circular e o tronco sairia cilíndrico: de
   * lado, o boneco ficava tão largo quanto de frente, que é a forma de um tambor
   * e não a de uma pessoa. O pé é o caso contrário — mais comprido do que largo,
   * e por isso passa de 1.
   */
  depth?: number;
  /** Membros e órgãos pares: o mesmo volume espelhado no eixo do corpo. */
  mirror?: boolean;
};

const STAGE_WIDTH = 220;

/* A ordem é a do corpo, de cima para baixo: quem for conferir a figura contra
   a lista de partes lê as duas na mesma sequência. */
const VOLUMES: readonly Volume[] = [
  { part: "skull", x: 110, y: 44, w: 54, h: 54, planes: 4, radius: "50%", depth: 0.94 },
  { part: "face", x: 110, y: 54, z: 20, w: 34, h: 28, planes: 1, radius: "50%" },
  { part: "eyes", x: 101, y: 42, z: 24, w: 10, h: 7, planes: 1, radius: "50%", mirror: true },
  { part: "neck", x: 110, y: 76, w: 20, h: 20, planes: 3, radius: "45%", depth: 0.9 },
  { part: "shoulder", x: 78, y: 96, w: 28, h: 28, planes: 4, radius: "50%", depth: 0.8, mirror: true },
  { part: "chest", x: 110, y: 112, w: 58, h: 58, planes: 4, radius: "28%", depth: 0.66 },
  { part: "abdomen", x: 110, y: 152, z: 6, w: 52, h: 34, planes: 3, radius: "32%", depth: 0.66 },
  // Atrás do tronco, e não sobre ele: é o que a rotação existe para mostrar.
  { part: "lumbar", x: 110, y: 174, z: -11, w: 46, h: 22, planes: 3, radius: "44%", depth: 0.45 },
  { part: "hip", x: 110, y: 198, w: 60, h: 32, planes: 4, radius: "42%", depth: 0.7 },
  { part: "arm", x: 68, y: 148, w: 17, h: 104, planes: 3, radius: "42%", mirror: true },
  { part: "elbow", x: 68, y: 152, z: 3, w: 19, h: 19, planes: 3, radius: "50%", mirror: true },
  { part: "hand", x: 68, y: 210, w: 23, h: 27, planes: 3, radius: "46%", depth: 0.75, mirror: true },
  { part: "fingers", x: 68, y: 228, w: 19, h: 13, planes: 3, radius: "50%", depth: 0.8, mirror: true },
  { part: "leg", x: 97, y: 274, w: 19, h: 120, planes: 3, radius: "32%", mirror: true },
  { part: "knee", x: 97, y: 282, z: 3, w: 21, h: 21, planes: 3, radius: "50%", mirror: true },
  // O pé é mais comprido do que largo: aqui a seção passa de 1 e o volume
  // aponta para a frente, como um pé aponta.
  { part: "foot", x: 97, y: 342, z: 10, w: 24, h: 19, planes: 3, radius: "46%", depth: 1.5, mirror: true },
  { part: "toes", x: 97, y: 354, z: 20, w: 21, h: 11, planes: 3, radius: "50%", depth: 1.2, mirror: true },
];

/**
 * A seção do volume no ângulo de cada plano.
 *
 * O plano de frente vale a largura inteira; o de perfil vale a profundidade
 * declarada, e os do meio interpolam pelo seno do ângulo. É o que transforma um
 * cilindro em algo com frente e lado diferentes — sem isso o tronco tem a mesma
 * largura em toda volta, e a figura vira um tambor.
 */
function planeTransform(angle: number, depth: number) {
  const squeeze = 1 - (1 - depth) * Math.abs(Math.sin((angle * Math.PI) / 180));
  return `rotateY(${angle}deg) scaleX(${squeeze.toFixed(3)})`;
}

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

export function BodyMap({ items }: { items: AccidentSlice[] }) {
  const [spin, setSpin] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startSpin: number } | null>(null);

  const shares = new Map(items.map((item) => [item.key as AccidentBodyPart, item]));
  const strongest = Math.max(1, ...items.map((item) => item.share));
  const view = currentView(spin);

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
        {VOLUMES.flatMap((volume) => {
          const slice = shares.get(volume.part);
          const columns = volume.mirror ? [volume.x, STAGE_WIDTH - volume.x] : [volume.x];
          return columns.map((x, index) => <div
            key={`${volume.part}-${index}`}
            className={styles.bodyVolume}
            data-active={slice ? "true" : undefined}
            style={{
              left: `${x - volume.w / 2}px`,
              top: `${volume.y - volume.h / 2}px`,
              width: `${volume.w}px`,
              height: `${volume.h}px`,
              "--depth": `${volume.z ?? 0}px`,
              "--radius": volume.radius ?? "40%",
              ...(slice ? { "--region-weight": `${0.32 + (slice.share / strongest) * 0.56}` } : {}),
            } as CSSProperties}
          >
            {Array.from({ length: volume.planes ?? 3 }, (_, plane) => <i
              key={plane}
              style={{ transform: planeTransform((180 / (volume.planes ?? 3)) * plane, volume.depth ?? 1) }}
            />)}
          </div>);
        })}
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
