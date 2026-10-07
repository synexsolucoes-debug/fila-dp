/**
 * Taxa da Caju sobre o complemento, em centavos.
 *
 * A taxa vem em pontos-base (199 = 1,99%) para que o cálculo seja inteiro de
 * ponta a ponta: percentual em ponto flutuante gera diferença de um centavo
 * entre a tela e a planilha, e é o total que o DP confere.
 */
export const CAJU_FEE_BPS = 199;

/** Arredonda meio-centavo para cima, igual ao resto dos cálculos de pagamento. */
export function cajuFeeCents(amountCents: number, feeBps = CAJU_FEE_BPS) {
  if (!Number.isFinite(amountCents) || amountCents <= 0 || feeBps <= 0) return 0;
  return Math.round((amountCents * feeBps) / 10000);
}

/** Valor líquido depois de descontada a taxa. */
export function cajuNetCents(amountCents: number, feeBps = CAJU_FEE_BPS) {
  return Math.max(0, amountCents - cajuFeeCents(amountCents, feeBps));
}

export const formatFeePercent = (feeBps = CAJU_FEE_BPS) =>
  `${(feeBps / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
