"use client";

import { useEffect } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, X } from "lucide-react";
import { VinculatoLogo } from "@/app/components/VinculatoLogo";

export type LauncherModule = {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
};

type ModuleLauncherProps = {
  userName: string;
  workspaceName: string;
  modules: readonly LauncherModule[];
  /** No tema escuro o logotipo azul-marinho fica ilegível. */
  theme: "light" | "dark";
  onOpen: (id: string) => void;
  /** Ausente na entrada depois do login: ali a escolha do módulo é o passo
   *  seguinte, e não há tela atrás da janela para onde voltar. */
  onClose?: () => void;
};

/**
 * Janela de módulos.
 *
 * É a porta de entrada depois do login e o atalho do topo do painel para trocar
 * de módulo. A lista chega pronta e já recortada pelo plano e pelo papel de
 * quem está olhando — esta janela só desenha. Um módulo que a pessoa não abre
 * não vira cartão, pelo mesmo motivo que não vira item de menu (§30).
 */
export function ModuleLauncher({ userName, workspaceName, modules, theme, onOpen, onClose }: ModuleLauncherProps) {
  useEffect(() => {
    if (!onClose) return;
    const close = onClose;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const firstName = userName.trim().split(/\s+/u)[0] || userName;

  return (
    <div className="module-launcher" role="dialog" aria-modal="true" aria-labelledby="module-launcher-title">
      <div className="module-launcher-panel">
        <header className="module-launcher-head">
          <VinculatoLogo size={34} tone={theme === "dark" ? "light" : "color"} priority />
          {onClose && <button type="button" className="module-launcher-close" onClick={onClose} aria-label="Fechar janela de módulos">
            <X aria-hidden="true" />
          </button>}
        </header>
        <div className="module-launcher-intro">
          <span>{workspaceName}</span>
          <h1 id="module-launcher-title">Olá, {firstName}. Qual módulo você quer abrir?</h1>
          <p>Aparecem aqui apenas os módulos liberados para o seu acesso.</p>
        </div>
        {modules.length === 0 ? (
          <p className="module-launcher-empty">Nenhum módulo foi liberado para o seu acesso. Fale com o administrador do seu grupo.</p>
        ) : (
          <ul className="module-launcher-grid">
            {modules.map((module, index) => {
              const Icon = module.icon;
              return (
                <li key={module.id}>
                  <button type="button" onClick={() => onOpen(module.id)} autoFocus={index === 0}>
                    <span className="module-launcher-icon"><Icon aria-hidden="true" /></span>
                    <strong>{module.label}</strong>
                    <small>{module.description}</small>
                    <ArrowRight className="module-launcher-arrow" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
