"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, History, Lock, RefreshCw, ScanSearch, ShieldAlert, Users } from "lucide-react";
import { EmptyState, ErrorBanner, LoadingState } from "../shared";
import { requestJson } from "../epi/epi.api";
import styles from "./tangerino.module.css";

/**
 * O andamento da admissão no Tangerino, dentro do cadastro do colaborador.
 *
 * Três decisões moldam esta tela:
 *
 * 1. **O texto original aparece sempre**, ao lado da tradução. Quando a
 *    tradução falha, quem está lendo consegue ver o que o Tangerino realmente
 *    disse e agir mesmo assim — em vez de encarar um "situação não reconhecida"
 *    que não ajuda ninguém.
 * 2. **Cada desfecho tem sua própria frase.** Onze estados diferentes com a
 *    mesma mensagem de erro fariam "o processo não existe" e "a sessão caiu"
 *    parecerem o mesmo problema, e eles pedem coisas opostas de quem lê.
 * 3. **Nada aqui altera a demanda do Vinculato.** A tela mostra e registra; o
 *    processo continua andando por decisão de uma pessoa (§50).
 */

type Consultation = {
  id: string;
  state: string;
  errorCode: string;
  rawStatus: string;
  normalizedStatus: string;
  statusLabel: string;
  stage: string;
  pendingReason: string;
  admissionDate: string;
  sourceUpdatedAt: string;
  externalAdmissionId: string;
  matchCount: number;
  requestedAt: string;
  consultedAt: string | null;
  durationMs: number;
};

type Payload = {
  employeeId: string;
  externalAdmissionId: string;
  current: Consultation | null;
  history: Consultation[];
};

/** Estados em que vale continuar perguntando ao servidor. */
const activeStates = new Set(["QUEUED", "RUNNING"]);

/**
 * O que dizer em cada desfecho, e o que fazer a respeito.
 *
 * O segundo campo é o que separa uma mensagem útil de um beco: "não encontrado"
 * sozinho deixa a pessoa sem saber se o problema é dela, do cadastro ou do
 * Tangerino. Dizer o próximo passo transforma a recusa em instrução.
 */
const outcomes: Record<string, { tone: "info" | "warn" | "error"; title: string; action: string }> = {
  QUEUED: { tone: "info", title: "Consulta na fila", action: "O agente vai abrir o Tangerino em instantes." },
  RUNNING: { tone: "info", title: "Consultando o Tangerino…", action: "O agente está navegando até o processo." },
  NOT_FOUND: {
    tone: "warn", title: "Processo não localizado",
    action: "Nenhum processo admissional foi encontrado para esta matrícula. Confira se a admissão já foi iniciada no Tangerino.",
  },
  MULTIPLE_MATCHES: {
    tone: "warn", title: "Mais de um processo possível",
    action: "O agente não escolhe por semelhança de nome. Informe o código do processo no Tangerino para desfazer o empate.",
  },
  AUTHENTICATION_REQUIRED: {
    tone: "error", title: "O Tangerino pediu autenticação",
    action: "Pode ser sessão expirada, verificação em duas etapas ou senha alterada. Um administrador precisa renovar o acesso do agente em Integrações.",
  },
  PERMISSION_DENIED: {
    tone: "error", title: "Sem permissão para consultar",
    action: "A conta usada pelo agente não alcança a Admissão Digital deste cliente.",
  },
  RATE_LIMITED: { tone: "warn", title: "Muitas consultas seguidas", action: "Aguarde um instante antes de consultar de novo." },
  TANGERINO_UNAVAILABLE: { tone: "warn", title: "Tangerino indisponível", action: "O sistema não respondeu. Tente novamente em alguns minutos." },
  UI_CHANGED: {
    tone: "error", title: "A tela do Tangerino mudou",
    action: "O agente não encontrou um campo que esperava e parou em vez de adivinhar. A integração precisa ser remapeada — avise o suporte.",
  },
  TIMEOUT: { tone: "warn", title: "O Tangerino demorou demais", action: "A consulta foi interrompida. Tente novamente." },
  CONSULTATION_FAILED: { tone: "error", title: "A consulta falhou", action: "Tente novamente. Se persistir, avise o suporte com o horário da tentativa." },
};

function moment(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function dayLabel(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}/u.test(value)) return value;
  const [year, month, day] = value.slice(0, 10).split("-");
  return `${day}/${month}/${year}`;
}

export function TangerinoAdmissionPanel({ employeeId, canConsult }: { employeeId: string; canConsult: boolean }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState("");
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setPayload(await requestJson<Payload>(`/api/integrations/tangerino/admissions/${employeeId}/consult`));
      setError("");
    } catch (cause) {
      setPayload(null);
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar o andamento no Tangerino.");
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  /* O acompanhamento existe porque a consulta é assíncrona (§34): a requisição
     devolve `202` e o resultado chega depois. Três segundos é o intervalo que
     mantém a tela viva sem transformar uma consulta de trinta segundos em dez
     requisições — e ele para sozinho quando o estado deixa de ser ativo. */
  useEffect(() => {
    if (!payload?.current || !activeStates.has(payload.current.state)) return;
    timer.current = window.setTimeout(() => void load(), 3_000);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [payload, load]);

  async function consult(force: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await requestJson<{ outcome: string; consultation: Consultation }>(
        `/api/integrations/tangerino/admissions/${employeeId}/consult`,
        { method: "POST", body: JSON.stringify({ force }) },
      );
      setPayload((current) => current ? { ...current, current: result.consultation } : current);
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Não foi possível iniciar a consulta.";
      // Agente desligado ou módulo não liberado não é falha da pessoa que
      // clicou: é estado da instalação, e a mensagem já diz o que destrava.
      if (/não está (?:ligad|liberad)|está desligado|agente de consulta/iu.test(message)) setUnavailable(message);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <LoadingState size="compact" title="Carregando o andamento" text="Buscando a última consulta ao Tangerino…" />;
  }

  const current = payload?.current ?? null;
  const active = Boolean(current && activeStates.has(current.state));
  const outcome = current ? outcomes[current.state] : null;
  const success = current?.state === "SUCCESS";

  return <div className={styles.panel}>
    <section className={styles.intro}>
      <span><ScanSearch aria-hidden="true" /></span>
      <div>
        <strong>Admissão no Tangerino</strong>
        {/* Dizer que é só leitura não é detalhe técnico: é o que faz alguém
            confiar em apertar o botão dentro do sistema onde a folha é feita. */}
        <p>O agente abre a Admissão Digital, localiza o processo e lê a situação. Ele <b>não altera nada</b> no Tangerino.</p>
      </div>
      {payload?.externalAdmissionId
        ? <b title="Processo vinculado no Tangerino">{payload.externalAdmissionId}</b>
        : <b className={styles.unbound}>Sem vínculo</b>}
    </section>

    {unavailable && <div className={`${styles.notice} ${styles.noticeWarn}`}>
      <Lock aria-hidden="true" /><div><strong>Agente indisponível</strong><p>{unavailable}</p></div>
    </div>}
    {error && <ErrorBanner message={error} />}

    <section className={styles.actions}>
      <div>
        <strong>Última consulta</strong>
        <span>{current ? moment(current.consultedAt ?? current.requestedAt) : "Nenhuma consulta registrada"}</span>
      </div>
      {canConsult
        ? <div className={styles.actionButtons}>
          <button type="button" className={styles.primaryButton} disabled={busy || active} onClick={() => void consult(false)}>
            <ScanSearch aria-hidden="true" /> {active ? "Consultando…" : "Consultar no Tangerino"}
          </button>
          {/* A consulta forçada existe porque a reutilização de resultado
              recente (§41) é útil na maior parte do tempo e atrapalha justo
              quando alguém acabou de mexer no processo do outro lado. */}
          {success && <button type="button" className={styles.secondaryButton} disabled={busy || active} onClick={() => void consult(true)}>
            <RefreshCw aria-hidden="true" /> Ignorar cache
          </button>}
        </div>
        : <span className={styles.noPermission}><Lock aria-hidden="true" /> Sem permissão para consultar</span>}
    </section>

    {!current && <EmptyState icon={ScanSearch} title="Nenhuma consulta ainda"
      text="Consulte para descobrir em que etapa a admissão está na Admissão Digital." />}

    {current && outcome && <div className={`${styles.notice} ${outcome.tone === "error" ? styles.noticeError : outcome.tone === "warn" ? styles.noticeWarn : styles.noticeInfo}`}>
      {outcome.tone === "info" ? <RefreshCw aria-hidden="true" className={active ? styles.spin : ""} />
        : outcome.tone === "warn" ? <CircleAlert aria-hidden="true" /> : <ShieldAlert aria-hidden="true" />}
      <div>
        <strong>{outcome.title}</strong>
        <p>{outcome.action}</p>
        {current.state === "MULTIPLE_MATCHES" && current.matchCount > 0
          && <small><Users aria-hidden="true" /> {current.matchCount} processos encontrados</small>}
      </div>
    </div>}

    {success && current && <section className={styles.result}>
      <header>
        <div>
          <span>SITUAÇÃO NO TANGERINO</span>
          <strong className={current.normalizedStatus === "UNKNOWN" ? styles.unknown : undefined}>{current.statusLabel}</strong>
        </div>
        <b>{current.externalAdmissionId || "sem código"}</b>
      </header>
      {/* O texto original ao lado da tradução, sempre (§30). Quando a tradução
          é `UNKNOWN`, é ele que responde a pergunta de quem está lendo. */}
      <blockquote>“{current.rawStatus}”</blockquote>
      <dl>
        {current.stage && <div><dt>Etapa</dt><dd>{current.stage}</dd></div>}
        {current.pendingReason && <div><dt>Pendência</dt><dd>{current.pendingReason}</dd></div>}
        {current.admissionDate && <div><dt>Data de admissão</dt><dd>{dayLabel(current.admissionDate)}</dd></div>}
        {current.sourceUpdatedAt && <div><dt>Atualizado no Tangerino</dt><dd>{moment(current.sourceUpdatedAt)}</dd></div>}
        <div><dt>Consultado em</dt><dd>{moment(current.consultedAt)}</dd></div>
        <div><dt>Fonte</dt><dd>Agente de navegador</dd></div>
      </dl>
    </section>}

    {payload && payload.history.length > 1 && <section className={styles.history}>
      <header><History aria-hidden="true" /><strong>Histórico de consultas</strong></header>
      <ol>
        {payload.history.map((item) => <li key={item.id}>
          <time>{moment(item.consultedAt ?? item.requestedAt)}</time>
          <span>{item.statusLabel}</span>
          <small>{item.rawStatus}</small>
        </li>)}
      </ol>
    </section>}
  </div>;
}
