/**
 * As etapas do ciclo de folha, em um lugar só.
 *
 * `cycleStages` vivia dentro de `OperationsView.tsx`, privado dela. Quando a
 * Visão geral passou a mostrar o fluxo da competência, copiar a lista teria
 * criado a segunda definição — e este repositório já pagou por isso: o
 * cabeçalho de painel estava definido três vezes, o selo de status cinco e o
 * aviso de erro dez, dois deles sem `role="alert"`.
 *
 * Os estados são os que o servidor aceita em `lib/operations.ts`
 * (`cycleStatuses`), nesta ordem — trocar a ordem aqui muda o desenho do
 * fluxo, então ela não é decorativa.
 */
export const cycleStages = [
  { status: "open", label: "Aberta", note: "Receber entradas" },
  { status: "pre_closing", label: "Pré-fechamento", note: "Validar gates" },
  { status: "processing", label: "Processamento", note: "Executar folha" },
  { status: "post_closing", label: "Pós-fechamento", note: "Conciliar saídas" },
  { status: "closed", label: "Concluída", note: "Ciclo protegido" },
] as const;

export type CycleStatus = (typeof cycleStages)[number]["status"];

/** Posição da etapa na sequência; -1 para estado desconhecido. */
export function stageIndex(status: string) {
  return cycleStages.findIndex((stage) => stage.status === status);
}

/** "2026-08" → "ago / 2026". Competência é mês, e mês se lê por extenso. */
export function competenceLabel(competence: string) {
  const match = /^(\d{4})-(\d{2})$/u.exec(competence);
  if (!match) return competence;
  const mes = new Date(`${competence}-01T12:00:00`).toLocaleDateString("pt-BR", { month: "short" });
  return `${mes.replace(".", "")} / ${match[1]}`;
}

/**
 * Onde a operação está, olhando todos os ciclos da competência.
 *
 * O avanço é o do ciclo **menos adiantado**: com três empresas, duas fechadas
 * e uma ainda aberta, a competência do grupo não está fechada. Dizer que está
 * seria a mesma classe de mentira que o seletor de empresa cometia quando
 * ignorava o recorte — um número que parece responder e responde outra coisa.
 */
export function cycleProgress(cycles: ReadonlyArray<{ status: string }>) {
  if (!cycles.length) return null;
  const indices = cycles.map((cycle) => stageIndex(cycle.status)).filter((index) => index >= 0);
  if (!indices.length) return null;
  const atual = Math.min(...indices);
  const concluidos = cycles.filter((cycle) => cycle.status === "closed").length;
  return {
    /** Índice da etapa em que a operação está, do ciclo menos adiantado. */
    atual,
    /** Quantos ciclos já fecharam, dos que existem na competência. */
    concluidos,
    total: cycles.length,
    /** Todos fecharam. */
    completa: concluidos === cycles.length,
  };
}

/** "2026-11" + 2 → "2027-01". Competência é mês, e mês vira a conta em meses. */
export function shiftCompetence(competence: string, months: number) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/u.exec(competence);
  if (!match) return competence;
  const total = Number(match[1]) * 12 + (Number(match[2]) - 1) + months;
  if (total < 0) return competence;
  const ano = Math.floor(total / 12);
  const mes = (total % 12) + 1;
  return `${String(ano).padStart(4, "0")}-${String(mes).padStart(2, "0")}`;
}

export type CompetenceChoice = { competence: string; open: boolean };

/**
 * As competências que o seletor pode oferecer — as abertas e as que ainda não
 * existem.
 *
 * O seletor listava só os ciclos já criados. Quem abrisse a competência do mês
 * corrente ficava sem nenhum mês livre para escolher, e o botão "Abrir
 * competência" — que só aparece quando o mês da tela não tem ciclo — sumia da
 * tela para sempre: não havia como abrir novembro em outubro, nem como abrir
 * um mês antigo que ninguém abriu na época. A abertura existia no servidor e
 * no diálogo, e mesmo assim era inalcançável.
 *
 * A janela, então, é de meses e não de ciclos: os doze anteriores e os três
 * seguintes ao mês de referência, mais tudo que já existe no banco, mais o que
 * estiver selecionado. `open` diz quais já têm ciclo, para a tela marcar as
 * outras em vez de fingir que todas são iguais.
 */
export function competenceWindow(
  existing: readonly string[],
  options: { reference?: string; back?: number; forward?: number; selected?: string } = {},
): CompetenceChoice[] {
  const { reference = new Date().toISOString().slice(0, 7), back = 12, forward = 3, selected = "" } = options;
  const valid = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/u.test(value);
  const abertas = new Set(existing.filter(valid));
  const meses = new Set(abertas);
  if (valid(reference)) for (let offset = -back; offset <= forward; offset += 1) meses.add(shiftCompetence(reference, offset));
  if (valid(selected)) meses.add(selected);
  return [...meses].sort().reverse().map((competence) => ({ competence, open: abertas.has(competence) }));
}

/** O primeiro mês da janela sem ciclo, para sugerir no diálogo de abertura. */
export function nextFreeCompetence(existing: readonly string[], preferred = new Date().toISOString().slice(0, 7)) {
  const abertas = new Set(existing);
  if (!abertas.has(preferred)) return preferred;
  for (let offset = 1; offset <= 24; offset += 1) {
    const candidato = shiftCompetence(preferred, offset);
    if (!abertas.has(candidato)) return candidato;
  }
  return preferred;
}
