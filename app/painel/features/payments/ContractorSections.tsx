"use client";

import {
  Archive, ArrowRight, CalendarClock, CreditCard, Download, FileSpreadsheet, FileText, Plus, ReceiptText,
  RotateCcw, ShieldCheck, Users,
} from "lucide-react";
import { CajuExportPanel } from "./CajuExportPanel";
import type {
  ContractorClosing, ContractorOverview, CycleOption, PaymentDialog, PaymentPermissions,
} from "./payments.types";
import type { ContractorSectionId } from "./contractor-sections";
import { EmptyState } from "../shared";
import styles from "./payments.module.css";

/**
 * Os oito recortes do Pagamento PJ.
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
};

export function ContractorSectionView(props: SectionProps) {
  switch (props.section) {
    case "contractorProviders": return <ProvidersSection {...props} />;
    case "contractorCycles": return <CyclesSection {...props} />;
    case "contractorClosings": return <ClosingsSection {...props} />;
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
  const { totals, closings } = overview;
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

function ProvidersSection({ overview, money, statusLabels, complementLabels, permissions, onDialog }: SectionProps) {
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
            <th scope="col">Limite próprio</th><th scope="col">Complemento</th><th scope="col">Situação</th>
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
      </footer>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Ajustes                                                                     */
/* -------------------------------------------------------------------------- */

function AdjustmentsSection({ overview, competence, money, componentLabels, permissions, busy, onDialog }: SectionProps) {
  const { fixedItems, contractors } = overview;
  return (
    <section className={styles.fixedItemsPanel} aria-labelledby="fixed-items-title">
      <header>
        <div>
          <span className={styles.eyebrow}>LANÇAMENTOS RECORRENTES</span>
          <h3 id="fixed-items-title">Lançamentos fixos</h3>
          <p>Plano de saúde, convênios, adicionais e outros valores que se repetem automaticamente por competência.</p>
        </div>
        {permissions?.manage ? (
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={() => onDialog({ kind: "fixed-item", contractors, competence })}
            disabled={busy}
          >
            <CalendarClock aria-hidden="true" /> Novo lançamento fixo
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
                    <td>{item.effectiveFrom} → {item.effectiveTo || "sem término"}<small>{item.effectiveTo ? "Prazo determinado" : "Sem prazo"}</small></td>
                    <td><span className={styles.badge} data-tone={appliesNow ? "validated" : "pending"}>{appliesNow ? "Aplicado" : "Fora da vigência"}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
  const { overview, competence, competenceLabel, reportUrl, permissions, busy, onDialog } = props;
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
 * Treze colunas é muito para uma tabela — e é o que a apuração PJ tem de
 * verdade: base, créditos, descontos, líquido, limite, nota esperada,
 * complemento e três situações. Reduzir esconderia o que a conferência
 * precisa. O que se pode fazer é não repetir a definição dela em três
 * destinos, e é o que este componente resolve.
 */
function ClosingsTable({
  rows, caption, showActions, money, statusLabels, limitSourceLabels, complementLabels,
  permissions, busy, detailLoadingId, onDialog, onOpenDetail, onRecalculate, onTransition,
}: SectionProps & { rows: ContractorClosing[]; caption: string; showActions?: boolean }) {
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <caption className={styles.tableCaption}>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Prestador</th><th scope="col">Base</th><th scope="col">Créditos</th>
            <th scope="col">Descontos</th><th scope="col">Líquido</th><th scope="col">Limite NF</th>
            <th scope="col">NF esperada</th><th scope="col">Complemento</th><th scope="col">Status NF</th>
            <th scope="col">Status complemento</th><th scope="col">Conciliação</th><th scope="col">Fechamento</th>
            {showActions && <th scope="col">Ações</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
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
              <td><span className={styles.badge} data-tone={row.invoiceStatus}>{statusLabels[row.invoiceStatus] ?? row.invoiceStatus}</span></td>
              <td><span className={styles.badge} data-tone={row.cajuStatus}>{statusLabels[row.cajuStatus] ?? row.cajuStatus}</span></td>
              <td>
                <span className={styles.badge} data-tone={row.reconciliationStatus}>{statusLabels[row.reconciliationStatus] ?? row.reconciliationStatus}</span>
                {row.reconciliationDifference !== 0 && <small>{money(row.reconciliationDifference)}</small>}
              </td>
              <td><span className={styles.badge} data-tone={row.status}>{statusLabels[row.status] ?? row.status}</span></td>
              {showActions && (
                <td className={styles.rowActions}>
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
    case "contractorClosings": return { provider: false, limit: false, component: true, recalculate: true };
    case "contractorCycles": return { provider: false, limit: false, component: false, recalculate: false };
    case "contractorCaju": return { provider: false, limit: false, component: false, recalculate: true };
    case "contractorArchive": return { provider: false, limit: false, component: false, recalculate: false };
    default: return { provider: false, limit: false, component: false, recalculate: true };
  }
}
