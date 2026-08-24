/**
 * Consultas operacionais nomeadas (§60, §61, §62, §63).
 *
 * A postura de segurança da IA não muda: **o modelo não recebe SQL e não recebe
 * acesso a tabela**. O que muda é a utilidade. Até aqui o assistente sabia
 * apenas quem estava perguntando e que telas existiam, então respondia "onde
 * fica" e nunca "como está". Perguntas que o DP faz todo dia — *quais admissões
 * estão paradas?*, *o que trava o fechamento?* — não tinham resposta.
 *
 * O caminho é um catálogo fechado. Cada pergunta que o produto autoriza vira
 * uma consulta escrita por nós, com a capacidade que a libera declarada ao
 * lado. O servidor:
 *
 *   1. valida o usuário;
 *   2. valida a capability;
 *   3. aplica o workspace;
 *   4. aplica o escopo de empresa;
 *   5. executa a consulta definida;
 *   6. agrega;
 *   7. remove PII desnecessária;
 *   8. entrega o resultado ao modelo.
 *
 * A IA apenas redige. Ela nunca escolhe a consulta a executar por conta
 * própria — quem escolhe é o `matchNamedQueries` determinístico abaixo, ou o
 * próprio usuário pela tela.
 *
 * ## O passo 7 não é decorativo
 *
 * O resultado é **agregado por construção**: contagens, o mais antigo, o total
 * por empresa. Nenhuma consulta devolve nome de colaborador, CPF, salário ou
 * valor individual. Isso não depende de a redação pegar depois — o dado
 * pessoal não é selecionado. Há teste que reprova uma consulta que traga
 * coluna de identificação pessoal.
 */
import type { Capability } from "../authorization.ts";

export type NamedQueryDefinition = {
  key: string;
  /** Pergunta em português, do jeito que a pessoa faz. */
  question: string;
  /** O que a resposta significa — entra no contexto do modelo. */
  description: string;
  capability: Capability;
  /** Coluna de empresa para o escopo; vazio quando a consulta não é por empresa. */
  companyColumn: string;
  /** `true` quando a consulta depende de quem perguntou. */
  personal: boolean;
  /** Termos que fazem a pergunta do usuário casar com esta consulta. */
  triggers: readonly string[];
  sql: string;
};

/**
 * Colunas que uma consulta nomeada **nunca** pode selecionar.
 *
 * Lista explícita e verificada por teste: é mais barato recusar aqui do que
 * descobrir num log de provedor que o nome de um colaborador saiu do ambiente.
 */
export const FORBIDDEN_RESULT_COLUMNS = [
  "cpf", "tax_id", "document_number", "full_name", "employee_name", "email",
  "phone", "bank_account", "salary", "base_salary", "net_amount", "gross_amount",
  "password", "token", "secret",
] as const;

export const namedQueries: readonly NamedQueryDefinition[] = [
  {
    key: "work.overdue",
    question: "Quais demandas estão vencidas?",
    description: "Quantidade de demandas com SLA vencido, a mais antiga e a distribuição por empresa.",
    capability: "cards.read",
    companyColumn: "c.company_id",
    personal: false,
    triggers: ["demanda vencida", "demandas vencidas", "atrasada", "atrasadas", "sla vencido", "fora do prazo"],
    sql: `SELECT count(*)::int AS total,
        min(c.due_at)::text AS mais_antiga,
        count(DISTINCT c.company_id)::int AS empresas
      FROM fdp_cards c
      WHERE c.workspace_id = ? AND c.archived = 0 AND c.closed_at IS NULL
        AND c.sla_status = 'overdue' {{company}}`,
  },
  {
    key: "admissions.stalled",
    question: "Quais admissões estão paradas?",
    description: "Consultas de admissão sem mudança de situação há mais de sete dias, por situação normalizada.",
    capability: "employees.read",
    companyColumn: "a.company_id",
    personal: false,
    triggers: ["admissão parada", "admissoes paradas", "admissão travada", "admissão pendente", "admissões"],
    sql: `SELECT count(*)::int AS total,
        count(*) FILTER (WHERE a.normalized_status = 'waiting_documents')::int AS aguardando_documento,
        count(*) FILTER (WHERE a.normalized_status = 'unknown')::int AS situacao_desconhecida,
        min(a.requested_at)::text AS mais_antiga
      FROM fdp_tangerino_admission_consultations a
      WHERE a.workspace_id = ? AND a.state = 'DONE'
        AND a.requested_at < now() - interval '7 days' {{company}}`,
  },
  {
    key: "processes.late",
    question: "Quais processos estão atrasados?",
    description: "Demandas orientadas a processo com prazo vencido, agrupadas por processo e etapa.",
    capability: "processes.read",
    companyColumn: "c.company_id",
    personal: false,
    triggers: ["processo atrasado", "processos atrasados", "etapa parada", "processo travado", "fora de sla"],
    sql: `SELECT count(*)::int AS total,
        count(DISTINCT c.process_definition_id)::int AS processos,
        count(DISTINCT c.current_step_id)::int AS etapas,
        min(c.due_at)::text AS mais_antiga
      FROM fdp_cards c
      WHERE c.workspace_id = ? AND c.archived = 0 AND c.closed_at IS NULL
        AND c.process_version_id IS NOT NULL AND c.sla_status = 'overdue' {{company}}`,
  },
  {
    key: "closing.blockers",
    question: "O que está bloqueando o fechamento?",
    description: "Pendências bloqueantes e itens de fechamento em aberto, com o prazo mais próximo.",
    capability: "pending_items.read",
    companyColumn: "p.company_id",
    personal: false,
    triggers: ["bloqueio do fechamento", "bloqueando o fechamento", "travando o fechamento", "fechamento", "bloqueante"],
    sql: `SELECT count(*)::int AS total,
        count(*) FILTER (WHERE p.blocking = 1)::int AS bloqueantes,
        min(p.due_date)::text AS prazo_mais_proximo,
        count(DISTINCT p.company_id)::int AS empresas
      FROM fdp_operational_pending_items p
      WHERE p.workspace_id = ? AND p.status IN ('open', 'in_progress') {{company}}`,
  },
  {
    key: "pj.missing_invoice",
    question: "Quais PJs ainda precisam enviar nota?",
    description: "Fechamentos PJ com nota esperada e ainda não recebida, e o total esperado em centavos.",
    capability: "contractors.payments.read",
    companyColumn: "k.company_id",
    personal: false,
    triggers: [
      "nota fiscal", "nota prestador", "pj nota", "enviar nota", "nota pendente",
      "falta nota", "nf pendente", "prestador pendente",
    ],
    sql: `SELECT count(*)::int AS total,
        count(DISTINCT k.company_id)::int AS empresas,
        count(*) FILTER (WHERE k.invoice_status = 'divergent')::int AS divergentes
      FROM fdp_contractor_closings k
      WHERE k.workspace_id = ? AND k.status <> 'closed'
        AND k.invoice_status IN ('pending', 'divergent') {{company}}`,
  },
  {
    key: "integrations.failed",
    question: "Quais integrações falharam?",
    description: "Execuções de integração com falha nos últimos trinta dias, por conector.",
    capability: "integrations.status.read",
    companyColumn: "",
    personal: false,
    triggers: ["integração falhou", "integrações falharam", "erro de integração", "conector", "sincronização falhou"],
    sql: `SELECT count(*)::int AS total,
        count(DISTINCT r.integration_id)::int AS conectores,
        max(r.created_at)::text AS ultima_falha
      FROM fdp_integration_sync_runs r
      WHERE r.workspace_id = ? AND r.status = 'failed'
        AND r.created_at >= now() - interval '30 days'`,
  },
  {
    key: "approvals.mine",
    question: "Quais aprovações estão comigo?",
    description: "Aprovações de movimentação atribuídas a quem perguntou e ainda pendentes.",
    capability: "approvals.read",
    companyColumn: "m.company_id",
    personal: true,
    triggers: ["aprovação comigo", "aprovações comigo", "aprovar", "minhas aprovações", "esperando minha decisão"],
    sql: `SELECT count(*)::int AS total,
        min(s.created_at)::text AS mais_antiga,
        count(DISTINCT m.company_id)::int AS empresas
      FROM fdp_movement_approval_steps s
      JOIN fdp_employee_movements m ON m.workspace_id = s.workspace_id AND m.id = s.movement_id
      WHERE s.workspace_id = ? AND s.status = 'pending' AND s.approver_user_id = ? {{company}}`,
  },
  {
    key: "epi.pending_returns",
    question: "Quais EPIs estão pendentes de devolução?",
    description: "Entregas de EPI ainda não baixadas por devolução, descarte ou dano.",
    capability: "epi.view",
    companyColumn: "d.company_id",
    personal: false,
    triggers: ["epi", "devolução de epi", "epi pendente", "equipamento de proteção", "devolver epi"],
    /* `settled_quantity < quantity` e não "não existe devolução": a baixa de
       uma entrega pode vir de devolução, descarte ou dano, e a coluna de
       liquidação é onde as três chegam. Contar pela ausência de devolução
       marcaria como pendente o EPI que foi descartado com laudo. */
    sql: `SELECT count(*)::int AS total,
        count(DISTINCT d.company_id)::int AS empresas,
        sum(d.quantity - d.settled_quantity)::int AS itens_em_aberto,
        min(d.delivered_on)::text AS entrega_mais_antiga
      FROM fdp_epi_deliveries d
      WHERE d.workspace_id = ? AND d.status <> 'canceled'
        AND d.settled_quantity < d.quantity {{company}}`,
  },
  {
    key: "work.changed_today",
    question: "O que mudou hoje?",
    description: "Eventos de atividade registrados no dia, por tipo, sem identificar pessoas.",
    capability: "cards.read",
    companyColumn: "",
    personal: false,
    triggers: ["o que mudou", "mudou hoje", "novidade", "atividade de hoje", "aconteceu hoje"],
    sql: `SELECT count(*)::int AS total,
        count(DISTINCT a.event_type)::int AS tipos,
        count(DISTINCT a.card_id)::int AS demandas
      FROM fdp_activity_events a
      WHERE a.workspace_id = ? AND a.created_at >= date_trunc('day', now())`,
  },
  {
    key: "triage.pending",
    question: "O que está em triagem?",
    description: "Entradas externas que o sistema não conseguiu classificar e aguardam alguém dizer de quem são.",
    capability: "integrations.status.read",
    companyColumn: "",
    personal: false,
    triggers: ["triagem", "não identificado", "nao identificado", "sem classificação", "entrada pendente"],
    sql: `SELECT count(*)::int AS total,
        count(DISTINCT t.agent_key)::int AS agentes,
        min(t.created_at)::text AS mais_antiga
      FROM fdp_agent_proposals t
      WHERE t.workspace_id = ? AND t.status = 'pending_triage'`,
  },
];

const byKey = new Map(namedQueries.map((query) => [query.key, query]));

export function findNamedQuery(key: unknown): NamedQueryDefinition | null {
  return typeof key === "string" ? byKey.get(key) ?? null : null;
}

function fold(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * Palavras sem valor de busca. Sem elas, "o que está bloqueando o fechamento"
 * casaria com qualquer coisa que contivesse "o" e "que".
 */
const STOP_WORDS = new Set([
  "o", "a", "os", "as", "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas",
  "um", "uma", "que", "qual", "quais", "esta", "estao", "e", "para", "por", "com", "se",
  "me", "meu", "minha", "ainda", "mais", "hoje", "ja", "sobre", "tem", "ha",
]);

/**
 * Reduz a palavra à raiz que interessa.
 *
 * Português conjuga e pluraliza demais para casamento por substring: a mesma
 * pergunta chega como "integrações falharam", "integração falhou" e "integração
 * com falha". Sem esta normalização o produto responderia a uma das três e
 * ficaria mudo nas outras — que é pior do que não ter a funcionalidade, porque
 * o usuário conclui que o assistente não sabe.
 *
 * O corte é curto de propósito: ele erra para o lado de casar demais, e casar
 * demais aqui custa uma consulta agregada a mais, não um vazamento.
 */
export function stemWord(raw: string) {
  let word = fold(raw).replace(/[^a-z0-9]/gu, "");
  if (word.length <= 3) return word;
  if (word.endsWith("oes") || word.endsWith("aes")) word = `${word.slice(0, -3)}ao`;
  else if (word.endsWith("es") && word.length > 4) word = word.slice(0, -2);
  else if (word.endsWith("s") && word.length > 3) word = word.slice(0, -1);
  for (const ending of ["aram", "eram", "iram", "ando", "endo", "indo", "ada", "ado", "ida", "ido", "ou", "am", "ar", "er", "ir"]) {
    if (word.length > ending.length + 3 && word.endsWith(ending)) return word.slice(0, -ending.length);
  }
  return word;
}

function tokenize(value: string) {
  return fold(value)
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map(stemWord)
    .filter(Boolean);
}

/**
 * Escolhe as consultas que respondem à pergunta.
 *
 * Determinístico e por termo declarado, não pelo modelo. Deixar a IA escolher a
 * consulta seria dar a ela a decisão de qual dado sai do ambiente — que é
 * exatamente a autoridade que ela não tem neste produto.
 *
 * Um gatilho casa quando **todos** os seus termos aparecem na pergunta. Exigir
 * todos, e não algum, é o que impede "quais EPIs faltam?" de disparar também a
 * consulta de integrações só porque as duas mencionam pendência.
 */
export function matchNamedQueries(question: unknown, limit = 3): NamedQueryDefinition[] {
  const asked = new Set(tokenize(typeof question === "string" ? question : ""));
  if (asked.size === 0) return [];

  const scored = namedQueries
    .map((query) => {
      let score = 0;
      for (const trigger of query.triggers) {
        const terms = tokenize(trigger);
        if (terms.length && terms.every((term) => asked.has(term))) score = Math.max(score, terms.length);
      }
      return { query, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.query.key.localeCompare(right.query.key));
  return scored.slice(0, Math.max(1, limit)).map((item) => item.query);
}

/**
 * Monta a consulta com workspace, escopo de empresa e recorte pessoal.
 *
 * O `workspaceId` é sempre o primeiro parâmetro e nunca vem do cliente; o
 * escopo de empresa entra como condição com parâmetro, jamais interpolado.
 */
export function buildNamedQuery(input: {
  query: NamedQueryDefinition;
  workspaceId: string;
  userId: string;
  companyIds: readonly string[] | null;
}) {
  const parameters: unknown[] = [input.workspaceId];
  if (input.query.personal) parameters.push(input.userId);

  let sql = input.query.sql;
  if (input.companyIds && input.query.companyColumn) {
    if (input.companyIds.length === 0) {
      sql = sql.replace("{{company}}", "AND false");
    } else {
      sql = sql.replace("{{company}}", `AND ${input.query.companyColumn} IN (${input.companyIds.map(() => "?").join(", ")})`);
      parameters.push(...input.companyIds);
    }
  } else {
    sql = sql.replace("{{company}}", "");
  }
  return { sql, parameters };
}

/**
 * Resultado entregue ao modelo.
 *
 * Só número e data. Uma coluna que não seja número, booleano ou data ISO é
 * descartada com o nome preservado, para que uma consulta futura que traga
 * texto por engano apareça como `omitido` em vez de vazar.
 */
export type NamedQueryResult = {
  key: string;
  question: string;
  description: string;
  values: Record<string, number | string | null>;
  omitted: string[];
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]|$)/u;

export function toNamedQueryResult(query: NamedQueryDefinition, row: Record<string, unknown> | null): NamedQueryResult {
  const values: Record<string, number | string | null> = {};
  const omitted: string[] = [];
  for (const [column, value] of Object.entries(row ?? {})) {
    if (value === null || value === undefined) { values[column] = null; continue; }
    if (typeof value === "number" || typeof value === "boolean") { values[column] = Number(value); continue; }
    const asText = String(value);
    if (ISO_DATE.test(asText)) { values[column] = asText.slice(0, 10); continue; }
    if (/^-?\d+(\.\d+)?$/u.test(asText)) { values[column] = Number(asText); continue; }
    omitted.push(column);
  }
  return { key: query.key, question: query.question, description: query.description, values, omitted };
}

/** Bloco de contexto para o modelo: fatos agregados, em texto curto. */
export function formatNamedQueryContext(results: readonly NamedQueryResult[]) {
  if (!results.length) return "";
  const lines = results.map((result) => {
    const values = Object.entries(result.values)
      .map(([column, value]) => `${column}=${value ?? "sem dado"}`)
      .join(", ");
    return `- ${result.question} → ${values || "sem resultado"}`;
  });
  return [
    "Dados operacionais deste grupo, já apurados pelo servidor e respeitando a permissão de quem perguntou:",
    ...lines,
    "Use apenas estes números. Não estime, não complete e não invente o que não estiver acima.",
  ].join("\n");
}
