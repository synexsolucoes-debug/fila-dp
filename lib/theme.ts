/**
 * Tema do painel (§7).
 *
 * O produto entrega duas escalas — a clara da maquete aprovada e a escura que
 * sempre esteve declarada — e a escolha é de quem usa, não do produto.
 *
 * A preferência vive em **cookie**, não em `localStorage`, e a razão é a mesma
 * que a rota coringa do painel já registra: estado inicial no servidor não
 * pisca. Com `localStorage` a página só descobre o tema depois de hidratar, e
 * quem escolheu escuro vê um lampejo branco em cada carregamento — num painel
 * que se abre dezenas de vezes por dia, isso não é detalhe.
 *
 * "Sistema" é o caso que o servidor não consegue responder sozinho:
 * `prefers-color-scheme` só existe no navegador. Por isso são dois cookies. O
 * primeiro guarda a escolha ("sistema"), o segundo guarda o que o navegador
 * respondeu da última vez. Na primeira visita o servidor erra para claro e o
 * cliente corrige; da segunda em diante acerta de saída.
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/** A escolha da pessoa. */
export const THEME_COOKIE = "vinculato-theme";
/** O que o navegador respondeu por último, para o servidor resolver "sistema". */
export const THEME_SYSTEM_COOKIE = "vinculato-theme-system";

/** Um ano: a preferência não deve expirar antes de a pessoa mudar de ideia. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

/**
 * Lê um valor de cookie sem confiar nele.
 *
 * Cookie é entrada de fora: qualquer string pode chegar aqui, inclusive de um
 * navegador de outra versão do produto. O que não pertence ao vocabulário vira
 * o padrão, nunca uma classe de CSS inventada.
 */
export function parseThemePreference(value: string | undefined | null): ThemePreference {
  return PREFERENCES.includes(value as ThemePreference) ? (value as ThemePreference) : "system";
}

export function parseResolvedTheme(value: string | undefined | null): ResolvedTheme {
  return value === "dark" ? "dark" : "light";
}

/**
 * A escala que de fato vai à tela.
 *
 * `systemTheme` é o que o navegador respondeu por último. Quando não há
 * resposta guardada, claro — que é a escala que a maquete aprovou, e portanto o
 * erro menos surpreendente numa primeira visita.
 */
export function resolveTheme(preference: ThemePreference, systemTheme: ResolvedTheme): ResolvedTheme {
  return preference === "system" ? systemTheme : preference;
}

/** A ordem do botão que percorre os três estados. */
export function nextThemePreference(current: ThemePreference): ThemePreference {
  return PREFERENCES[(PREFERENCES.indexOf(current) + 1) % PREFERENCES.length]!;
}

export const themeLabels: Record<ThemePreference, string> = {
  system: "Sistema",
  light: "Claro",
  dark: "Escuro",
};
