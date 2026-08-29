"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, CircleDot, Lock, Workflow } from "lucide-react";
import { ErrorBanner, LoadingState } from "../shared";
import { requestJson } from "./work.api";
import styles from "./work.module.css";

/**
 * A demanda vista pelo processo que a governa (§42, §43, §44).
 *
 * A PR anterior ligou processo e demanda no banco e na rota; na tela, a demanda
 * continuava sem dizer de que processo veio, em que etapa está e o que falta
 * para avançar. Este painel fecha isso.
 *
 * ## O motivo do bloqueio vem do servidor, não da tela
 *
 * `GET /api/cards/:id/process` devolve cada destino com a lista de bloqueios já
 * avaliada — checklist em aberto, evidência faltando, responsável, aprovador,
 * autoaprovação. A tela desabilita o botão e mostra **o motivo**, em vez de
 * deixar clicar para recusar depois com uma frase genérica (§44).
 *
 * Reavaliar de novo no servidor ao clicar não é redundância: entre a fotografia
 * e o clique alguém pode ter desmarcado um item de checklist.
 *
 * ## Sem BPMN obrigatório
 *
 * Aqui não há diagrama. Etapa atual, o que ela exige e para onde ela pode ir —
 * em texto. Quem modela continua com o desenho na tela de Processos (§43).
 */

type Transition = {
  targetStepId: string;
  targetLabel: string;
  allowed: boolean;
  terminal: boolean;
  blockers: Array<{ code: string; message: string }>;
};

type ProcessState = {
  instance: {
    cardId: string;
    processId: string;
    processName: string;
    versionId: string;
    versionNumber: string;
    currentStepId: string;
    currentStepLabel: string;
    terminal: boolean;
    requiresApproval: boolean;
    version: number;
  };
  transitions: Transition[];
};

const text = (value: unknown) => (value == null ? "" : String(value));

function normalize(payload: Record<string, unknown>): ProcessState {
  const instance = (payload.instance ?? {}) as Record<string, unknown>;
  const transitions = Array.isArray(payload.transitions) ? payload.transitions : [];
  return {
    instance: {
      cardId: text(instance.cardId),
      processId: text(instance.processId),
      processName: text(instance.processName),
      versionId: text(instance.versionId),
      versionNumber: text(instance.versionNumber),
      requiresApproval: Boolean((instance as Record<string, unknown>).requiresApproval),
      currentStepId: text(instance.currentStepId),
      currentStepLabel: text(instance.currentStepLabel),
      terminal: instance.terminal === true,
      version: Number(instance.version ?? 0),
    },
    transitions: transitions.map((row) => {
      const item = (row ?? {}) as Record<string, unknown>;
      const blockers = Array.isArray(item.blockers) ? item.blockers : [];
      return {
        targetStepId: text(item.targetStepId),
        targetLabel: text(item.targetLabel),
        allowed: item.allowed === true,
        terminal: item.terminal === true,
        blockers: blockers.map((blocker) => {
          const entry = (blocker ?? {}) as Record<string, unknown>;
          return { code: text(entry.code), message: text(entry.message) };
        }),
      };
    }),
  };
}

export function CardProcessPanel({ cardId, canAdvance, onAdvanced }: {
  cardId: string;
  canAdvance: boolean;
  onAdvanced?: () => void;
}) {
  const [state, setState] = useState<ProcessState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notLinked, setNotLinked] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await requestJson<Record<string, unknown>>(`/api/cards/${encodeURIComponent(cardId)}/process`);
      /* Demanda sem processo é o caso comum — as anteriores à consolidação e as
         abertas à mão. Isso não é erro, e o servidor diz isso em um campo, não
         em uma frase: a versão anterior reconhecia o caso procurando "processo"
         e "não" na mensagem de erro, e assim uma recusa de permissão
         ("Você **não** tem permissão para consultar a etapa da demanda do
         **processo**") teria virado a explicação tranquilizadora abaixo, com a
         pessoa acreditando que a demanda não tem processo quando ela só não
         podia vê-lo. */
      if (data.linked === false) {
        setNotLinked(true);
        setState(null);
      } else {
        setState(normalize(data));
        setNotLinked(false);
      }
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar a etapa desta demanda.");
    } finally { setLoading(false); }
  }, [cardId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(); });
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const advance = useCallback(async (transition: Transition) => {
    setBusy(transition.targetStepId);
    try {
      const data = await requestJson<Record<string, unknown>>(`/api/cards/${encodeURIComponent(cardId)}/process`, {
        method: "POST", body: JSON.stringify({ targetStepId: transition.targetStepId }),
      });
      setState(normalize(data));
      setError("");
      onAdvanced?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível avançar a etapa.");
    } finally { setBusy(""); }
  }, [cardId, onAdvanced]);

  if (loading) return <LoadingState title="Consultando a etapa…" size="compact" />;
  if (notLinked) {
    return <p className={styles.agentDetail}>
      Esta demanda não nasceu de um processo publicado. Ela continua sendo tratada pelo quadro, com as colunas e o SLA de sempre.
    </p>;
  }
  if (!state) return error ? <ErrorBanner message={error} onDismiss={() => setError("")} /> : null;

  const { instance, transitions } = state;

  return <section className={styles.workspace} aria-label="Etapa do processo">
    {error ? <ErrorBanner message={error} onDismiss={() => setError("")} /> : null}

    <dl className={styles.fieldList}>
      <div><dt>Processo</dt><dd>{instance.processName || instance.processId}</dd></div>
      <div><dt>Versão</dt><dd>{instance.versionNumber || "—"}</dd></div>
      <div>
        <dt>Etapa atual</dt>
        <dd><CircleDot aria-hidden="true" /> {instance.currentStepLabel || instance.currentStepId}</dd>
      </div>
    </dl>

    {instance.terminal
      ? <p className={styles.agentDetail}>
        <CheckCircle2 aria-hidden="true" /> Esta é a etapa final do processo. Não há para onde avançar.
      </p>
      : transitions.length === 0
        ? <p className={styles.agentDetail}>
          O desenho publicado não autoriza nenhuma saída a partir desta etapa. Quem modela o processo precisa revisar a versão.
        </p>
        : <>
          {/* Dito ANTES da lista: quem chega aqui precisa saber que o clique é
              um aval, e não uma movimentação de fila. O motor já recusa quem não
              é aprovador e recusa autoaprovação; isto é a metade que faltava —
              avisar antes, em vez de explicar depois do erro. */}
          {instance.requiresApproval ? <p className={styles.agentDetail}>
            <Lock aria-hidden="true" /> Esta etapa exige aprovação. Avançar daqui
            é dar o aval, e fica registrado no seu nome.
          </p> : null}
          <h4 className={styles.groupHeading}>Para onde esta etapa pode seguir</h4>
          <div className={styles.list}>
            {transitions.map((transition) => <article key={transition.targetStepId}
              className={styles.item} data-tone={transition.allowed ? "neutral" : "warning"}>
              <span className={styles.rail} aria-hidden="true" />
              <div className={styles.itemBody}>
                <div className={styles.itemTop}>
                  <Workflow aria-hidden="true" />
                  <span className={styles.itemTitle}>{transition.targetLabel}</span>
                  {transition.terminal ? <span className={styles.badge} data-tone="positive">Conclui o processo</span> : null}
                </div>
                {/* O bloqueio aparece inteiro: cada motivo é uma coisa diferente
                    a resolver, e resumir em "pendências" faria a pessoa
                    adivinhar qual (§44). */}
                {transition.blockers.length ? <ul className={styles.itemMeta}>
                  {transition.blockers.map((blocker) => <li key={blocker.code} className={styles.blocked}>
                    <Lock aria-hidden="true" />{blocker.message}
                  </li>)}
                </ul> : null}
              </div>
              <div className={styles.itemActions}>
                <button type="button" className={styles.primaryButton}
                  disabled={!transition.allowed || !canAdvance || busy === transition.targetStepId}
                  title={transition.allowed
                    ? undefined
                    : transition.blockers.map((blocker) => blocker.message).join(" ")}
                  onClick={() => void advance(transition)}>
                  {busy === transition.targetStepId
                    ? (instance.requiresApproval ? "Aprovando…" : "Avançando…")
                    : (instance.requiresApproval ? "Aprovar e avançar" : "Avançar")}<ArrowRight aria-hidden="true" />
                </button>
                {!canAdvance ? <span className={styles.nextAction}>Você não tem permissão para avançar a etapa.</span> : null}
              </div>
            </article>)}
          </div>
        </>}
  </section>;
}
