"use client";

import Link from "next/link";
import { Menu, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { siteNavigation } from "@/lib/marketing";

/**
 * Menu do cabeçalho público em telas estreitas.
 *
 * Abaixo de 1180px a navegação da home era simplesmente escondida
 * (`display: none`) e nada tomava o lugar dela: no celular — que é onde a maior
 * parte do tráfego comercial chega — o site inteiro ficava sem Solução,
 * Funcionalidades, Integrações, Planos, FAQ e Contato. Não era um problema de
 * estilo; eram seis páginas inalcançáveis.
 *
 * O padrão aqui é o de divulgação (disclosure), não o de diálogo: o botão
 * declara `aria-expanded` e aponta para o painel que controla, o `Esc` fecha e
 * devolve o foco ao botão, e escolher um destino fecha junto. Não há armadilha
 * de foco, porque não há modal — o conteúdo atrás continua sendo conteúdo.
 */
export function SiteMenu({ actions }: { actions?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Fechar sem devolver o foco deixaria a pessoa no começo da página, sem
      // referência de onde estava: o `Esc` precisa desfazer a abertura inteira.
      buttonRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="site-menu">
      <button
        ref={buttonRef}
        type="button"
        className="site-menu-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X className="inline-icon" aria-hidden="true" /> : <Menu className="inline-icon" aria-hidden="true" />}
        <span>{open ? "Fechar menu" : "Menu"}</span>
      </button>

      {/* Sem `hidden` o painel continuaria no fluxo de tabulação com a altura
          zerada — o teclado passaria por seis links invisíveis. */}
      <div className="site-menu-panel" id={panelId} hidden={!open}>
        <nav aria-label="Navegação principal do site">
          {siteNavigation.map((item) => (
            <Link key={item.href} href={item.href} onClick={() => setOpen(false)}>{item.label}</Link>
          ))}
        </nav>
        {actions && <div className="site-menu-actions">{actions}</div>}
      </div>
    </div>
  );
}
