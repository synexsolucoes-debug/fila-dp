"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, ArrowLeftRight, Boxes, Download, HardHat, PackageCheck, Paperclip, RefreshCw,
  Scale, Trash2, Undo2,
} from "lucide-react";
import {
  epiDamageDecisionLabels, epiDamageReasonLabels, epiDeliveryStatusLabels, epiDisposalReasonLabels,
  epiDisposalStatusLabels, epiDiscountDecisionLabels, epiDiscountStatusLabels, epiDiscountTriggerLabels,
  epiMovementTypeLabels, epiReturnConditionLabels,
} from "@/lib/epi";
import { epiComplianceStatusLabels, type EpiComplianceStatus } from "@/lib/epi-compliance";
import { EmptyState, ErrorBanner, LoadingState, StatusPill } from "../shared";
import { currency, dateLabel, fileSize, normalizeDossier, requestJson, type Row } from "./epi.api";
import type { EmployeeEpiDossier } from "./epi.types";
import styles from "./epi.module.css";

/**
 * A aba de EPIs dentro do cadastro do colaborador.
 *
 * Mostra a mesma verdade do módulo, lida da mesma fonte — não há segunda
 * consulta com regra própria, e por isso a aba e o relatório nunca discordam
 * sobre o que a pessoa tem em mãos.
 *
 * A aba é de consulta: registrar entrega, devolução ou troca acontece no módulo,
 * onde estão as validações de estoque e a evidência. Oferecer os mesmos botões
 * aqui criaria dois caminhos para o mesmo ato, com metade das checagens.
 */
export function EmployeeEpiPanel({ employeeId }: { employeeId: string }) {
  const [dossier, setDossier] = useState<EmployeeEpiDossier | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDossier(normalizeDossier(await requestJson<Row>(`/api/epi/employees/${employeeId}`)));
      setError("");
    } catch (cause) {
      setDossier(null);
      setError(cause instanceof Error ? cause.message : "Erro ao carregar os EPIs do colaborador.");
    } finally {
      setLoading(false);
    }
  }, [employeeId]);

  // O carregamento é adiado para depois da pintura: chamar `setState` no corpo
  // do efeito encadeia renderizações, e a gaveta do colaborador já está
  // montando outras abas no mesmo quadro.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  if (loading) {
    return <div className={styles.workspace}>
      <LoadingState size="compact" title="Carregando EPIs" text="Buscando entregas, devoluções e casos em análise…" />
    </div>;
  }
  if (error) {
    return <div className={styles.workspace}>
      <ErrorBanner title="Não foi possível carregar os EPIs" message={error} />
      <EmptyState icon={AlertTriangle} size="compact" title="EPIs indisponíveis"
        text="Isso pode ser falta de permissão para o módulo, ou uma falha momentânea."
        action={<button className={styles.secondaryButton} onClick={() => void load()}><RefreshCw aria-hidden="true" /> Tentar novamente</button>} />
    </div>;
  }
  if (!dossier) return null;

  const activeUnits = dossier.activeDeliveries.reduce((sum, item) => sum + item.outstanding, 0);
  const activeValue = dossier.activeDeliveries.reduce((sum, item) => sum + item.outstanding * item.unitValue, 0);
  const openDiscounts = dossier.discounts.filter((item) => ["awaiting_dp_analysis", "awaiting_approval"].includes(item.status));
  const unsigned = dossier.deliveries.filter((item) => item.status === "pending_signature").length;
  const nothing = !dossier.deliveries.length && !dossier.returns.length && !dossier.damages.length
    && !dossier.disposals.length && !dossier.discounts.length;

  if (nothing && !dossier.compliance) {
    return <div className={styles.workspace}>
      <EmptyState icon={HardHat} size="compact" title="Nenhum EPI registrado para este colaborador"
        text="Quando um equipamento for entregue no Controle de EPI, a entrega, o termo e todo o histórico aparecem aqui." />
    </div>;
  }

  return <div className={`${styles.workspace} ${styles.employeePanel}`}>
    <div className={styles.summaryGrid}>
      {dossier.compliance && <article className={styles.summaryCard}
        data-tone={["missing", "expired"].includes(dossier.compliance.status) ? "danger"
          : ["overdue", "due_soon"].includes(dossier.compliance.status) ? "warning" : "safe"}>
        <span><ShieldCheckIcon />Conformidade da lotação</span>
        <strong>{dossier.compliance.requiredItems ? `${dossier.compliance.compliantItems}/${dossier.compliance.requiredItems}` : "—"}</strong>
        <small>{epiComplianceStatusLabels[dossier.compliance.status]}</small>
      </article>}
      <article className={styles.summaryCard} data-tone={activeUnits ? "neutral" : "safe"}>
        <span><Boxes aria-hidden="true" />Em poder do colaborador</span>
        <strong>{activeUnits}</strong><small>{currency(activeValue)} em equipamentos</small>
      </article>
      <article className={styles.summaryCard} data-tone={unsigned ? "warning" : "safe"}>
        <span><PackageCheck aria-hidden="true" />Termos pendentes</span>
        <strong>{unsigned}</strong><small>Entregas sem assinatura</small>
      </article>
      <article className={styles.summaryCard} data-tone={openDiscounts.length ? "danger" : "safe"}>
        <span><Scale aria-hidden="true" />Descontos em análise</span>
        <strong>{openDiscounts.length}</strong><small>Demandas abertas no DP</small>
      </article>
      <article className={styles.summaryCard}>
        <span><ArrowLeftRight aria-hidden="true" />Movimentações</span>
        <strong>{dossier.movements.length}</strong><small>Registros no histórico</small>
      </article>
    </div>

    {dossier.compliance && <Section title="Cobertura obrigatória do cargo e departamento" count={dossier.compliance.items.length}>
      {dossier.compliance.items.length ? <Table
        head={["EPI obrigatório", "Necessário", "Em poder", "Última entrega", "Próxima troca", "Validade", "Situação"]}
        rows={dossier.compliance.items.map((item) => [
          item.productName, String(item.requiredQuantity), String(item.heldQuantity), dateLabel(item.lastDeliveredOn),
          dateLabel(item.nextExchangeOn), item.expiresOn ? `${dateLabel(item.expiresOn)}${item.expiryReason ? ` · ${item.expiryReason}` : ""}` : "—",
          <StatusPill key={item.requirementId} status={complianceTone(item.status)} label={epiComplianceStatusLabels[item.status]} />,
        ])} /> : <div className={styles.noticeBar}><AlertTriangle aria-hidden="true" /><span>
          <strong>Sem regra obrigatória definida</strong>Cadastre os EPIs exigidos para este cargo ou departamento no Controle de EPI.
        </span></div>}
    </Section>}

    <Section title="EPIs ativos com o colaborador" count={dossier.activeDeliveries.length}>
      {dossier.activeDeliveries.length ? <Table
        head={["EPI", "CA", "Tamanho", "Entregue em", "Em poder", "Termo"]}
        rows={dossier.activeDeliveries.map((item) => [
          item.epiName, item.caNumber || "—", item.size || "—", dateLabel(item.deliveredOn),
          String(item.outstanding),
          <StatusPill key={item.id} status={item.status} label={epiDeliveryStatusLabels[item.status] ?? item.status} />,
        ])} />
        : <Note>Nenhum EPI em poder do colaborador no momento.</Note>}
    </Section>

    <Section title="Entregas realizadas" count={dossier.deliveries.length}>
      {dossier.deliveries.length ? <Table
        head={["Data", "EPI", "Qtd.", "Devolvido", "Motivo", "Status"]}
        rows={dossier.deliveries.map((item) => [
          dateLabel(item.deliveredOn), item.epiName, String(item.quantity), String(item.settledQuantity),
          item.deliveryReason, <StatusPill key={item.id} status={item.status} label={epiDeliveryStatusLabels[item.status] ?? item.status} />,
        ])} />
        : <Note>Nenhuma entrega registrada.</Note>}
    </Section>

    <Section title="Devoluções" count={dossier.returns.length}>
      {dossier.returns.length ? <Table
        head={["Data", "EPI", "Qtd.", "Condição", "Destino"]}
        rows={dossier.returns.map((item) => [
          dateLabel(item.returnedOn), item.epiName, String(item.quantity),
          epiReturnConditionLabels[item.condition] ?? item.condition,
          [item.backToStock ? "Estoque" : "", item.needsSanitizing ? "Higienização" : "",
            item.sendToDisposal ? "Descarte" : "", item.generateDpDemand ? "Demanda DP" : ""].filter(Boolean).join(" · ") || "—",
        ])} />
        : <Note>Nenhuma devolução registrada.</Note>}
    </Section>

    <Section title="Trocas e danificações" count={dossier.damages.length}>
      {dossier.damages.length ? <Table
        head={["Data", "EPI", "Motivo", "Decisão", "Novo EPI"]}
        rows={dossier.damages.map((item) => [
          dateLabel(item.occurredOn), item.epiName,
          epiDamageReasonLabels[item.damageReason] ?? item.damageReason,
          epiDamageDecisionLabels[item.decision] ?? item.decision,
          item.replacementEpiName || "—",
        ])} />
        : <Note>Nenhuma troca por danificação registrada.</Note>}
    </Section>

    <Section title="Descartes vinculados" count={dossier.disposals.length}>
      {dossier.disposals.length ? <Table
        head={["Data", "EPI", "Qtd.", "Motivo", "Status"]}
        rows={dossier.disposals.map((item) => [
          dateLabel(item.disposalDate), item.epiName, String(item.quantity),
          epiDisposalReasonLabels[item.disposalReason] ?? item.disposalReason,
          <StatusPill key={item.id} status={item.status} label={epiDisposalStatusLabels[item.status] ?? item.status} />,
        ])} />
        : <Note>Nenhum descarte vinculado a este colaborador.</Note>}
    </Section>

    <Section title="Análises de desconto" count={dossier.discounts.length}>
      {dossier.discounts.length ? <Table
        head={["Ocorrência", "EPI", "Motivo", "Em análise", "Decisão", "Status"]}
        rows={dossier.discounts.map((item) => [
          dateLabel(item.occurredOn), item.epiName,
          epiDiscountTriggerLabels[item.triggerReason] ?? item.triggerReason,
          currency(item.totalValue),
          item.decision ? `${epiDiscountDecisionLabels[item.decision] ?? item.decision}${item.decidedValue ? ` · ${currency(item.decidedValue)}` : ""}` : "—",
          <StatusPill key={item.id} status={item.status} label={epiDiscountStatusLabels[item.status] ?? item.status} />,
        ])} />
        : <Note>Nenhuma análise de desconto para este colaborador.</Note>}
    </Section>

    <Section title="Termos, anexos e evidências" count={dossier.attachments.length}>
      {dossier.attachments.length ? <div className={styles.attachmentList}>
        {dossier.attachments.map((item) => <div key={item.id} className={styles.attachmentRow}>
          <Paperclip aria-hidden="true" />
          <a href={`/api/epi/attachments/${item.id}`} download>{item.filename}</a>
          <span>{fileSize(item.sizeBytes)} · {dateLabel(item.createdAt)}</span>
          <a className={styles.ghostButton} href={`/api/epi/attachments/${item.id}`} download aria-label={`Baixar ${item.filename}`}>
            <Download aria-hidden="true" />
          </a>
        </div>)}
      </div> : <Note>Nenhum anexo enviado. O termo de entrega assinado pode ser anexado à entrega no Controle de EPI.</Note>}
    </Section>

    <Section title="Histórico completo de movimentações" count={dossier.movements.length}>
      {dossier.movements.length ? <ol className={styles.timeline}>
        {dossier.movements.map((item) => {
          const Icon = movementIcon(item.movementType);
          return <li key={item.id}>
            <span className={styles.timelineMark}><Icon aria-hidden="true" /></span>
            <div className={styles.timelineBody}>
              <strong>{epiMovementTypeLabels[item.movementType as keyof typeof epiMovementTypeLabels] ?? item.movementType} · {item.epiName}</strong>
              <small>
                {dateLabel(item.movementDate)} · {item.quantity} un.
                {item.caNumber ? ` · CA ${item.caNumber}` : ""}{item.size ? ` · ${item.size}` : ""}
                {item.stockDelta ? ` · estoque ${item.stockDelta > 0 ? "+" : ""}${item.stockDelta}` : ""}
              </small>
              {item.generateDpDemand && <p>Demanda aberta para o Departamento Pessoal analisar possível desconto.</p>}
              {item.notes && <p>{item.notes}</p>}
            </div>
          </li>;
        })}
      </ol> : <Note>Sem movimentações registradas.</Note>}
    </Section>
  </div>;
}

function movementIcon(type: string) {
  if (type === "delivery") return PackageCheck;
  if (type === "return") return Undo2;
  if (type === "exchange") return ArrowLeftRight;
  if (type === "disposal") return Trash2;
  if (type === "discount_analysis") return Scale;
  return Boxes;
}

function complianceTone(status: EpiComplianceStatus) {
  if (["missing", "expired"].includes(status)) return "danger";
  if (["overdue", "due_soon"].includes(status)) return "warning";
  if (status === "compliant") return "active";
  return "neutral";
}

function ShieldCheckIcon() {
  return <HardHat aria-hidden="true" />;
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return <section>
    <header className={styles.sectionTitle}><h3>{title}</h3><span>{count} registro(s)</span></header>
    {children}
  </section>;
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className={styles.fieldHint}>{children}</p>;
}

function Table({ head, rows }: { head: string[]; rows: Array<Array<React.ReactNode>> }) {
  return <div className={styles.tableWrap}>
    <table className={styles.dataTable}>
      <thead><tr>{head.map((label) => <th key={label}>{label}</th>)}</tr></thead>
      <tbody>{rows.map((cells, index) => <tr key={index}>{cells.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
    </table>
  </div>;
}
