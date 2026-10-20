/**
 * Carteira inicial do DP da Opyt (aba Empresas de `Controle_DP_Opyt.xlsx`).
 *
 * Dado de um cliente só: não entra em migration. É aplicado por
 * `scripts/seed-dp-carteira.mjs` no workspace indicado. Titular e backup são
 * apelidos resolvidos por e-mail na linha de comando (`--pessoa Odete=...`).
 *
 * A 40 (Goianésia) é matriz da raiz 43.944.672 e aparece no Sankhya com os
 * mesmos funcionários da 33 (Goiânia); fica `sem_funcionarios`, e a
 * sincronização ignora os registros dela.
 */
export const companies = [
  { code: "10", name: "OPYT INHUMAS", taxId: "10.299.958/0001-89", dpStatus: "interno", holder: "Odete", backup: "Rian" },
  { code: "31", name: "OPYT TRINDADE MAYSA", taxId: "33.117.686/0001-54", dpStatus: "interno", holder: "Odete", backup: "Rian" },
  { code: "33", name: "OPYT GOIANIA", taxId: "43.944.672/0003-20", dpStatus: "interno", holder: "Rian", backup: "Odete" },
  { code: "40", name: "OPYT GOIANESIA", taxId: "43.944.672/0001-68", dpStatus: "sem_funcionarios", holder: "Rian", backup: "Odete" },
  { code: "51", name: "SUA FIBRA LTDA", taxId: "37.578.162/0001-11", dpStatus: "interno", holder: "Rian", backup: "Odete" },
  { code: "30", name: "ULTRA TELECOM", taxId: "26.016.500/0001-05", dpStatus: "interno", holder: "Rian", backup: "Odete" },
  { code: "20", name: "TURBINET", taxId: "53.023.435/0001-18", dpStatus: "interno", holder: "Rian", backup: "Odete" },
  { code: "34", name: "GR CANEDO", taxId: "59.663.897/0001-86", dpStatus: "interno", holder: "Rian", backup: "Odete" },
  { code: "46", name: "INTEGRATO FIBRA", taxId: "17.104.489/0001-44", dpStatus: "a_internalizar", holder: null, backup: null },
  // Sem CODEMP e sem CNPJ ainda: entra pelo nome, para aparecer na carteira.
  { code: "", name: "EVVIVA", taxId: "", dpStatus: "a_internalizar", holder: null, backup: null },
];
