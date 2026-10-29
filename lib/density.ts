/**
 * Densidade do painel — o "cozy/compact" do SAP Fiori.
 *
 * O Fiori entrega toda tela em duas densidades com o mesmo desenho: a
 * confortável, com alvo de toque, para quem usa tablet ou lê de passagem; e a
 * compacta, para quem passa o dia num desktop com mouse e quer ver mais linhas
 * de uma vez. Os ERPs de gestão pública (Centi e parentes) vivem só na segunda:
 * cadastro, folha e conferência são telas lidas linha a linha, e cada linha a
 * menos de rolagem é uma comparação que não se perde.
 *
 * O Vinculato nasceu confortável. Esta preferência devolve a escolha a quem
 * usa, sem trocar o desenho de nenhuma tela — `data-density="compact"` na casca
 * só aperta espaçamento e altura de controle (ver `app/design-centi-sap.css`).
 *
 * Fica em `localStorage`, e não em cookie como o tema, porque não muda cor:
 * a primeira pintura confortável seguida da compacta é um ajuste de espaço, não
 * o lampejo branco que fez o tema ir para cookie.
 */

export type Density = "comfortable" | "compact";

export const DENSITY_KEY = "vinculato-densidade";

const DENSITIES: readonly Density[] = ["comfortable", "compact"];

export const densityLabels: Record<Density, string> = {
  comfortable: "Confortável",
  compact: "Compacta",
};

/** Valor guardado é entrada de fora: o que não for do vocabulário vira o padrão. */
export function parseDensity(value: string | undefined | null): Density {
  return DENSITIES.includes(value as Density) ? (value as Density) : "comfortable";
}

export function nextDensity(current: Density): Density {
  return current === "compact" ? "comfortable" : "compact";
}
