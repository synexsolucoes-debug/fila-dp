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

/**
 * Rotinas fixas do mês (aba Calendário mensal da planilha). `companies: null`
 * = todas as empresas internas; a lista usa CODEMP e é resolvida para id.
 * Admissões (1–26) e rescisões (1–30) não são rotina: são janela de prazo nas
 * regras de corte abaixo.
 */
export const recurringTemplates = [
  { code: "fechamento-impostos", name: "Fechamento de impostos (eSocial periódicos, DCTFWeb)", frequency: "monthly", dayStart: 1, dayEnd: 15, scope: "cnpj_root", companies: null, processType: "ROTINA DP" },
  { code: "boletos-ponto", name: "Emissão de boletos do ponto", frequency: "monthly", dayStart: 1, dayEnd: 15, scope: "company", companies: null, processType: "ROTINA DP" },
  { code: "planos-saude", name: "Planos de saúde ao financeiro + coparticipação", frequency: "monthly", dayStart: 1, dayEnd: 19, scope: "company", companies: null, processType: "BENEFÍCIOS" },
  { code: "fechamento-ponto", name: "Fechamento de ponto", frequency: "monthly", dayStart: 26, dayEnd: 28, scope: "company", companies: null, processType: "PONTO" },
  { code: "eventos-a-parte", name: "Lançamento de eventos à parte", frequency: "monthly", dayStart: 26, dayEnd: 30, scope: "company", companies: null, processType: "VARIÁVEIS" },
  { code: "caju", name: "Caju", frequency: "monthly", dayStart: 30, dayEnd: 30, scope: "company", companies: ["30", "20", "33", "31", "34"], processType: "BENEFÍCIOS" },
  { code: "wellhub", name: "Wellhub: inclusões e exclusões", frequency: "weekly", weekday: 5, scope: "company", companies: null, processType: "BENEFÍCIOS", listWeekMovements: true },
];

/**
 * Regras de corte (aba Prazos de corte). `processTypes` são os tipos de
 * processo das demandas a que a regra se aplica — inclusive os que o Teams e
 * as integrações usam. Alteração salarial fica em `proposta` até o dia do mês
 * ser definido com as áreas: regra em proposta não marca ninguém como atrasado.
 */
export const cutoffRules = [
  { code: "admissao", name: "Admissão", processTypes: ["CONCILIAÇÃO CADASTRAL", "ADMISSÃO"], kind: "antecedencia_dias_uteis", value: 3, monthDayLimit: 26, status: "aprovada",
    description: "Antecedência mínima de 3 dias úteis antes do início; janela do mês até o dia 26." },
  { code: "rescisao", name: "Rescisão", processTypes: ["RESCISÃO", "DESLIGAMENTO"], kind: "mesmo_dia", value: 0, monthDayLimit: null, status: "aprovada",
    description: "Comunicar no mesmo dia da decisão (pagamento em até 10 dias do término — CLT art. 477 §6º)." },
  { code: "ferias", name: "Férias", processTypes: ["FÉRIAS"], kind: "antecedencia_dias_corridos", value: 40, monthDayLimit: null, status: "aprovada",
    description: "Solicitar com 40 dias de antecedência (aviso de 30 dias — art. 135; pagamento 2 dias antes — art. 145)." },
  { code: "ponto", name: "Ponto aprovado pelo gestor", processTypes: ["PONTO"], kind: "dia_do_mes", value: 25, monthDayLimit: null, status: "aprovada",
    description: "Ponto aprovado pelo gestor até o dia 25." },
  { code: "variaveis", name: "Variáveis (comissões, HE, descontos)", processTypes: ["VARIÁVEIS"], kind: "dia_do_mes", value: 26, monthDayLimit: null, status: "aprovada",
    description: "Variáveis lançadas até o dia 26 da competência." },
  { code: "alteracao", name: "Alteração salarial / cargo / transferência", processTypes: ["ALTERAÇÃO SALARIAL", "ALTERAÇÃO DE CARGO/FUNÇÃO", "TRANSFERÊNCIA"], kind: "dia_do_mes", value: 20, monthDayLimit: null, status: "proposta",
    description: "Até o dia definido no mês de vigência (dia 20 como proposta, a confirmar com as áreas)." },
  { code: "atestados", name: "Atestados e afastamentos", processTypes: ["AFASTAMENTO", "ATESTADO"], kind: "ate_dias_apos", value: 2, monthDayLimit: null, status: "aprovada",
    description: "Até 48 horas do fato." },
];
