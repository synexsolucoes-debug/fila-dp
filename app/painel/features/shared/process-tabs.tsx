"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * O canal por onde um módulo entrega as próprias abas ao cabeçalho do processo
 * (§41, §70).
 *
 * Até aqui havia dois padrões para a mesma coisa. Um processo com vários
 * módulos — Pagamentos — mostrava as abas no cabeçalho contextual, no topo da
 * tela. Um processo de um módulo só — Controle de EPI — escondia os seus dez
 * destinos numa barra de abas dentro do próprio módulo, 200px abaixo, com
 * outro desenho. Quem opera os dois aprende duas gramáticas para "trocar de
 * assunto dentro do processo", que é exatamente o sintoma que a §2 descreve.
 *
 * A alternativa seria a casca conhecer as abas de cada módulo — mas os
 * contadores que elas exibem ("Entregas 12") vivem no estado do módulo, e
 * levá-los para cima transformaria a casca em dona de dados que não são dela.
 *
 * Então o módulo continua dono das abas e do estado delas; o que muda é onde
 * elas são pintadas. O `<div>` do cabeçalho é publicado como destino, e o
 * módulo desenha dentro dele por portal.
 *
 * O nó chega por `useState` num callback de ref, e não por `useRef`: o ref
 * sozinho não provoca novo render, e o módulo — que renderiza depois do
 * cabeçalho na mesma passagem — encontraria `null` e não desenharia nada. Com
 * o estado, o primeiro render publica o nó e o segundo pinta as abas. É um
 * render a mais na entrada do processo, uma vez.
 */
const ProcessTabsContext = createContext<HTMLElement | null>(null);

export function ProcessTabsProvider({ children }: { children: (target: (node: HTMLDivElement | null) => void) => ReactNode }) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => node, [node]);
  return <ProcessTabsContext.Provider value={value}>{children(setNode)}</ProcessTabsContext.Provider>;
}

/**
 * Desenha as abas do módulo no cabeçalho do processo.
 *
 * Devolve `null` enquanto o destino não existe — o que acontece no primeiro
 * render e em qualquer tela fora de um processo. Um módulo que precise das
 * abas visíveis em ambos os casos deve conferir `useProcessTabsTarget()` e
 * decidir; nenhum precisa hoje.
 */
export function ProcessTabsSlot({ children }: { children: ReactNode }) {
  const node = useContext(ProcessTabsContext);
  return node ? createPortal(children, node) : null;
}

/** Para o módulo saber se há cabeçalho de processo para preencher. */
export function useProcessTabsTarget() {
  return useContext(ProcessTabsContext) !== null;
}
