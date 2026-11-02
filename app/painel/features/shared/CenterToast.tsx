"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { DialogPortal, useExitTransition } from "./motion";

/**
 * Aviso no centro da tela.
 *
 * Os recados de "salvo", "atualizado" e os erros apareciam cada um num canto,
 * com o desenho de cada tela. Agora todos usam este: centralizado, em vidro
 * fosco, entrando com um leve aumento e saindo do mesmo jeito. Não bloqueia a
 * tela: só o próprio aviso recebe clique, o resto continua usável por baixo.
 *
 * Quem decide quando o aviso some continua sendo a tela (o temporizador que ela
 * já tinha); aqui só se anima a entrada e a saída. A mensagem fica guardada
 * durante a saída, senão o aviso sumiria vazio.
 */
export function CenterToast({ message, tone = "success", onClose }: {
  /** Texto do aviso; vazio ou nulo esconde. */
  message: string | null | undefined;
  tone?: "success" | "error";
  /** Mostra o botão de fechar. Erros devem ter, porque não somem sozinhos. */
  onClose?: () => void;
}) {
  const open = Boolean(message);
  const { mounted, state } = useExitTransition(open, 220);
  // Ajuste de estado no render (padrão do React para derivar de props): a
  // mensagem fica guardada enquanto o aviso sai.
  const [shown, setShown] = useState({ message: message ?? "", tone });
  if (message && (message !== shown.message || tone !== shown.tone)) setShown({ message, tone });
  if (!mounted) return null;
  const Icon = shown.tone === "error" ? AlertCircle : CheckCircle2;
  return (
    <DialogPortal>
      <div className="center-toast-layer">
        <div className="center-toast" data-tone={shown.tone} data-state={state}
          role={shown.tone === "error" ? "alert" : "status"} aria-live={shown.tone === "error" ? "assertive" : "polite"}>
          <Icon aria-hidden="true" />
          <span>{shown.message}</span>
          {onClose && <button type="button" onClick={onClose} aria-label="Fechar aviso"><X aria-hidden="true" /></button>}
        </div>
      </div>
    </DialogPortal>
  );
}
