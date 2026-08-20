"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Favoritos e recentes de quem está usando o painel (§67).
 *
 * O menu ficou fundo quando passou a agrupar por processo: são sete processos
 * e mais de vinte destinos, e alcançar um deles custa dois níveis. Isso é o
 * preço de organizar por processo, e vale a pena — mas quem trabalha em três
 * destinos o dia inteiro paga esse preço umas quarenta vezes por dia.
 *
 * Os atalhos ficam no banco, por pessoa e por grupo, e não no navegador: quem
 * abre o painel do escritório de manhã e de casa à tarde é a mesma pessoa, e
 * `localStorage` faria duas.
 *
 * O recente é registrado por passagem, não por clique no menu: chegar a uma
 * tela por um cartão de pendência ou pela busca também conta como ter estado
 * lá. E é registrado com atraso — quem passa por uma tela a caminho de outra
 * não esteve nela, e um recente que enche de passagens deixa de apontar para
 * onde a pessoa estava trabalhando.
 */

const DEMORA_ATE_CONTAR_COMO_VISITA = 2500;

export type Shortcuts = {
  favorites: readonly string[];
  recents: readonly string[];
  isFavorite: (view: string) => boolean;
  toggleFavorite: (view: string) => void;
  /** Recado do servidor quando ele recusa — hoje, só o teto de favoritos. */
  notice: string;
  dismissNotice: () => void;
};

type Payload = { favorites?: unknown; recents?: unknown };

const asViews = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

export function useShortcuts(currentView: string, enabled = true): Shortcuts {
  const [favorites, setFavorites] = useState<readonly string[]>([]);
  const [recents, setRecents] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState("");
  const pending = useRef(false);

  const apply = useCallback((payload: Payload) => {
    setFavorites(asViews(payload.favorites));
    setRecents(asViews(payload.recents));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void (async () => {
      try {
        const response = await fetch("/api/shortcuts", { headers: { accept: "application/json" } });
        if (!response.ok || !alive) return;
        apply(await response.json() as Payload);
      } catch {
        // Atalho é conveniência. Se a leitura falhar, o menu inteiro continua
        // ali — não vale interromper ninguém com um aviso por causa disso.
      }
    })();
    return () => { alive = false; };
  }, [apply, enabled]);

  // A visita entra depois da demora, e só se a pessoa ainda estiver na tela.
  useEffect(() => {
    if (!enabled || !currentView) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/api/shortcuts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ view: currentView, visited: true }),
          });
          if (response.ok) apply(await response.json() as Payload);
        } catch { /* idem */ }
      })();
    }, DEMORA_ATE_CONTAR_COMO_VISITA);
    return () => window.clearTimeout(timer);
  }, [apply, currentView, enabled]);

  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  const toggleFavorite = useCallback((view: string) => {
    if (pending.current) return;
    pending.current = true;
    const next = !favoriteSet.has(view);
    void (async () => {
      try {
        const response = await fetch("/api/shortcuts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ view, favorite: next }),
        });
        const payload = await response.json() as Payload & { error?: string };
        if (!response.ok) {
          // O teto de favoritos é a única recusa esperada aqui, e ela precisa
          // ser dita: sem o recado, marcar o nono simplesmente não faz nada.
          setNotice(String(payload.error || "Não foi possível salvar o atalho."));
          return;
        }
        setNotice("");
        apply(payload);
      } catch {
        setNotice("Não foi possível salvar o atalho agora.");
      } finally {
        pending.current = false;
      }
    })();
  }, [apply, favoriteSet]);

  const isFavorite = useCallback((view: string) => favoriteSet.has(view), [favoriteSet]);
  const dismissNotice = useCallback(() => setNotice(""), []);

  return { favorites, recents, isFavorite, toggleFavorite, notice, dismissNotice };
}
