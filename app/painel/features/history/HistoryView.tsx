"use client";

import { useCallback, useEffect, useState } from "react";
import { History, RefreshCw } from "lucide-react";

/**
 * O histórico completo da operação (spec: "Ver histórico completo").
 *
 * A Visão geral mostra as cinco movimentações mais recentes e não tinha para
 * onde mandar quem quisesse o resto — o registro existia em
 * `fdp_activity_events` sem lugar onde ser lido. Esta tela é esse lugar.
 *
 * Carrega sob demanda, e não junto do snapshot de abertura: a trilha cresce sem
 * limite, e trazê-la inteira faria toda abertura do painel pagar por uma tela
 * que quase ninguém abre.
 *
 * A paginação é por cursor de data. `OFFSET` faria a segunda página repetir ou
 * pular linhas conforme eventos novos entrassem no topo enquanto alguém lê.
 */

type HistoryEvent = {
  id: string;
  cardId: string | null;
  cardTitle: string;
  referenceNumber: number | null;
  company: string;
  actorName: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

/** Rótulo por tipo de evento. Tipo desconhecido cai no próprio identificador —
 *  feio, e melhor que uma linha em branco: quem lê descobre que evento é. */
const EVENT_LABELS: Record<string, string> = {
  "card.created": "criou a demanda",
  "card.updated": "alterou a demanda",
  "card.moved": "moveu a demanda",
  "card.archived": "arquivou a demanda",
  "card.cancelled": "cancelou a demanda",
  "card.comment": "comentou",
  "card.attachment": "anexou documento",
  "checklist.completed": "concluiu uma tarefa",
  "checklist.reopened": "reabriu uma tarefa",
  "process.step_advanced": "avançou a etapa",
  "process.instance_completed": "concluiu o processo",
  "sla.paused": "pausou o SLA",
  "sla.resumed": "retomou o SLA",
};

function eventLabel(event: HistoryEvent) {
  return EVENT_LABELS[event.eventType] ?? event.eventType;
}

/** Detalhe do evento, quando o payload traz algo que valha ser lido. */
function eventDetail(event: HistoryEvent) {
  const p = event.payload ?? {};
  if (typeof p.reason === "string" && p.reason) return p.reason;
  if (typeof p.toStepLabel === "string" && p.toStepLabel) return `para "${p.toStepLabel}"`;
  if (typeof p.toListName === "string" && p.toListName) return `para "${p.toListName}"`;
  return "";
}

function moment(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function HistoryView({ onOpenCard }: { onOpenCard?: (cardId: string) => void }) {
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /* Nada de `setState` antes do primeiro `await`: chamada síncrona dentro do
     efeito dispara re-render em cascata. `loading` já nasce `true`, então a
     primeira carga não precisa anunciá-la; quem anuncia é o botão de carregar
     mais, que roda fora do efeito. */
  const load = useCallback(async (antesDe: string | null) => {
    try {
      const url = antesDe ? `/api/history?antesDe=${encodeURIComponent(antesDe)}` : "/api/history";
      const response = await fetch(url, { cache: "no-store" });
      setError("");
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || "Não foi possível carregar o histórico.");
      }
      const body = await response.json() as { events: HistoryEvent[]; nextCursor: string | null };
      /* Acrescenta em vez de substituir: "carregar mais" que troca a lista faz
         a pessoa perder o lugar onde estava lendo. */
      setEvents((atual) => (antesDe ? [...atual, ...body.events] : body.events));
      setCursor(body.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar o histórico.");
    } finally {
      setLoading(false);
    }
  }, []);

  /* Deferido por `requestAnimationFrame`, como os outros painéis que carregam
     ao montar: chamada síncrona dentro do efeito dispara re-render em cascata,
     e o cancelamento evita atualizar estado de um componente desmontado. */
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(null); });
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  return <section className="history-view" aria-label="Histórico da operação">
    {error && <div className="history-error" role="alert">
      <p>{error}</p>
      <button type="button" onClick={() => { setLoading(true); void load(null); }}>
        <RefreshCw aria-hidden="true" /> Tentar de novo
      </button>
    </div>}

    {!error && !loading && events.length === 0 && <div className="history-empty">
      <History aria-hidden="true" />
      <strong>Nenhuma movimentação registrada ainda.</strong>
      <p>Criar demandas, avançar etapas e anexar documentos passa a aparecer aqui automaticamente.</p>
    </div>}

    {events.length > 0 && <div className="history-table-wrap">
      <table className="history-table">
        <caption className="sr-only">Movimentações da operação, da mais recente para a mais antiga</caption>
        <thead>
          <tr>
            <th scope="col">Quando</th>
            <th scope="col">Quem</th>
            <th scope="col">O que</th>
            <th scope="col">Demanda</th>
            <th scope="col">Empresa</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => <tr key={event.id}>
            <td><time dateTime={event.createdAt}>{moment(event.createdAt)}</time></td>
            <td>{event.actorName || "Sistema"}</td>
            <td>
              {eventLabel(event)}
              {eventDetail(event) && <small> {eventDetail(event)}</small>}
            </td>
            <td>
              {/* Sem demanda o evento é do workspace — configuração, integração.
                  Um traço diz isso melhor que uma célula vazia, que parece dado
                  que faltou carregar. */}
              {event.cardId
                ? <button type="button" className="history-card-link"
                    onClick={() => onOpenCard?.(event.cardId!)}>
                    {event.referenceNumber != null && <b>#DM-{event.referenceNumber}</b>}
                    {event.cardTitle || "Demanda"}
                  </button>
                : <span className="history-none">—</span>}
            </td>
            <td>{event.company || <span className="history-none">—</span>}</td>
          </tr>)}
        </tbody>
      </table>
    </div>}

    {loading && <p className="history-loading">Carregando o histórico…</p>}

    {/* O botão só existe quando há mais: "carregar mais" que não carrega nada é
        promessa que a tela não cumpre. */}
    {cursor && !loading && <button type="button" className="history-more"
      onClick={() => { setLoading(true); void load(cursor); }}>Carregar mais</button>}
  </section>;
}
