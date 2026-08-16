"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, LoaderCircle, Send, ShieldCheck, X } from "lucide-react";
import styles from "./assistant.module.css";

/**
 * Assistente do painel.
 *
 * Fica recolhido até ser chamado, e sai da frente com Esc. Um copiloto que
 * ocupa espaço sem ter sido pedido atrapalha justamente quem já sabe o que
 * fazer — que é a maioria das sessões.
 *
 * A tela é honesta sobre dois limites, porque escondê-los geraria a impressão
 * errada: o assistente não enxerga dado de pessoa, e o que for colado na
 * pergunta é removido antes de sair.
 */

type Message = { id: string; role: "user" | "assistant"; content: string };

type Status = {
  available: boolean;
  unavailableReason: string | null;
  conversationId: string | null;
  messages: Message[];
};

export function AssistantPanel({ screen, openSignal = 0 }: { screen: string; openSignal?: number }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const conversationRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/assistant/chat", { cache: "no-store" });
      const data = await response.json().catch(() => ({})) as Status;
      setStatus(data);
    } catch {
      setStatus({ available: false, unavailableReason: "Não foi possível falar com o assistente agora.", conversationId: null, messages: [] });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load, open]);

  // O botão "Ajuda" da barra superior abre por aqui. Ele existia e respondia
  // com uma frase fixa — "use a busca global" —, que é um botão de ajuda que
  // não ajuda. A capacidade de responder já estava construída neste painel: as
  // instruções dele mandam explicar o caminho e apontar a tela e o botão.
  useEffect(() => {
    if (openSignal <= 0) return;
    const frame = window.requestAnimationFrame(() => setOpen(true));
    return () => window.cancelAnimationFrame(frame);
  }, [openSignal]);

  // Esc fecha: o painel não pode virar uma parede entre a pessoa e a tela.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, busy]);

  async function send() {
    const question = draft.trim();
    if (!question || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setDraft("");
    const localId = crypto.randomUUID();
    setMessages((current) => [...current, { id: localId, role: "user", content: question }]);
    try {
      const response = await fetch("/api/assistant/chat", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question, screen, conversationId: conversationRef.current }),
      });
      const data = await response.json().catch(() => ({})) as {
        conversationId?: string; reply?: string; redacted?: boolean; redactionKinds?: string[];
        message?: string; error?: string;
      };
      if (!response.ok) throw new Error(data.message || data.error || "O assistente não conseguiu responder agora.");
      conversationRef.current = data.conversationId ?? null;
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: data.reply ?? "" }]);
      if (data.redacted) {
        // Sem este aviso a pessoa acha que o assistente ignorou o dado, e repete.
        setNotice(`Removi ${(data.redactionKinds ?? []).join(", ")} da sua pergunta antes de enviar. Dado pessoal não sai do sistema.`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "O assistente não conseguiu responder agora.");
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  if (!open) {
    return (
      <button type="button" className={styles.launcher} onClick={() => setOpen(true)} aria-expanded={false}>
        <Bot aria-hidden="true" /> Assistente
      </button>
    );
  }

  return (
    <aside className={styles.panel} aria-label="Assistente do Vinculato">
      <header>
        <div>
          <span className={styles.eyebrow}>ASSISTENTE</span>
          <strong>{screen}</strong>
        </div>
        <button type="button" onClick={() => setOpen(false)} aria-label="Fechar o assistente">
          <X aria-hidden="true" />
        </button>
      </header>

      {status && !status.available ? (
        <div className={styles.unavailable} role="status">
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>Assistente não configurado</strong>
            <p>{status.unavailableReason}</p>
          </div>
        </div>
      ) : (
        <>
          <p className={styles.boundary}>
            <ShieldCheck aria-hidden="true" />
            <span>
              Ele conhece as telas e as suas permissões — <b>não</b> vê colaborador, prestador, folha nem valores.
              O que você colar de dado pessoal é removido antes de sair.
            </span>
          </p>

          <div className={styles.thread} ref={listRef}>
            {messages.length === 0 && (
              <p className={styles.empty}>
                Pergunte como fazer algo nesta tela, o que o seu papel permite, ou onde encontrar uma informação.
              </p>
            )}
            {messages.map((message) => (
              <p key={message.id} className={message.role === "user" ? styles.mine : styles.theirs}>
                {message.content}
              </p>
            ))}
            {busy && <p className={styles.theirs}><LoaderCircle className={styles.spin} aria-hidden="true" /> Pensando…</p>}
          </div>

          {notice && <p className={styles.notice} role="status">{notice}</p>}
          {error && <p className={styles.error} role="alert">{error}</p>}

          <form
            className={styles.composer}
            onSubmit={(event) => { event.preventDefault(); void send(); }}
          >
            <label className={styles.srOnly} htmlFor="assistant-input">Sua pergunta</label>
            <textarea
              id="assistant-input"
              ref={inputRef}
              rows={2}
              value={draft}
              disabled={busy}
              placeholder="Como faço para…"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Enter envia, Shift+Enter quebra linha: o padrão que quem usa
                // chat já espera.
                if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
              }}
            />
            <button type="submit" disabled={busy || !draft.trim()} aria-label="Enviar pergunta">
              <Send aria-hidden="true" />
            </button>
          </form>
        </>
      )}
    </aside>
  );
}
