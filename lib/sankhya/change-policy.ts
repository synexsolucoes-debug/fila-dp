/**
 * O que o Agente Sankhya grava sozinho, e o que ele leva a alguém decidir.
 *
 * Até aqui a importação gravava tudo: colaborador novo entrava direto, e
 * qualquer campo alterado na origem sobrescrevia o do Vinculato. O agente não
 * escrevia no Sankhya — mas escrevia no domínio, sem passar por decisão de
 * ninguém.
 *
 * A regra agora é a que separa **transcrição** de **decisão**:
 *
 *   - Mudou o telefone, o e-mail, o nome do departamento? Transcrição. O agente
 *     grava. Parar a operação para confirmar um telefone treinaria a pessoa a
 *     confirmar sem ler, que é pior do que não perguntar.
 *
 *   - Nasceu um colaborador, mudou o salário, mudou o cargo, mudou a situação
 *     do vínculo, apareceu ou sumiu data de desligamento? Decisão. Vira
 *     proposta, e o Vinculato só muda quando alguém confirma.
 *
 * O critério não é "quão raro" — é **o que dói se estiver errado**. Um telefone
 * errado se corrige quando alguém liga. Um desligamento inventado tira a pessoa
 * da folha, e um salário errado paga errado; nenhum dos dois se descobre olhando
 * a tela, e os dois têm prazo legal.
 *
 * ## Por que a criação inteira é decisão
 *
 * Colaborador novo vindo da origem pode ser admissão de verdade — ou o mesmo
 * colaborador que já existe, com matrícula nova, CPF digitado diferente ou
 * cadastro duplicado no Sankhya. O agente não tem como distinguir, e um
 * duplicado criado em silêncio vira duas folhas para a mesma pessoa. Quem
 * decide é quem consegue olhar os dois lados.
 *
 * ## O que esta decisão não muda
 *
 * O agente continua somente leitura na origem, e a proposta continua sendo
 * avaliada pelo motor determinístico antes de virar qualquer coisa. Isto aqui
 * não é uma segunda régua de automação: é o que entra na régua.
 */

/** Campos cujo erro custa dinheiro, vínculo ou prazo legal. */
export const SENSITIVE_EMPLOYEE_FIELDS = [
  "salaryCents",
  "employmentStatus",
  "terminationDate",
  "positionCode",
  "positionName",
] as const;

export type SankhyaChangeClassification = "new" | "changed" | "unchanged";

export type ChangeDecision = {
  /** `direct` grava agora; `proposal` espera decisão; `none` não faz nada. */
  outcome: "direct" | "proposal" | "none";
  /** Por que, em uma frase que a triagem mostra. Vazio quando não há o que dizer. */
  reason: string;
  /** Os campos sensíveis que motivaram a proposta, para a tela listar. */
  sensitiveFields: string[];
};

/** Rótulos dos campos sensíveis; a triagem não mostra `salaryCents`. */
export const SENSITIVE_FIELD_LABELS: Record<string, string> = {
  salaryCents: "Salário",
  employmentStatus: "Situação do vínculo",
  terminationDate: "Data de desligamento",
  positionCode: "Cargo",
  positionName: "Cargo",
};

export function sensitiveFieldLabel(field: string) {
  return SENSITIVE_FIELD_LABELS[field] ?? field;
}

/**
 * O que fazer com o que a leitura encontrou.
 *
 * Função pura de propósito: ela é a regra, e uma regra que precisa de banco
 * para ser exercitada é uma regra que ninguém testa nos casos difíceis.
 */
export function decideSankhyaChange(input: {
  classification: SankhyaChangeClassification;
  changedFields: readonly string[];
}): ChangeDecision {
  if (input.classification === "unchanged") {
    return { outcome: "none", reason: "", sensitiveFields: [] };
  }

  if (input.classification === "new") {
    return {
      outcome: "proposal",
      reason: "Colaborador encontrado na origem sem correspondência no Vinculato. Pode ser uma admissão nova ou o mesmo colaborador com cadastro duplicado — criar sem conferir produziria duas folhas para a mesma pessoa.",
      sensitiveFields: [],
    };
  }

  const sensitive = [...new Set(
    input.changedFields.filter((field) => (SENSITIVE_EMPLOYEE_FIELDS as readonly string[]).includes(field)),
  )];
  if (sensitive.length === 0) {
    return { outcome: "direct", reason: "", sensitiveFields: [] };
  }

  const nomes = [...new Set(sensitive.map(sensitiveFieldLabel))];
  return {
    outcome: "proposal",
    reason: `A origem mudou ${nomes.length === 1 ? nomes[0].toLowerCase() : nomes.join(", ").toLowerCase()}. Alteração desse tipo entra na folha e tem prazo legal, então o Vinculato espera confirmação antes de gravar.`,
    sensitiveFields: sensitive,
  };
}

/** Uma mudança que espera decisão, pronta para virar proposta. */
export type EmployeeChangeProposal = {
  employeeId: string;
  classification: SankhyaChangeClassification;
  reason: string;
  sensitiveFields: string[];
  idempotencyKey: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

/**
 * A ação proposta, no vocabulário que o motor determinístico já conhece.
 *
 * Criar colaborador e alterar dado sensível são coisas diferentes para quem
 * decide, e por isso são ações diferentes — juntá-las numa só faria a triagem
 * mostrar "atualizar colaborador" sobre uma admissão que ninguém confirmou.
 */
export function proposedActionFor(classification: SankhyaChangeClassification) {
  return classification === "new" ? "employee.create" : "employee.update";
}

/**
 * A confiança que a proposta carrega.
 *
 * Deliberadamente baixa: o agente leu corretamente, mas o que ele leu **não
 * decide** se a mudança deve entrar. Uma confiança alta aqui empurraria a
 * proposta para a faixa automática do motor e devolveria exatamente a gravação
 * direta que esta política existe para tirar do caminho.
 */
export const CHANGE_PROPOSAL_CONFIDENCE = 0.4;
