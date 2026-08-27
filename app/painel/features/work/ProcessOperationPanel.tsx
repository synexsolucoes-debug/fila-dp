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
 *
 * ## Por que este componente tem seções (§31)
 *
 * A §31 pede abas na ficha do processo. Documentos, regras e automações vêm da
 * mesma resposta que o fluxo — são recortes da mesma configuração. Um componente
 * por aba faria quatro pedidos da mesma rota e abriria caminho para quatro
 * leituras divergentes do mesmo processo; a barra de abas mora na ficha, e o que
 * ela troca aqui é qual recorte aparece. `section` é opcional para que o uso
 * antigo, sem abas, continue mostrando o fluxo.
 */

export type ProcessSheetSection = "flow" | "documents" | "rules" | "automations";

type DocumentRequirement = {
  name: string; required: boolean; steps: string[]; proof: "evidence" | "declared";
};

type StepRules = {
  stepId: string; label: string; position: number;
  entry: string[]; exit: string[];
  transitions: Array<{ target: string; conditions: string[] }>;
  requirements: string[]; blockingIntegrations: string[];
};

type StepAutomation = {
  stepId: string; label: string; position: number; trigger: string; effect: string;
};

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
  documents: DocumentRequirement[];
  rules: StepRules[];
  automations: StepAutomation[];
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
    documents: (Array.isArray(payload.documents) ? payload.documents : []).map((row) => {
      const item = (row ?? {}) as Record<string, unknown>;
      return {
        name: text(item.name), required: item.required === true, steps: list(item.steps),
        proof: item.proof === "evidence" ? "evidence" as const : "declared" as const,
      };
    }).filter((item) => item.name),
    rules: (Array.isArray(payload.rules) ? payload.rules : []).map((row) => {
      const item = (row ?? {}) as Record<string, unknown>;
      return {
        stepId: text(item.stepId), label: text(item.label), position: number(item.position),
        entry: list(item.entry), exit: list(item.exit),
        transitions: (Array.isArray(item.transitions) ? item.transitions : []).map((entry) => {
          const flow = (entry ?? {}) as Record<string, unknown>;
          return { target: text(flow.target), conditions: list(flow.conditions) };
        }),
        requirements: list(item.requirements), blockingIntegrations: list(item.blockingIntegrations),
      };
    }),
    automations: (Array.isArray(payload.automations) ? payload.automations : []).map((row) => {
      const item = (row ?? {}) as Record<string, unknown>;
      return {
        stepId: text(item.stepId), label: text(item.label), position: number(item.position),
        trigger: text(item.trigger), effect: text(item.effect),
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

export function ProcessOperationPanel({ processId, section = "flow", onStarted }: {
  processId: string;
  /** Qual recorte da ficha mostrar (§31). O padrão é o fluxo. */
  section?: ProcessSheetSection;
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

  if (section === "documents") {
    return <DocumentsSection documents={payload.documents} />;
  }
  if (section === "rules") {
    return <RulesSection rules={payload.rules} />;
  }
  if (section === "automations") {
    return <AutomationsSection automations={payload.automations} />;
  }

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

/* -------------------------------------------------------------------------- *
 * Documentos (§26, §31)
 * -------------------------------------------------------------------------- */

/**
 * O que o processo cobra, agrupado por documento.
 *
 * A coluna "conferência" não é enfeite: hoje um documento obrigatório é um item
 * de checklist, e marcar é declarar, não provar — só a etapa com evidência
 * exigida recusa avanço sem anexo. Quem audita a admissão precisa saber dessa
 * diferença antes de confiar na etapa, e uma tela que a escondesse prometeria
 * uma conferência que o produto não faz.
 */
function DocumentsSection({ documents }: { documents: DocumentRequirement[] }) {
  if (!documents.length) {
    return <p className={styles.agentDetail}>
      Nenhuma etapa deste processo pede documento. Documentos são configurados por etapa no modelador.
    </p>;
  }
  return <section className={styles.workspace} aria-label="Documentos do processo">
    <div className={styles.tableScroll}>
      <table className={styles.runTable}>
        <thead>
          <tr>
            <th scope="col">Documento</th>
            <th scope="col">Exigência</th>
            <th scope="col">Etapas</th>
            <th scope="col">Conferência</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((document) => <tr key={document.name}>
            <td>{document.name}</td>
            <td>{document.required ? "Obrigatório" : "Opcional"}</td>
            <td>{document.steps.join(", ")}</td>
            <td>{document.proof === "evidence"
              ? "Anexo verificado na etapa"
              : "Marcado no checklist, sem verificação de anexo"}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </section>;
}

/* -------------------------------------------------------------------------- *
 * Regras e validações (§25, §31)
 * -------------------------------------------------------------------------- */

/**
 * O que cada etapa exige, em português.
 *
 * Etapas sem regra não entram: quinze linhas vazias esconderiam as três que
 * importam. A tela não redige o motivo de bloqueio — quando a demanda de fato
 * trava, quem escreve a frase é o servidor, e duas redações da mesma regra
 * divergiriam no primeiro ajuste.
 */
function RulesSection({ rules }: { rules: StepRules[] }) {
  if (!rules.length) {
    return <p className={styles.agentDetail}>
      Nenhuma etapa deste processo tem regra de entrada, de saída, exigência ou dependência de integração.
      O avanço segue apenas o desenho.
    </p>;
  }
  return <section className={styles.workspace} aria-label="Regras e validações do processo">
    <ol className={styles.list}>
      {rules.map((step) => <li key={step.stepId} className={styles.item} data-tone="neutral">
        <span className={styles.rail} aria-hidden="true" />
        <div className={styles.itemBody}>
          <div className={styles.itemTop}>
            <ShieldCheck aria-hidden="true" />
            <span className={styles.itemTitle}>{step.position}. {step.label}</span>
          </div>
          {step.entry.length ? <RuleGroup title="Para entrar" items={step.entry} /> : null}
          {step.requirements.length ? <RuleGroup title="Enquanto está aqui" items={step.requirements} /> : null}
          {step.exit.length ? <RuleGroup title="Para sair" items={step.exit} /> : null}
          {step.transitions.map((transition) => <RuleGroup
            key={transition.target}
            title={`Só segue para ${transition.target} se`}
            items={transition.conditions} />)}
          {step.blockingIntegrations.length ? <RuleGroup
            title="Conclusão travada se a integração estiver em erro"
            items={step.blockingIntegrations} /> : null}
        </div>
      </li>)}
    </ol>
  </section>;
}

function RuleGroup({ title, items }: { title: string; items: string[] }) {
  return <div className={styles.itemMeta}>
    <span><strong>{title}:</strong> {items.join(" · ")}</span>
  </div>;
}

/* -------------------------------------------------------------------------- *
 * Automações (§27, §31)
 * -------------------------------------------------------------------------- */

/**
 * O que o processo dispara sozinho.
 *
 * Só entra o que o produto executa de fato: a demanda que a etapa abre. O
 * encadeamento "etapa concluída → próxima etapa" é o desenho, já lido na aba de
 * fluxo; repeti-lo aqui encheria a aba sem acrescentar nada. As regras de
 * quadro — mover, etiquetar, mexer no prazo — são do workspace inteiro e não
 * pertencem a um processo; a tela diz onde elas moram em vez de fingir que são
 * deste processo.
 */
function AutomationsSection({ automations }: { automations: StepAutomation[] }) {
  if (!automations.length) {
    return <p className={styles.agentDetail}>
      Este processo não abre demanda automaticamente em nenhuma etapa. As regras de quadro — mover,
      etiquetar, alterar prazo — valem para o workspace inteiro e ficam em Configurações › Automações.
    </p>;
  }
  return <section className={styles.workspace} aria-label="Automações do processo">
    <ol className={styles.list}>
      {automations.map((automation) => <li key={automation.stepId} className={styles.item} data-tone="neutral">
        <span className={styles.rail} aria-hidden="true" />
        <div className={styles.itemBody}>
          <div className={styles.itemTop}>
            <CircleDot aria-hidden="true" />
            <span className={styles.itemTitle}>{automation.position}. {automation.trigger}</span>
          </div>
          <p className={styles.agentDetail}>{automation.effect}</p>
        </div>
      </li>)}
    </ol>
    <p className={styles.agentDetail}>
      Regras de quadro — mover, etiquetar, alterar prazo — valem para o workspace inteiro e ficam em
      Configurações › Automações.
    </p>
  </section>;
}
