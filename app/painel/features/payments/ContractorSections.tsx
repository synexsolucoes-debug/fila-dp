"use client";

import { useMemo, useState } from "react";
import {
  Archive, ArrowRight, CalendarClock, CheckCheck, CreditCard, Download, FileDown, FileSpreadsheet, FileText,
  FolderOpen, MessageSquare, Plus, ReceiptText, RotateCcw, ShieldCheck, Users,
} from "lucide-react";
import { CajuExportPanel } from "./CajuExportPanel";
import { ContractorInvoicesSection } from "./ContractorInvoicesSection";
import type {
  ContractorClosing, ContractorOverview, CycleOption, PaymentDialog, PaymentPermissions,
} from "./payments.types";
import type { ContractorSectionId } from "./contractor-sections";
import { EmptyState } from "../shared";
import styles from "./payments.module.css";

/**
 * Os nove recortes do Pagamento PJ.
 *
 * Todos leem o mesmo `ContractorOverview` que o módulo já carrega — a divisão
 * é de leitura, não de requisição: quebrar em oito chamadas ao servidor faria
 * trocar de destino custar uma ida ao banco por assunto, quando a competência
 * inteira já veio numa resposta só.
 *
 * O que muda de destino para destino é o recorte e as ações. A tabela de
 * fechamentos, por exemplo, só aparece em "Pagamentos"; "Encerramentos" mostra
 * as mesmas linhas filtradas pelo que já foi pago, sem os botões que avançam
 * status, porque avançar o que está fechado não é uma ação que exista.
 */

export type SectionProps = {
  section: ContractorSectionId;
  overview: ContractorOverview;
  cycle: CycleOption;
  /** A empresa em tela. A aba de Notas Fiscais carrega os próprios dados por
   *  ela — é a única que precisa perguntar ao servidor por conta própria. */
  companyId: string;
  competence: string;
  competenceLabel: (value: string) => string;
  money: (value: number) => string;
  statusLabels: Record<string, string>;
  limitSourceLabels: Record<string, string>;
  complementLabels: Record<string, string>;
  componentLabels: Record<string, string>;
  permissions: PaymentPermissions | undefined;
  busy: boolean;
  detailLoadingId: string;
  reportUrl: (report: string, format?: "csv" | "pdf") => string;
  onDialog: (dialog: NonNullable<PaymentDialog>) => void;
  onOpenDetail: (closingId: string) => void;
  onRecalculate: (providerId?: string) => void;
  onTransition: (closingId: string, status: string) => void;
  onCompetence: (competence: string) => void;
  onIssueStatements: () => void;
  onApproveClosings: (closingIds: string[]) => void;
  onOpenDocuments: (providerId: string) => void;
  /** Abre a janela de lançamento com a natureza já escolhida (§55). */
  onNewEntry: (nature: "mensal" | "fixo" | "determinado") => void;
  /** Abre a escolha de empresa antes de gerar o arquivo de avisos de NF. */
  onInvoiceNotice: () => void;
};

export function ContractorSectionView(props: SectionProps) {
  switch (props.section) {
    case "contractorProviders": return <ProvidersSection {...props} />;
    case "contractorCycles": return <CyclesSection {...props} />;
    case "contractorClosings": return <ClosingsSection {...props} />;
    case "contractorInvoices": return (
      <ContractorInvoicesSection
        companyId={props.companyId}
        competence={props.competence}
        competenceLabel={props.competenceLabel}
        money={props.money}
        reportUrl={props.reportUrl}
      />
    );
    case "contractorAdjustments": return <AdjustmentsSection {...props} />;
    case "contractorLimits": return <LimitsSection {...props} />;
    case "contractorCaju": return <CajuSection {...props} />;
    case "contractorArchive": return <ArchiveSection {...props} />;
    default: return <OverviewSection {...props} />;
  }
}

/* -------------------------------------------------------------------------- */
/* Visão geral                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * O que a competência deve e o que ainda a trava.
 *
 * Os números já existiam no topo da tela antiga. O que não existia era a
 * segunda metade: quantos fechamentos estão em cada etapa. Sem ela o total
 * responde "quanto", nunca "o que falta" — e "o que falta" é a pergunta que
 * traz alguém ao módulo no dia 3 do mês.
 */
function OverviewSection({ overview, money, statusLabels, competence, competenceLabel }: SectionProps) {
  const { totals, closings, invoiceSummary } = overview;
  const byStatus = new Map<string, number>();
  for (const row of closings) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
  const pending = closings.filter((row) => row.status !== "paid" && row.status !== "closed").length;

  return (
    <>
      <div className={styles.summaryGrid}>
        <article><span>Líquido devido</span><strong>{money(totals.netAmount)}</strong></article>
        <article><span>Notas esperadas</span><strong>{money(totals.invoiceExpectedAmount)}</strong></article>
        <article><span>Complemento</span><strong>{money(totals.complementAmount)}</strong></article>
        <article><span>Caju Saldo Livre</span><strong>{money(totals.cajuAmount)}</strong></article>
        <article data-alert={totals.divergentCount > 0 ? "true" : "false"}>
          <span>Divergências</span><strong>{totals.divergentCount}</strong>
        </article>
      </div>

      {/* A situação das notas da competência, sem abrir pagamento por pagamento
          (§17). O detalhe fica na aba de Notas Fiscais; aqui é só o retrato. */}
      {invoiceSummary.requiredCount > 0 && (
        <section className={styles.fixedItemsPanel} aria-labelledby="pj-invoices-title">
          <header>
            <div>
              <span className={styles.eyebrow}>NOTAS FISCAIS</span>
              <h3 id="pj-invoices-title">
                {invoiceSummary.approvedCount} de {invoiceSummary.requiredCount} notas aprovadas
              </h3>
              <p>
                {invoiceSummary.receivedCount} recebida(s) · {invoiceSummary.awaitingReviewCount} aguardando conferência ·
                {" "}{invoiceSummary.rejectedCount + invoiceSummary.correctionCount} rejeitada(s) ·
                {" "}{invoiceSummary.pendingCount} pendente(s) em {competenceLabel(competence)}.
              </p>
            </div>
          </header>
          <p className={styles.fixedItemsEmpty}>
            {invoiceSummary.readyCount} prestador(es) apto(s) para pagamento; {money(invoiceSummary.approvedAmount)} de
            {" "}{money(invoiceSummary.expectedAmount)} cobertos por nota aprovada.
          </p>
        </section>
      )}

      <section className={styles.fixedItemsPanel} aria-labelledby="pj-progress-title">
        <header>
          <div>
            <span className={styles.eyebrow}>ANDAMENTO</span>
            <h3 id="pj-progress-title">Onde está cada prestador</h3>
            <p>
              {closings.length === 0
                ? `Nenhum fechamento apurado em ${competenceLabel(competence)}.`
                : `${pending} de ${closings.length} fechamento(s) ainda não concluído(s) em ${competenceLabel(competence)}.`}
            </p>
          </div>
        </header>
        {closings.length === 0 ? (
          <p className={styles.fixedItemsEmpty}>
            Lance os créditos e descontos em <b>Ajustes</b> e apure a competência para ver o andamento aqui.
          </p>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <caption className={styles.tableCaption}>Fechamentos por etapa em {competenceLabel(competence)}</caption>
              <thead><tr><th scope="col">Etapa</th><th scope="col">Fechamentos</th><th scope="col">Líquido</th></tr></thead>
              <tbody>
                {[...byStatus.entries()].map(([status, count]) => {
                  const amount = closings.filter((row) => row.status === status)
                    .reduce((total, row) => total + row.netAmount, 0);
                  return (
                    <tr key={status}>
                      <th scope="row"><span className={styles.badge} data-tone={status}>{statusLabels[status] ?? status}</span></th>
                      <td>{count}</td>
                      <td><strong>{money(amount)}</strong></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Prestadores                                                                 */
/* -------------------------------------------------------------------------- */

function ProvidersSection({ overview, money, statusLabels, complementLabels, permissions, onDialog, onOpenDocuments }: SectionProps) {
  const { contractors } = overview;
  if (contractors.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="Nenhum prestador PJ cadastrado nesta empresa"
        text="O prestador precisa existir antes de qualquer apuração: é dele que vêm o valor de contrato, o limite da nota e a forma de complemento."
        action={permissions?.manage ? (
          <button className={styles.primaryButton} type="button" onClick={() => onDialog({ kind: "contractor" })}>
            <Plus aria-hidden="true" /> Cadastrar prestador
          </button>
        ) : undefined}
      />
    );
  }
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <caption className={styles.tableCaption}>Prestadores PJ da empresa selecionada</caption>
        <thead>
          <tr>
            <th scope="col">Prestador</th><th scope="col">Código</th><th scope="col">Valor de contrato</th>
            <th scope="col">Limite próprio</th><th scope="col">Complemento</th><th scope="col">Situação</th><th scope="col">Arquivos</th>
          </tr>
        </thead>
        <tbody>
          {contractors.map((item) => (
            <tr key={item.id}>
              <th scope="row">{item.legalName}<small>{item.contractReference || "Sem referência de contrato"}</small></th>
              <td>{item.code}</td>
              <td><strong>{money(item.baseAmount)}</strong></td>
              <td>{item.invoiceLimitOverride === null ? "Segue a política" : money(item.invoiceLimitOverride)}</td>
              <td>{complementLabels[item.complementMethod] ?? item.complementMethod}</td>
              <td><span className={styles.badge} data-tone={item.status === "active" ? "validated" : "pending"}>
                {statusLabels[item.status] ?? (item.status === "active" ? "Ativo" : "Inativo")}
              </span></td>
              <td className={styles.rowActions}><button type="button" onClick={() => onOpenDocuments(item.id)}><FolderOpen aria-hidden="true" /> Documentos</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Competências                                                                */
/* -------------------------------------------------------------------------- */

/**
 * As competências existiam só como opções de um `<select>` no topo. Aqui elas
 * viram tela: qual está aberta, qual foi fechada e quando, e qual a data de
 * pagamento — que é o que alguém precisa ver para responder "essa competência
 * já rodou?" sem abrir uma por uma.
 */
function CyclesSection({ overview, cycle, competenceLabel, statusLabels, onCompetence }: SectionProps) {
  const { cycles } = overview;
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <caption className={styles.tableCaption}>Competências PJ da empresa selecionada</caption>
        <thead>
          <tr>
            <th scope="col">Competência</th><th scope="col">Situação</th>
            <th scope="col">Data de pagamento</th><th scope="col">Fechada em</th><th scope="col">Ações</th>
          </tr>
        </thead>
        <tbody>
          {cycles.map((item) => (
            <tr key={item.id} aria-current={item.id === cycle.id ? "true" : undefined}>
              <th scope="row">{competenceLabel(item.competence)}<small>{item.competence}</small></th>
              <td><span className={styles.badge} data-tone={item.status}>{statusLabels[item.status] ?? item.status}</span></td>
              <td>{item.paymentDate || "—"}</td>
              <td>{item.closedAt ? item.closedAt.slice(0, 10) : "—"}</td>
              <td className={styles.rowActions}>
                {item.id === cycle.id
                  ? <span className={styles.badge} data-tone="validated">Em tela</span>
                  : <button type="button" onClick={() => onCompetence(item.competence)}>Abrir</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pagamentos                                                                  */
/* -------------------------------------------------------------------------- */

function ClosingsSection(props: SectionProps) {
  const { overview, competence, competenceLabel, permissions, onDialog } = props;
  const rows = overview.closings;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ReceiptText}
        title={`Nenhum fechamento apurado em ${competenceLabel(competence)}`}
        text="Lance os créditos e descontos e use “Apurar competência” para calcular quanto cada prestador tem a receber."
        action={permissions?.manage ? (
          <button className={styles.primaryButton} type="button"
            onClick={() => onDialog({ kind: "component", contractors: overview.contractors })}>
            <Plus aria-hidden="true" /> Lançar crédito ou desconto
          </button>
        ) : undefined}
      />
    );
  }
  return (
    <>
      <ContractorApprovalPanel {...props} rows={rows} />
      <ClosingsTable {...props} rows={rows}
        caption={`Fechamento PJ de ${competenceLabel(competence)}`} showActions />
      {/* Conferir é perguntar de onde o número veio, e o número da tabela já
          vem somado. O extrato analítico abre a soma: uma linha por rubrica,
          de todos os prestadores da competência.
          Fica aqui porque é aqui que a conferência acontece — o mesmo arquivo
          existia por prestador, dentro do detalhamento, e conferir trinta
          prestadores custava trinta diálogos e trinta arquivos. */}
      <footer className={styles.reportBar}>
        {/* O PDF vem primeiro porque é o que se entrega: sai no formato da
            folha analítica que o escritório já sabe conferir. O CSV continua,
            para quem vai cruzar os números em planilha. */}
        <a className={styles.primaryButton} href={props.reportUrl("contractor-analytical", "pdf")}>
          <FileText aria-hidden="true" /> Emitir extrato analítico (PDF)
        </a>
        <a className={styles.secondaryButton} href={props.reportUrl("contractor-analytical")}>
          <FileSpreadsheet aria-hidden="true" /> Extrato analítico (CSV)
        </a>
        {/* As mensagens de aviso. Não é um link direto como os outros: a
            empresa é escolhida na hora, porque é ela que define de quem são as
            mensagens do arquivo. */}
        <button type="button" className={styles.secondaryButton} onClick={props.onInvoiceNotice}>
          <MessageSquare aria-hidden="true" /> Gerar avisos de NF (TXT)
        </button>
      </footer>
    </>
  );
}

function ContractorApprovalPanel({ rows, permissions, busy, competence, competenceLabel, onIssueStatements, onApproveClosings }: SectionProps & { rows: ContractorClosing[] }) {
  const pending = useMemo(() => rows.filter((row) => row.status === "review" || row.status === "approval"), [rows]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedPending = useMemo(() => {
    const available = new Set(pending.map((row) => row.id));
    return new Set([...selected].filter((id) => available.has(id)));
  }, [pending, selected]);
  const allSelected = pending.length > 0 && pending.every((row) => selectedPending.has(row.id));

  return (
    <section className={styles.approvalPanel} aria-labelledby="contractor-approval-title">
      <header>
        <div>
          <span className={styles.eyebrow}>CONFERÊNCIA E APROVAÇÃO</span>
          <h3 id="contractor-approval-title">Recibos e aprovação da competência</h3>
          <p>Emita os recibos de pagamento para colocar os valores abertos em conferência. Depois aprove todos ou somente os selecionados.</p>
        </div>
        {permissions?.manage ? (
          <button className={styles.secondaryButton} type="button" onClick={onIssueStatements} disabled={busy}>
            <FileDown aria-hidden="true" /> Emitir recibos de pagamento
          </button>
        ) : null}
      </header>

      {pending.length === 0 ? (
        <p className={styles.approvalEmpty}>Nenhum prestador aguardando aprovação em {competenceLabel(competence)}.</p>
      ) : (
        <>
          <div className={styles.approvalToolbar}>
            <label>
              <input type="checkbox" checked={allSelected} onChange={(event) => setSelected(event.target.checked ? new Set(pending.map((row) => row.id)) : new Set())} />
              Selecionar todos ({pending.length})
            </label>
            <span>{selectedPending.size} selecionado(s)</span>
            {permissions?.manage ? (
              <>
                <button type="button" className={styles.secondaryButton} disabled={busy || selectedPending.size === 0}
                  onClick={() => onApproveClosings([...selectedPending])}>
                  <CheckCheck aria-hidden="true" /> Aprovar selecionados
                </button>
                <button type="button" className={styles.primaryButton} disabled={busy}
                  onClick={() => onApproveClosings(pending.map((row) => row.id))}>
                  <CheckCheck aria-hidden="true" /> Aprovar todos
                </button>
              </>
            ) : null}
          </div>
          <div className={styles.approvalRows}>
            {pending.map((row) => (
              <label key={row.id}>
                <input type="checkbox" checked={selectedPending.has(row.id)} onChange={(event) => setSelected((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(row.id); else next.delete(row.id);
                  return next;
                })} />
                <span><strong>{row.contractorName}</strong><small>{row.contractReference || row.contractorCode}</small></span>
                <b>{row.status === "review" ? "Em conferência" : "Em aprovação"}</b>
              </label>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Ajustes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Ajustes: os lançamentos da competência, nas três naturezas.
 *
 * A tela mostrava só os recorrentes, e quem lançava um desconto avulso não
 * tinha onde conferir o que lançou — o valor entrava na apuração e sumia de
 * vista. Agora as duas listas convivem: o que vale só neste mês e o que se
 * repete, com a vigência dizendo até quando.
 */
function AdjustmentsSection(props: SectionProps) {
  const { overview, competence, competenceLabel, money, componentLabels, permissions, busy, onNewEntry } = props;
  const { fixedItems, monthlyEntries } = overview;
  const mensais = monthlyEntries.filter((item) => item.status !== "canceled");
  return (
    <>
    <section className={styles.fixedItemsPanel} aria-labelledby="monthly-entries-title">
      <header>
        <div>
          <span className={styles.eyebrow}>LANÇAMENTOS DA COMPETÊNCIA</span>
          <h3 id="monthly-entries-title">Mensais de {competenceLabel(competence)}</h3>
          <p>Valem só nesta competência. Os que vêm de um lançamento fixo aparecem na lista de baixo, não aqui.</p>
        </div>
        {permissions?.manage ? (
          <button className={styles.primaryButton} type="button" disabled={busy}
            onClick={() => onNewEntry("mensal")}>
            <Plus aria-hidden="true" /> Novo lançamento
          </button>
        ) : null}
      </header>
      {mensais.length === 0 ? (
        <p className={styles.fixedItemsEmpty}>
          Nenhum lançamento avulso nesta competência. Use <b>Novo lançamento</b> para registrar um crédito ou
          desconto — de um prestador só ou de vários de uma vez.
        </p>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <caption className={styles.tableCaption}>Créditos e descontos lançados em {competenceLabel(competence)}</caption>
            <thead>
              <tr>
                <th scope="col">Prestador</th><th scope="col">Rubrica</th>
                <th scope="col">Tipo</th><th scope="col">Valor</th><th scope="col">Documento</th>
              </tr>
            </thead>
            <tbody>
              {mensais.map((item) => (
                <tr key={item.id}>
                  <th scope="row">{item.contractorName}</th>
                  <td>{item.description || componentLabels[item.componentType] || item.componentType}
                    <small>{componentLabels[item.componentType] || item.componentType}</small></td>
                  <td>{item.direction === "credit" ? "Provento" : "Desconto"}</td>
                  <td className={item.direction === "debit" ? styles.negative : undefined}>{money(item.amount)}</td>
                  <td>{item.documentReference || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>

    <section className={styles.fixedItemsPanel} aria-labelledby="fixed-items-title">
      <header>
        <div>
          <span className={styles.eyebrow}>LANÇAMENTOS RECORRENTES</span>
          <h3 id="fixed-items-title">Fixos e determinados</h3>
          <p>Entram automaticamente em cada competência dentro da vigência. Sem competência final, o lançamento é fixo; com ela, determinado.</p>
        </div>
        {permissions?.manage ? (
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={() => onNewEntry("fixo")}
            disabled={busy}
          >
            <CalendarClock aria-hidden="true" /> Novo recorrente
          </button>
        ) : null}
      </header>
      {fixedItems.length === 0 ? (
        <p className={styles.fixedItemsEmpty}>
          Nenhum lançamento fixo cadastrado para esta empresa. Créditos e descontos de uma competência só
          continuam em <b>Pagamentos</b>, pelo botão “Crédito/desconto”.
        </p>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <caption className={styles.tableCaption}>Valores recorrentes que alimentam as apurações PJ</caption>
            <thead>
              <tr>
                <th scope="col">Prestador</th><th scope="col">Rubrica</th><th scope="col">Tipo</th>
                <th scope="col">Valor mensal</th><th scope="col">Vigência</th><th scope="col">Nesta competência</th>
              </tr>
            </thead>
            <tbody>
              {fixedItems.map((item) => {
                const appliesNow = item.status === "active" && item.effectiveFrom <= competence
                  && (!item.effectiveTo || competence <= item.effectiveTo);
                return (
                  <tr key={item.id}>
                    <th scope="row">{item.contractorName}</th>
                    <td>{item.description || componentLabels[item.componentType] || item.componentType}<small>{componentLabels[item.componentType] || item.componentType}</small></td>
                    <td>{item.direction === "credit" ? "Provento" : "Desconto"}</td>
                    <td className={item.direction === "debit" ? styles.negative : undefined}>{money(item.amount)}</td>
                    <td>{item.effectiveFrom} → {item.effectiveTo || "sem término"}<small>{item.effectiveTo ? "Determinado" : "Fixo"}</small></td>
                    <td><span className={styles.badge} data-tone={appliesNow ? "validated" : "pending"}>{appliesNow ? "Aplicado" : "Fora da vigência"}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Limites de nota                                                             */
/* -------------------------------------------------------------------------- */

/**
 * As políticas de limite existiam no servidor e no diálogo que as cria — e em
 * nenhuma tela. Para saber qual limite valia para um prestador era preciso ler
 * a coluna "Limite NF" da apuração, uma linha por vez, e deduzir a origem pela
 * legenda. Aqui elas são a tela.
 */
function LimitsSection({ overview, money, limitSourceLabels, permissions, onDialog }: SectionProps) {
  const { invoiceLimitPolicies, contractors } = overview;
  if (invoiceLimitPolicies.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="Nenhuma política de limite configurada"
        text="Sem política, a nota esperada é o líquido inteiro. Uma política define até quanto o prestador emite nota — o que passar disso vira complemento."
        action={permissions?.manageLimits ? (
          <button className={styles.primaryButton} type="button" onClick={() => onDialog({ kind: "limit", contractors })}>
            <ShieldCheck aria-hidden="true" /> Definir limite da nota
          </button>
        ) : undefined}
      />
    );
  }
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <caption className={styles.tableCaption}>Políticas de limite de nota fiscal</caption>
        <thead>
          <tr>
            <th scope="col">Abrangência</th><th scope="col">Alvo</th>
            <th scope="col">Limite</th><th scope="col">Vigente desde</th>
          </tr>
        </thead>
        <tbody>
          {invoiceLimitPolicies.map((policy) => {
            const provider = contractors.find((item) => item.id === policy.providerId);
            return (
              <tr key={policy.id}>
                <th scope="row">{limitSourceLabels[policy.scope] ?? policy.scope}</th>
                <td>{provider?.legalName || policy.contractReference || "Toda a abrangência"}</td>
                <td><strong>{money(policy.amount)}</strong></td>
                <td>{policy.effectiveFrom || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Complemento Caju                                                            */
/* -------------------------------------------------------------------------- */

function CajuSection(props: SectionProps) {
  const { overview, cycle, permissions, money, competenceLabel, competence } = props;
  const rows = overview.closings.filter((row) => row.cajuAmount > 0);
  return (
    <>
      <div className={styles.summaryGrid}>
        <article><span>Total no cartão</span><strong>{money(overview.totals.cajuAmount)}</strong></article>
        <article><span>Prestadores com complemento</span><strong>{rows.length}</strong></article>
        <article data-alert={rows.some((row) => row.cajuStatus === "error") ? "true" : "false"}>
          <span>Envios com erro</span><strong>{rows.filter((row) => row.cajuStatus === "error").length}</strong>
        </article>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title={`Nenhum complemento em ${competenceLabel(competence)}`}
          text="O complemento aparece quando o líquido passa do limite da nota: a diferença vai para o cartão de benefício em vez da nota fiscal."
        />
      ) : (
        <>
          <CajuExportPanel competenceId={cycle.id} canExport={permissions?.exportCaju === true} />
          <ClosingsTable {...props} rows={rows} caption={`Complemento Caju de ${competenceLabel(competence)}`} />
        </>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Encerramentos                                                               */
/* -------------------------------------------------------------------------- */

function ArchiveSection(props: SectionProps) {
  const { overview, competence, competenceLabel, reportUrl, permissions, busy, onDialog, onOpenDocuments } = props;
  const rows = overview.closings.filter((row) => row.status === "paid" || row.status === "closed");
  return (
    <>
      {rows.length === 0 ? (
        <EmptyState
          icon={Archive}
          title={`Nada encerrado em ${competenceLabel(competence)}`}
          text="Um fechamento chega aqui quando é pago e fechado. Até lá ele fica em Pagamentos, com as ações que o fazem avançar."
        />
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <caption className={styles.tableCaption}>Encerrados em {competenceLabel(competence)}</caption>
            <thead>
              <tr>
                <th scope="col">Prestador</th><th scope="col">Líquido</th><th scope="col">Nota</th>
                <th scope="col">Complemento</th><th scope="col">Situação</th><th scope="col">Fechado em</th>
                <th scope="col">Ações</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">{row.contractorName}<small>{row.contractReference || row.contractorCode}</small></th>
                  <td><strong>{props.money(row.netAmount)}</strong></td>
                  <td>{row.invoiceNumber || "—"}</td>
                  <td>{props.money(row.complementAmount)}</td>
                  <td><span className={styles.badge} data-tone={row.status}>{props.statusLabels[row.status] ?? row.status}</span></td>
                  <td>{row.closedAt ? row.closedAt.slice(0, 10) : "—"}</td>
                  <td className={styles.rowActions}>
                    <button type="button" onClick={() => onOpenDocuments(row.providerId)}><FolderOpen aria-hidden="true" /> Documentos</button>
                    {permissions?.reopen && (
                      <button type="button" disabled={busy}
                        onClick={() => onDialog({ kind: "reopen", closingId: row.id, module: "contractors" })}>
                        <RotateCcw aria-hidden="true" /> Reabrir
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <footer className={styles.reportBar}>
        <a className={styles.secondaryButton} href={reportUrl("contractor-closing")}><Download aria-hidden="true" /> Fechamento (CSV)</a>
        <a className={styles.secondaryButton} href={reportUrl("contractor-analytical", "pdf")}><FileText aria-hidden="true" /> Extrato analítico (PDF)</a>
        <a className={styles.secondaryButton} href={reportUrl("contractor-analytical")}><FileSpreadsheet aria-hidden="true" /> Extrato analítico (CSV)</a>
        <a className={styles.secondaryButton} href={reportUrl("contractor-divergences")}><FileText aria-hidden="true" /> Divergências (CSV)</a>
      </footer>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* A tabela de apuração, compartilhada                                         */
/* -------------------------------------------------------------------------- */

/**
 * A apuração PJ mantém na tabela apenas os valores usados na conferência:
 * base, créditos, descontos, líquido, limite, nota esperada e complemento.
 * As situações detalhadas da nota e do pagamento ficam no extrato do
 * prestador, aberto pelo nome, e deixam de duplicar as ações da última coluna.
 *
 * O status do fechamento continua governando os botões da linha: ele decide o
 * que se pode fazer com aquele prestador, só não ocupa mais uma coluna para
 * dizer o que os próprios botões já dizem.
 */
function ClosingsTable({
  rows, caption, showActions, money, statusLabels, limitSourceLabels, complementLabels,
  permissions, busy, detailLoadingId, onDialog, onOpenDetail, onRecalculate, onTransition, onOpenDocuments,
}: SectionProps & { rows: ContractorClosing[]; caption: string; showActions?: boolean }) {
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <caption className={styles.tableCaption}>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Prestador</th><th scope="col">Base</th><th scope="col">Créditos</th>
            <th scope="col">Descontos</th><th scope="col">Líquido</th><th scope="col">Limite NF</th>
            <th scope="col">NF esperada</th><th scope="col">Complemento</th>
            {showActions && <th scope="col">Ações</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} id={`contractor-closing-${row.id}`}>
              <th scope="row">
                <button
                  className={styles.contractorDetailButton}
                  type="button"
                  onClick={() => onOpenDetail(row.id)}
                  disabled={detailLoadingId === row.id}
                  aria-label={`Ver proventos, descontos e resultado de ${row.contractorName}`}
                >
                  {detailLoadingId === row.id ? "Carregando…" : row.contractorName}
                </button>
                <small>{row.contractReference || row.contractorCode}</small>
              </th>
              <td>{money(row.baseAmount)}</td>
              <td>{money(row.creditsAmount)}</td>
              <td className={styles.negative}>{money(row.debitsAmount)}</td>
              <td><strong>{money(row.netAmount)}</strong></td>
              <td>
                {row.invoiceLimitAmount === null ? "—" : money(row.invoiceLimitAmount)}
                <small>{limitSourceLabels[row.invoiceLimitSource] ?? row.invoiceLimitSource}</small>
              </td>
              <td><strong>{money(row.invoiceExpectedAmount)}</strong>{row.invoiceNumber && <small>NF {row.invoiceNumber}</small>}</td>
              <td>
                <strong>{money(row.complementAmount)}</strong>
                <small>{complementLabels[row.complementMethod] ?? row.complementMethod}</small>
              </td>
              {showActions && (
                <td className={styles.rowActions}>
                  <button type="button" onClick={() => onOpenDocuments(row.providerId)} disabled={busy}><FolderOpen aria-hidden="true" /> Arquivos</button>
                  {permissions?.manage && row.status !== "closed" && row.status !== "paid" && (
                    <>
                      <button type="button" onClick={() => onDialog({ kind: "invoice", closing: row })} disabled={busy}>Nota</button>
                      {row.complementAmount > 0 && (
                        <button type="button" onClick={() => onDialog({ kind: "complement", closing: row })} disabled={busy}>Complemento</button>
                      )}
                      <button type="button" onClick={() => onRecalculate(row.providerId)} disabled={busy}>Reapurar</button>
                      <button type="button" onClick={() => onTransition(row.id, nextContractorStatus(row.status))} disabled={busy}>
                        {statusLabels[nextContractorStatus(row.status)] ?? "Avançar"} <ArrowRight aria-hidden="true" />
                      </button>
                    </>
                  )}
                  {permissions?.close && row.status === "paid" && (
                    <button type="button" onClick={() => onTransition(row.id, "closed")} disabled={busy}>Fechar</button>
                  )}
                  {permissions?.reopen && (row.status === "closed" || row.status === "paid") && (
                    <button type="button" onClick={() => onDialog({ kind: "reopen", closingId: row.id, module: "contractors" })} disabled={busy}>
                      <RotateCcw aria-hidden="true" /> Reabrir
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function nextContractorStatus(status: string) {
  const flow: Record<string, string> = {
    open: "review", review: "approval", approval: "approved", approved: "invoice_pending",
    invoice_pending: "ready_to_pay", ready_to_pay: "paid", reopened: "review",
  };
  return flow[status] ?? "review";
}

/**
 * As ações que o cabeçalho oferece dependem do destino (§55).
 *
 * A barra de comando mostrava as cinco ações do módulo em toda tela: cadastrar
 * prestador, limite da nota, crédito/desconto, apurar, atualizar. Numa tela de
 * limites, "Lançar consulta" não é ruído inocente — é uma ação que não tem o
 * que fazer ali, competindo com a que tem.
 */
export function contractorActionsFor(section: ContractorSectionId): {
  provider: boolean; limit: boolean; component: boolean; recalculate: boolean;
} {
  switch (section) {
    case "contractorProviders": return { provider: true, limit: false, component: false, recalculate: false };
    case "contractorLimits": return { provider: false, limit: true, component: false, recalculate: false };
    case "contractorAdjustments": return { provider: false, limit: false, component: true, recalculate: true };
    // A aba de notas tem as próprias ações, na linha do prestador: reapurar a
    // competência inteira a partir dela seria uma ação de outro assunto.
    case "contractorInvoices": return { provider: false, limit: false, component: false, recalculate: false };
    case "contractorClosings": return { provider: false, limit: false, component: true, recalculate: true };
    case "contractorCycles": return { provider: false, limit: false, component: false, recalculate: false };
    case "contractorCaju": return { provider: false, limit: false, component: false, recalculate: true };
    case "contractorArchive": return { provider: false, limit: false, component: false, recalculate: false };
    default: return { provider: false, limit: false, component: false, recalculate: true };
  }
}
