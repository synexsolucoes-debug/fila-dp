"use client";

import { useEffect, useRef, useState } from "react";
import { Check, LogOut, Settings, ShieldCheck, UserRoundCog } from "lucide-react";
import { densityLabels, type Density } from "@/lib/density";
import { themeLabels, type ThemePreference } from "@/lib/theme";

type WorkspaceOption = { id: string; name: string; detail: string; disabled: boolean };

type AccountMenuProps = {
  name: string;
  email: string;
  initials: string;
  theme: ThemePreference;
  onTheme: (value: ThemePreference) => void;
  density: Density;
  onDensity: (value: Density) => void;
  workspaces: readonly WorkspaceOption[];
  currentWorkspaceId: string;
  onSwitchWorkspace: (id: string) => void;
  isAdmin: boolean;
  onAdministration: () => void;
  onSecurity: () => void;
  onSignOut: () => void;
  busy: boolean;
};

const themes: readonly ThemePreference[] = ["light", "dark", "system"];
const densities: readonly Density[] = ["comfortable", "compact"];

/**
 * Menu da conta, no avatar da faixa superior.
 *
 * Tudo o que morava em cinco ícones sem rótulo no pé da barra lateral — tema
 * que alternava em ciclo, densidade, engrenagem, troca de conta e sair. Ícone
 * que cicla estado não diz o que vai fazer, e por isso parecia não funcionar:
 * aqui cada opção tem nome e a escolha atual aparece marcada.
 */
export function AccountMenu(props: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = (action: () => void) => () => { setOpen(false); action(); };

  return (
    <div className="account-menu" ref={rootRef}>
      <button type="button" className="account-menu-trigger" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Conta de ${props.name}`} onClick={() => setOpen((state) => !state)}>
        <span>{props.initials}</span>
      </button>
      {open && <div className="account-menu-panel" role="menu">
        <div className="account-menu-identity">
          <strong>{props.name}</strong>
          <small>{props.email}</small>
        </div>

        {props.workspaces.length > 1 && <div className="account-menu-section">
          <span>Grupo</span>
          {props.workspaces.map((workspace) => <button key={workspace.id} type="button" role="menuitemradio"
            aria-checked={workspace.id === props.currentWorkspaceId}
            disabled={props.busy || workspace.disabled || workspace.id === props.currentWorkspaceId}
            onClick={run(() => props.onSwitchWorkspace(workspace.id))}>
            <span><b>{workspace.name}</b><small>{workspace.detail}</small></span>
            {workspace.id === props.currentWorkspaceId && <Check aria-hidden="true" />}
          </button>)}
        </div>}

        <div className="account-menu-section">
          <span>Aparência</span>
          <div className="account-menu-segmented" role="group" aria-label="Tema">
            {themes.map((theme) => <button key={theme} type="button" aria-pressed={props.theme === theme}
              onClick={() => props.onTheme(theme)}>{themeLabels[theme]}</button>)}
          </div>
          <div className="account-menu-segmented" role="group" aria-label="Densidade">
            {densities.map((density) => <button key={density} type="button" aria-pressed={props.density === density}
              onClick={() => props.onDensity(density)}>{densityLabels[density]}</button>)}
          </div>
        </div>

        <div className="account-menu-section">
          {props.isAdmin && <button type="button" role="menuitem" onClick={run(props.onAdministration)}>
            <Settings aria-hidden="true" /><span><b>Administração</b></span>
          </button>}
          <button type="button" role="menuitem" onClick={run(props.onSecurity)}>
            <ShieldCheck aria-hidden="true" /><span><b>Perfil e segurança</b></span>
          </button>
          <form method="post" action="/api/auth/logout">
            <input type="hidden" name="trocar" value="1" />
            <button type="submit" role="menuitem"><UserRoundCog aria-hidden="true" /><span><b>Entrar em outra conta</b></span></button>
          </form>
          <button type="button" role="menuitem" className="account-menu-danger" disabled={props.busy} onClick={run(props.onSignOut)}>
            <LogOut aria-hidden="true" /><span><b>Sair</b></span>
          </button>
        </div>
      </div>}
    </div>
  );
}
