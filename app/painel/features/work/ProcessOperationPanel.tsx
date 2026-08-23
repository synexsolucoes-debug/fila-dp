"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleDot, FileText, Lock, Play, ShieldCheck, Timer, Users } from "lucide-react";
import { ErrorBanner, LoadingState } from "../shared";
import { requestJson } from "./work.api";
import styles from "./work.module.css";

/**
 * O processo publicado em texto, com o que ele produziu (§39 a §41, §43, §55).
 *
 * Três blocos, nesta ordem porque é a ordem das perguntas de quem opera:
 * **como funciona** (etapas, responsáveis, exigências), **como está indo**
 * (abertas, concluídas, em atraso, tempo médio, onde trava) e **como começar**
 * (iniciar uma demanda a partir dele).
 *
 * O diagrama continua na modelagem. Aqui não há BPMN: obrigar quem trata a
 * demanda a interpretar um desenho para saber quem responde pela etapa seguinte
 * é transferir a ela um trabalho que o produto deveria fazer (§43).
 */

type Step = {
  id: string; label: string; position: number; role: string; terminal: boolean;
  responsible: string; slaLabel: string; checklist: string[]; requiredDocuments: string[];
  evidenceRequired: boolean; requiresApproval: boolean; instructions: string; nextLabels: string[];
};

type Usage = {
  open: number; completed: number; overdue: number; averageHours: number | null;
  retention: Array<{ stepId: string; label: string; open: number; averageAgeHours: number }>;
};

type Payload = {
  published: boolean;
  detail: string;
  version: { id: string; number: string; name: string } | null;
  steps: Step[];
  usage: Usage | null;
  usageLabels: { averageDuration: string; retention: string[] };
  permissions: { start: boolean };
};

const text = (value: unknown) => (value == null ? "" : String(value));
const number = (value: unknown) => Number(value) || 0;
const list = (value: unknown) => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);

function normalize(payload: Record<string, unknown>): Payload {
  const version = payload.version && typeof payload.version === "object" ? payload.version as Record<string, unknown> : null;
  const usage = payload.usage && typeof payload.usage === "object" ? payload.usage as Record<string, unknown> : null;
  const labels = (payload.usageLabels ?? {}) as Record<string, unknown>;
  const permissions = (payload.permissions ?? {}) as Record<string, unknown>;
  return {
    published: payload.published === true,
    detail: text(payload.detail),
    version: version ? { id: text(version.id), number: text(version.number), name: text(version.name) } : null,
    steps: (Array.isArray(payload.steps) ? payload.steps : []).map((row) => {
      const step = (row ?? {}) as Record<string, unknown>;
      return {
        id: text(step.id), label: text(step.label), position: number(step.position),
        role: text(step.role), terminal: step.terminal === true,
        responsible: text(step.responsible), slaLabel: text(step.slaLabel),
        checklist: list(step.checklist), requiredDocuments: list(step.requiredDocuments),
        evidenceRequired: step.evidenceRequired === true, requiresApproval: step.requiresApproval === true,
        instructions: text(step.instructions), nextLabels: list(step.nextLabels),
      };
    }),
    usage: usage ? {
      open: number(usage.open), completed: number(usage.completed), overdue: number(usage.overdue),
      averageHours: usage.averageHours == null ? null : number(usage.averageHours),
      retention: (Array.isArray(usage.retention) ? usage.retention : []).map((row) => {
        const item = (row ?? {}) as Record<string, unknown>;
        return {
          stepId: text(item.stepId), label: text(item.label),
          open: number(item.open), averageAgeHours: number(item.averageAgeHours),
        };
      }),
    } : null,
    usageLabels: {
      averageDuration: text(labels.averageDuration) || "—",
      retention: list(labels.retention),
    },
    permissions: { start: permissions.start === true },
  };
}

export function ProcessOperationPanel({ processId, onStarted }: {
  processId: string;
  onStarted?: (cardId: string) => void;
}) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await requestJson<Record<string, unknown>>(`/api/processes/${encodeURIComponent(processId)}/usage`);
      setPayload(normalize(data));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar a ficha operacional.");
    } finally { setLoading(false); }
  }, [processId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { void load(); });
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  /**
   * Iniciar o processo (§41).
   *
   * Nada é pedido além do necessário: a rota de instanciação já resolve etapa
   * inicial, checklist, prazo e prioridade a partir da versão publicada. Pedir
   * de novo o que o desenho já diz seria transformar o formulário em uma
   * segunda fonte de verdade sobre o processo.
   */
  const start = useCallback(async () => {
    if (!payload?.version) return;
    setStarting(true);
    try {
      const data = await requestJson<{ instance?: { cardId?: string } }>(
        `/api/processes/versions/${encodeURIComponent(payload.version.id)}/instantiate`,
        { method: "POST", body: JSON.stringify({}) },
      );
      const cardId = text(data.instance?.cardId);
      setToast("Demanda aberta a partir deste processo, já na etapa inicial.");
      if (cardId) onStarted?.(cardId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível iniciar o processo.");
    } finally { setStarting(false); }
  }, [load, onStarted, payload]);

  if (loading) return <LoadingState title="Carregando a ficha operacional…" size="compact" />;
  if (!payload) return error ? <ErrorBanner message={error} onDismiss={() => setError("")} /> : null;

  if (!payload.published) {
    return <p className={styles.agentDetail}>{payload.detail}</p>;
  }

  const { usage, usageLabels } = payload;

  return <section className={styles.workspace} aria-label="Ficha operacional do processo">
    {error ? <ErrorBanner message={error} onDismiss={() => setError("")} /> : null}
    {toast ? <p className={styles.agentDetail} role="status">{toast}</p> : null}

    {usage ? <div className={styles.counters} role="group" aria-label="Uso do processo">
      <div className={styles.counter}><strong>{usage.open}</strong><span>Demandas abertas</span></div>
      <div className={styles.counter}><strong>{usage.completed}</strong><span>Concluídas</span></div>
      <div className={styles.counter} data-tone={usage.overdue ? "critical" : undefined}>
        <strong>{usage.overdue}</strong><span>Em atraso</span>
      </div>
      <div className={styles.counter}><strong>{usageLabels.averageDuration}</strong><span>Tempo médio</span></div>
    </div> : null}

    {usage && usage.retention.length ? <>
      <h4 className={styles.groupHeading}>Onde as demandas estão paradas</h4>
      <div className={styles.tableScroll}>
        <table className={styles.runTable}>
          <thead>
            <tr><th scope="col">Etapa</th><th scope="col">Abertas</th><th scope="col">Parada há</th></tr>
          </thead>
          <tbody>
            {usage.retention.map((item, index) => <tr key={item.stepId}>
              <td>{item.label}</td>
              <td>{item.open}</td>
              <td>{usageLabels.retention[index] ?? "—"}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </> : null}

    <h4 className={styles.groupHeading}>Etapas, em ordem</h4>
    <ol className={styles.list}>
      {payload.steps.map((step) => <li key={step.id} className={styles.item} data-tone="neutral">
        <span className={styles.rail} aria-hidden="true" />
        <div className={styles.itemBody}>
          <div className={styles.itemTop}>
            {step.terminal ? <CheckCircle2 aria-hidden="true" /> : <CircleDot aria-hidden="true" />}
            <span className={styles.itemTitle}>{step.position}. {step.label}</span>
            {step.requiresApproval ? <span className={styles.badge} data-tone="warning"><ShieldCheck aria-hidden="true" />Exige aprovação</span> : null}
            {step.evidenceRequired ? <span className={styles.badge} data-tone="warning"><Lock aria-hidden="true" />Exige evidência</span> : null}
          </div>
          {step.instructions ? <p className={styles.agentDetail}>{step.instructions}</p> : null}
          <div className={styles.itemMeta}>
            <span><Users aria-hidden="true" /> {step.responsible}</span>
            <span><Timer aria-hidden="true" /> {step.slaLabel}</span>
            {step.checklist.length ? <span>{step.checklist.length} item(ns) de checklist</span> : null}
            {step.requiredDocuments.length ? <span><FileText aria-hidden="true" /> {step.requiredDocuments.join(", ")}</span> : null}
            {step.nextLabels.length ? <span>Segue para: {step.nextLabels.join(" ou ")}</span> : null}
          </div>
        </div>
      </li>)}
    </ol>

    {payload.permissions.start ? <div className={styles.detailActions}>
      <button type="button" className={styles.primaryButton} disabled={starting} onClick={() => void start()}>
        <Play aria-hidden="true" />{starting ? "Abrindo…" : "Iniciar processo"}
      </button>
      <span className={styles.nextAction}>
        Abre uma demanda na versão {payload.version?.number}. Publicar uma versão nova não move o que já foi aberto.
      </span>
    </div> : null}
  </section>;
}
