import type { Capability } from "./authorization.ts";

/**
 * Registro declarativo do que o painel considera "precisa ser feito agora".
 *
 * Cada indicador aponta para o módulo responsável e declara a capability que o
 * usuário precisa ter. Nada aqui é decorativo: um indicador só existe quando há
 * uma consulta real por trás e uma tela para onde ir.
 *
 * O módulo de Ponto (§28 da especificação) ainda não existe no produto; por isso
 * não há indicador de "ponto aberto" — inventar um número seria pior que a ausência.
 */
export type ActionTarget =
  | "processes"
  | "auxiliary"
  | "psychologistPayments"
  | "contractorPayments"
  | "integrations"
  | "board";

export type ActionTone = "critical" | "warning" | "neutral";

export type ActionDefinition = {
  key: string;
  label: string;
  description: string;
  capability: Capability;
  tone: ActionTone;
  target: ActionTarget;
  /** Indicadores financeiros exibem o total apurado além da contagem. */
  showsAmount?: boolean;
  /** Consulta agregada; `{{company}}` é substituído pelo filtro de empresa da vez. */
  sql: string;
  /** Alias da coluna de empresa usada no filtro de escopo. */
  companyColumn: string;
  /** Indicadores pessoais dependem do usuário da sessão, não só do workspace. */
  personal?: boolean;
};

export const actionDefinitions: readonly ActionDefinition[] = [
  {
    key: "demands_overdue",
    label: "Demandas com prazo estourado",
    description: "SLA vencido no quadro ativo",
    capability: "cards.read",
    tone: "critical",
    target: "board",
    companyColumn: "c.company_id",
    sql: `SELECT count(*)::int AS total, NULL::date AS earliest, 0::numeric AS amount
      FROM fdp_cards c JOIN fdp_boards b ON b.id = c.board_id
      WHERE b.workspace_id = ? AND c.archived = 0 AND c.sla_status = 'overdue' {{company}}`,
  },
  {
    key: "approvals_assigned",
    label: "Aprovações aguardando você",
    description: "Movimentações atribuídas para sua decisão",
    capability: "approvals.decide",
    tone: "critical",
    target: "processes",
    personal: true,
    companyColumn: "m.company_id",
    sql: `SELECT count(*)::int AS total, NULL::date AS earliest, 0::numeric AS amount
      FROM fdp_movement_approval_steps s JOIN fdp_employee_movements m ON m.workspace_id = s.workspace_id AND m.id = s.movement_id
      WHERE s.workspace_id = ? AND s.status = 'pending' AND s.approver_user_id = ? {{company}}`,
  },
  {
    key: "pending_items_blocking",
    label: "Pendências bloqueantes",
    description: "Impedem o fechamento da competência",
    capability: "pending_items.read",
    tone: "critical",
    target: "processes",
    companyColumn: "p.company_id",
    sql: `SELECT count(*)::int AS total, min(p.due_date) AS earliest, 0::numeric AS amount
      FROM fdp_operational_pending_items p
      WHERE p.workspace_id = ? AND p.status IN ('open', 'in_progress') AND p.blocking = 1 {{company}}`,
  },
  {
    key: "pending_items_open",
    label: "Pendências operacionais abertas",
    description: "Central de pendências do DP",
    capability: "pending_items.read",
    tone: "warning",
    target: "processes",
    companyColumn: "p.company_id",
    sql: `SELECT count(*)::int AS total, min(p.due_date) AS earliest, 0::numeric AS amount
      FROM fdp_operational_pending_items p
      WHERE p.workspace_id = ? AND p.status IN ('open', 'in_progress') AND p.blocking = 0 {{company}}`,
  },
  {
    key: "movements_pending",
    label: "Movimentações pendentes",
    description: "Rascunhos e aguardando aprovação",
    capability: "movements.read",
    tone: "warning",
    target: "processes",
    companyColumn: "m.company_id",
    sql: `SELECT count(*)::int AS total, NULL::date AS earliest, 0::numeric AS amount
      FROM fdp_employee_movements m
      WHERE m.workspace_id = ? AND m.status IN ('draft', 'pending_approval') {{company}}`,
  },
  {
    key: "closing_items_pending",
    label: "Itens de fechamento em aberto",
    description: "Conferências de pré e pós-fechamento",
    capability: "competences.read",
    tone: "warning",
    target: "processes",
    companyColumn: "i.company_id",
    sql: `SELECT count(*)::int AS total, min(i.due_date) AS earliest, 0::numeric AS amount
      FROM fdp_payroll_cycle_items i
      WHERE i.workspace_id = ? AND i.status IN ('pending', 'in_progress', 'blocked') {{company}}`,
  },
  {
    key: "obligations_due",
    label: "Obrigações no radar",
    description: "Vencem nos próximos 15 dias ou já venceram",
    capability: "obligations.read",
    tone: "critical",
    target: "processes",
    companyColumn: "o.company_id",
    sql: `SELECT count(*)::int AS total, min(o.due_date) AS earliest, 0::numeric AS amount
      FROM fdp_compliance_obligations o
      WHERE o.workspace_id = ? AND o.status <> 'completed' AND o.due_date <= (CURRENT_DATE + 15) {{company}}`,
  },
  {
    key: "auxiliary_pending",
    label: "Entregas auxiliares pendentes",
    description: "Benefícios e serviços da competência",
    capability: "benefits.read",
    tone: "warning",
    target: "auxiliary",
    companyColumn: "e.company_id",
    sql: `SELECT count(*)::int AS total, min(e.due_date) AS earliest, 0::numeric AS amount
      FROM fdp_auxiliary_executions e
      WHERE e.workspace_id = ? AND e.status IN ('draft', 'pending_approval', 'rejected') {{company}}`,
  },
  {
    key: "psychology_payments_pending",
    label: "Pagamentos de psicólogos pendentes",
    description: "Fechamentos ainda não concluídos",
    capability: "psychology.payments.read",
    tone: "warning",
    target: "psychologistPayments",
    showsAmount: true,
    companyColumn: "k.company_id",
    sql: `SELECT count(*)::int AS total, NULL::date AS earliest, coalesce(sum(k.net_amount), 0)::numeric AS amount
      FROM fdp_psychology_closings k
      WHERE k.workspace_id = ? AND k.status NOT IN ('paid', 'closed') {{company}}`,
  },
  {
    key: "contractor_closings_pending",
    label: "Fechamentos PJ pendentes",
    description: "Competências PJ ainda não concluídas",
    capability: "contractors.payments.read",
    tone: "warning",
    target: "contractorPayments",
    showsAmount: true,
    companyColumn: "k.company_id",
    sql: `SELECT count(*)::int AS total, NULL::date AS earliest, coalesce(sum(k.net_amount), 0)::numeric AS amount
      FROM fdp_contractor_closings k
      WHERE k.workspace_id = ? AND k.status NOT IN ('paid', 'closed') {{company}}`,
  },
  {
    key: "contractor_invoice_divergent",
    label: "Notas PJ divergentes",
    description: "Nota recebida não fecha com o valor esperado",
    capability: "contractors.payments.read",
    tone: "critical",
    target: "contractorPayments",
    showsAmount: true,
    companyColumn: "k.company_id",
    sql: `SELECT count(*)::int AS total, NULL::date AS earliest, coalesce(sum(abs(k.reconciliation_difference)), 0)::numeric AS amount
      FROM fdp_contractor_closings k
      WHERE k.workspace_id = ? AND k.status <> 'closed'
        AND (k.invoice_status = 'divergent' OR k.reconciliation_status = 'divergent') {{company}}`,
  },
  {
    key: "complement_pending",
    label: "Complemento a carregar",
    description: "Valor fora da nota aguardando o cartão de benefício",
    capability: "contractors.payments.read",
    tone: "warning",
    target: "contractorPayments",
    showsAmount: true,
    companyColumn: "k.company_id",
    sql: `SELECT count(*)::int AS total, NULL::date AS earliest, coalesce(sum(k.caju_amount), 0)::numeric AS amount
      FROM fdp_contractor_closings k
      WHERE k.workspace_id = ? AND k.caju_amount > 0 AND k.caju_status IN ('pending', 'approved', 'error') {{company}}`,
  },
  {
    key: "integration_errors",
    label: "Integrações com erro",
    description: "Execuções que falharam nos últimos 30 dias",
    capability: "integrations.status.read",
    tone: "critical",
    target: "integrations",
    companyColumn: "",
    sql: `SELECT count(*)::int AS total, NULL::date AS earliest, 0::numeric AS amount
      FROM fdp_integration_sync_runs r
      WHERE r.workspace_id = ? AND r.status = 'failed' AND r.created_at >= now() - interval '30 days'`,
  },
  {
    key: "integration_reconciliations",
    label: "Conciliações de integração abertas",
    description: "Registros sem correspondência ou em conflito",
    capability: "integrations.reconcile",
    tone: "warning",
    target: "integrations",
    companyColumn: "",
    sql: `SELECT count(*)::int AS total, NULL::date AS earliest, 0::numeric AS amount
      FROM fdp_integration_reconciliations rc
      WHERE rc.workspace_id = ? AND rc.status IN ('unmatched', 'conflict')`,
  },
];

export type ActionItem = {
  key: string;
  label: string;
  description: string;
  tone: ActionTone;
  target: ActionTarget;
  count: number;
  amount: number | null;
  earliestDueDate: string | null;
};
