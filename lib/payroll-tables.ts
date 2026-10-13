/**
 * Tabelas legais do cálculo de folha do ERP DP, por vigência.
 *
 * Valores em centavos. Cada tabela diz a norma de onde veio: quem confere a
 * conta precisa conseguir achar a fonte sem perguntar a ninguém. Tabela nova
 * entra como item novo, com `validFrom` próprio — a anterior fica, porque o
 * recálculo de um mês passado usa a tabela daquele mês.
 *
 * Este arquivo é puro e vai para o navegador: a prévia da tela e o servidor
 * fazem a mesma conta.
 */

export type InssBracket = { upTo: number; rate: number };
export type InssTable = { validFrom: string; source: string; brackets: readonly InssBracket[] };

export type IrrfBracket = { upTo: number | null; rate: number; deduction: number };
export type IrrfTable = {
  validFrom: string;
  source: string;
  brackets: readonly IrrfBracket[];
  /** Dedução mensal por dependente. */
  dependent: number;
  /** Desconto simplificado mensal, alternativo às deduções legais. */
  simplified: number;
  /**
   * Redução do imposto (Lei 15.270/2025): zera o imposto até `fullUpTo` de
   * rendimento tributável bruto, e reduz em `a − b × rendimento` até
   * `partialUpTo`. Acima disso, não há redução.
   */
  reducer: { fullUpTo: number; fullAmount: number; partialUpTo: number; a: number; b: number } | null;
};

export type MinimumWage = { validFrom: string; source: string; amount: number };

export const inssTables: readonly InssTable[] = [
  {
    validFrom: "2025-01-01",
    source: "Portaria Interministerial MPS/MF nº 6/2025",
    brackets: [
      { upTo: 151_800, rate: 0.075 },
      { upTo: 279_388, rate: 0.09 },
      { upTo: 419_083, rate: 0.12 },
      { upTo: 815_741, rate: 0.14 },
    ],
  },
  {
    validFrom: "2026-01-01",
    source: "Portaria Interministerial MPS/MF nº 13/2026",
    brackets: [
      { upTo: 162_100, rate: 0.075 },
      { upTo: 290_284, rate: 0.09 },
      { upTo: 435_427, rate: 0.12 },
      { upTo: 847_555, rate: 0.14 },
    ],
  },
];

export const irrfTables: readonly IrrfTable[] = [
  {
    validFrom: "2025-01-01",
    source: "Lei 14.848/2024 (tabela vigente até abril de 2025)",
    brackets: [
      { upTo: 225_920, rate: 0, deduction: 0 },
      { upTo: 282_665, rate: 0.075, deduction: 16_944 },
      { upTo: 375_105, rate: 0.15, deduction: 38_144 },
      { upTo: 466_468, rate: 0.225, deduction: 66_277 },
      { upTo: null, rate: 0.275, deduction: 89_600 },
    ],
    dependent: 18_959,
    simplified: 56_480,
    reducer: null,
  },
  {
    validFrom: "2025-05-01",
    source: "MP 1.294/2025, convertida na Lei 15.191/2025",
    brackets: [
      { upTo: 242_880, rate: 0, deduction: 0 },
      { upTo: 282_665, rate: 0.075, deduction: 18_216 },
      { upTo: 375_105, rate: 0.15, deduction: 39_416 },
      { upTo: 466_468, rate: 0.225, deduction: 67_549 },
      { upTo: null, rate: 0.275, deduction: 90_873 },
    ],
    dependent: 18_959,
    simplified: 60_720,
    reducer: null,
  },
  {
    validFrom: "2026-01-01",
    source: "Lei 15.191/2025 (tabela progressiva) e Lei 15.270/2025 (redução)",
    brackets: [
      { upTo: 242_880, rate: 0, deduction: 0 },
      { upTo: 282_665, rate: 0.075, deduction: 18_216 },
      { upTo: 375_105, rate: 0.15, deduction: 39_416 },
      { upTo: 466_468, rate: 0.225, deduction: 67_549 },
      { upTo: null, rate: 0.275, deduction: 90_873 },
    ],
    dependent: 18_959,
    simplified: 60_720,
    reducer: { fullUpTo: 500_000, fullAmount: 31_289, partialUpTo: 735_000, a: 97_862, b: 0.133145 },
  },
];

export const minimumWages: readonly MinimumWage[] = [
  { validFrom: "2025-01-01", source: "Decreto 12.342/2024", amount: 151_800 },
  { validFrom: "2026-01-01", source: "Decreto 12.797/2025", amount: 162_100 },
];

/** A tabela vigente na data. Sem tabela para a data, o cálculo recusa — chutar a do ano seguinte daria um número errado com cara de certo. */
export function tableAt<T extends { validFrom: string }>(tables: readonly T[], date: string, code: string): T {
  const candidates = tables.filter((table) => table.validFrom <= date).sort((a, b) => b.validFrom.localeCompare(a.validFrom));
  const table = candidates[0];
  if (!table) throw Object.assign(new Error(`Sem tabela vigente em ${date}.`), { code });
  return table;
}
