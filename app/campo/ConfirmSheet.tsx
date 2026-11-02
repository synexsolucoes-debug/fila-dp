"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import styles from "./field.module.css";

/**
 * Pergunta de confirmação do Vinculato Campo.
 *
 * Substitui o `window.confirm`: a caixa nativa sai com o visual do navegador
 * (no iPhone, com o endereço do site no título), quebra a sensação de app
 * instalado e não segue o tema. Esta folha usa os mesmos botões do app, e a
 * guarda de foco global (`app/components/ModalFocusGuard.tsx`) prende o Tab e
 * devolve o foco a quem perguntou.
 *
 * Uso: `if (!(await askConfirm({ ... }))) return;` — mesma forma do
 * `window.confirm`, só que assíncrona.
 */
type Question = {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  resolve: (answer: boolean) => void;
};

let current: Question | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export function askConfirm(input: Omit<Question, "resolve">): Promise<boolean> {
  current?.resolve(false);
  return new Promise((resolve) => {
    current = { ...input, resolve };
    emit();
  });
}

function answer(value: boolean) {
  const question = current;
  current = null;
  emit();
  question?.resolve(value);
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function ConfirmHost() {
  const question = useSyncExternalStore(subscribe, () => current, () => null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!question) return;
    // Foco no "Voltar": Enter por engano não confirma uma ação definitiva.
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") answer(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [question]);

  if (!question) return null;
  return <div className={styles.confirmBackdrop} onClick={(event) => { if (event.target === event.currentTarget) answer(false); }}>
    <div className={styles.confirmSheet} role="alertdialog" aria-modal="true" aria-labelledby="campo-confirm-title" aria-describedby="campo-confirm-text">
      <strong id="campo-confirm-title">{question.title}</strong>
      <p id="campo-confirm-text">{question.message}</p>
      <div className={styles.confirmActions}>
        <button ref={cancelRef} type="button" className={styles.secondaryButton} onClick={() => answer(false)}>Voltar</button>
        <button type="button" className={styles.primaryButton} data-danger={question.danger ? "true" : undefined} onClick={() => answer(true)}>
          {question.confirmLabel}
        </button>
      </div>
    </div>
  </div>;
}
