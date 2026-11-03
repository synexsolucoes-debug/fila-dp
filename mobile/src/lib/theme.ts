/**
 * Paleta do Vinculato Campo.
 *
 * São os mesmos valores do app de campo na web (`app/campo/field.module.css`),
 * que por sua vez são os de `.dashboard-shell.theme-dark`. Uma superfície só,
 * escura, alto contraste: o app é usado em galpão, sob luz forte ou fraca, e
 * de luva.
 */
export const colors = {
  bg: "#07111f",
  surface: "#0d1b2d",
  muted: "#102238",
  border: "#233852",
  text: "#f4f7fb",
  soft: "#bdcad9",
  accent: "#365cf5",
  accentText: "#b9c8ff",
  accentSoft: "#1b3265",
  onAccent: "#ffffff",
  success: "#79dfb9",
  warning: "#f3c87d",
  danger: "#ffaaa8",
} as const;

/** Alvo mínimo de toque. O padrão pede 44pt; com luva, 48 é o que acerta. */
export const TARGET = 48;

export const radius = { sm: 10, md: 13, lg: 16, pill: 999 } as const;

export const font = {
  caption: 13,
  body: 15,
  label: 13,
  title: 17,
  number: 24,
} as const;
