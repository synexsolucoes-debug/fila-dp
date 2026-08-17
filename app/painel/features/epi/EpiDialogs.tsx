"use client";

import { FormEvent, useMemo, useState } from "react";
import { AlertTriangle, Info, Paperclip, X } from "lucide-react";
import {
  damageRouting, epiDamageDecisionLabels, epiDamageDecisions, epiDamageReasonLabels, epiDamageReasons,
  epiDeliveryStatusLabels, epiDisposalReasonLabels, epiDisposalReasons, epiDiscountDecisionLabels,
  epiDiscountDecisions, epiProductStatusLabels, epiProductStatuses, epiRegistrationReasonLabels,
  epiRegistrationReasons, epiReturnConditionLabels, epiReturnConditions, epiTypeLabels, epiTypes,
  returnRouting, type EpiDamageDecision, type EpiDiscountDecision, type EpiReturnCondition,
} from "@/lib/epi";
import { currency, dateLabel } from "./epi.api";
import type { EmployeeOption, EpiEditor, EpiProduct } from "./epi.types";
import styles from "./epi.module.css";

/**
 * Formulários do módulo.
 *
 * Um componente por diálogo seria a divisão óbvia; a razão de estarem juntos é
 * que todos compartilham a mesma casca — gaveta lateral, rodapé fixo, mesmo
 * tratamento de envio e de erro — e sete cópias dessa casca é exatamente o tipo
 * de divergência que o §16 do produto foi corrigir.
 *
 * O que muda de diálogo para diálogo é só o corpo, e dois deles mostram a
 * consequência da escolha **antes** de gravar: devolução e troca por dano
 * calculam o destino com a mesma função que o servidor usa, de modo que a
 * pessoa vê "vai para descarte" ou "abre demanda para o DP" enquanto ainda pode
 * mudar de ideia.
 */

const today = () => new Date().toISOString().slice(0, 10);
const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

export function EpiDialog({ editor, products, employees, deliveries, busy, error, onClose, onSubmit }: {
  editor: NonNullable<EpiEditor>;
  products: EpiProduct[];
  employees: EmployeeOption[];
  deliveries: Array<{ id: string; label: string; outstanding: number }>;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => void | Promise<void>;
}) {
  const meta = dialogMeta(editor);
  const [condition, setCondition] = useState<EpiReturnCondition>("returned_sanitized");
  const [decision, setDecision] = useState<EpiDamageDecision>("exchange_without_discount");
  const [discountDecision, setDiscountDecision] = useState<EpiDiscountDecision>("no_discount");

  const returnPreview = useMemo(() => returnRouting(condition), [condition]);
  const damagePreview = useMemo(() => damageRouting(decision), [decision]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void onSubmit(buildPayload(editor, form, { condition, decision, discountDecision }));
  }

  return <div className={styles.drawerOverlay} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="epi-dialog-title">
      <form onSubmit={handleSubmit}>
        <header className={styles.drawerHeader}>
          <div>
            <span className={styles.eyebrow}>{meta.eyebrow}</span>
            <h2 id="epi-dialog-title">{meta.title}</h2>
            <p>{meta.description}</p>
          </div>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Fechar"><X aria-hidden="true" /></button>
        </header>

        <div className={styles.drawerBody}>
          {error && <div role="alert" className={styles.noticeBar} data-tone="danger">
            <AlertTriangle aria-hidden="true" /><span><strong>Não foi possível concluir</strong>{error}</span>
          </div>}

          {editor.kind === "product" && <ProductForm product={editor.product} />}

          {editor.kind === "delivery" && <DeliveryForm products={products} employees={employees} preselected={editor.product} />}

          {editor.kind === "return" && <ReturnForm
            delivery={editor.delivery} condition={condition} onCondition={setCondition} preview={returnPreview} />}

          {editor.kind === "damage" && <DamageForm
            products={products} employees={employees} deliveries={deliveries} delivery={editor.delivery}
            decision={decision} onDecision={setDecision} preview={damagePreview} />}

          {editor.kind === "disposal" && <DisposalForm products={products} preselected={editor.product} />}

          {editor.kind === "disposal-decision" && <DisposalDecisionForm disposal={editor.disposal} action={editor.action} />}

          {editor.kind === "discount" && <DiscountForm
            discount={editor.discount} decision={discountDecision} onDecision={setDiscountDecision} />}
        </div>

        <footer className={styles.drawerFooter}>
          <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className={styles.primaryButton} disabled={busy}>{busy ? "Gravando…" : meta.confirm}</button>
        </footer>
      </form>
    </aside>
  </div>;
}

function dialogMeta(editor: NonNullable<EpiEditor>) {
  switch (editor.kind) {
    case "product":
      return editor.product
        ? { eyebrow: "CADASTRO DE EPI", title: editor.product.name, description: "Altere os dados do equipamento. O ajuste de estoque exige motivo.", confirm: "Salvar alterações" }
        : { eyebrow: "CADASTRO DE EPI", title: "Novo EPI", description: "Registre o equipamento, o CA e a quantidade que entra em estoque.", confirm: "Cadastrar EPI" };
    case "delivery":
      return { eyebrow: "ENTREGA AO COLABORADOR", title: "Entregar EPI", description: "A quantidade sai do estoque e passa a constar com o colaborador.", confirm: "Registrar entrega" };
    case "return":
      return { eyebrow: "DEVOLUÇÃO", title: "Receber devolução", description: "A condição informada decide o destino do equipamento.", confirm: "Registrar devolução" };
    case "damage":
      return { eyebrow: "TROCA POR DANIFICAÇÃO", title: "Registrar danificação", description: "Descreva o ocorrido e decida o que acontece com o equipamento.", confirm: "Registrar decisão" };
    case "disposal":
      return { eyebrow: "DESCARTE", title: "Abrir descarte", description: "O registro entra na janela como “Aguardando descarte”.", confirm: "Abrir descarte" };
    case "disposal-decision":
      return editor.action === "confirm"
        ? { eyebrow: "DESCARTE", title: "Confirmar descarte", description: "Depois de confirmado, o EPI não volta ao estoque e o registro fica imutável.", confirm: "Confirmar descarte" }
        : editor.action === "cancel"
          ? { eyebrow: "DESCARTE", title: "Cancelar descarte", description: "O registro é encerrado sem descarte. Informe o motivo.", confirm: "Cancelar descarte" }
          : { eyebrow: "DESCARTE", title: "Reavaliar equipamento", description: "O EPI volta para higienização em vez de ser descartado.", confirm: "Enviar para reavaliação" };
    case "discount":
      return { eyebrow: "ANÁLISE DE DESCONTO", title: "Decidir análise", description: "A decisão é registrada como parecer. Nenhum valor é lançado em folha por aqui.", confirm: "Registrar decisão" };
  }
}

function buildPayload(editor: NonNullable<EpiEditor>, form: FormData, state: {
  condition: EpiReturnCondition; decision: EpiDamageDecision; discountDecision: EpiDiscountDecision;
}): Record<string, unknown> {
  switch (editor.kind) {
    case "product":
      return {
        companyId: field(form, "companyId"), name: field(form, "name"), epiType: field(form, "epiType"),
        caNumber: field(form, "caNumber"), size: field(form, "size"), brand: field(form, "brand"),
        model: field(form, "model"), unitValue: Number(field(form, "unitValue") || 0),
        stockQuantity: Number(field(form, "stockQuantity") || 0), registeredOn: field(form, "registeredOn"),
        status: field(form, "status"), registrationReason: field(form, "registrationReason"),
        notes: field(form, "notes"), productExpiresOn: field(form, "productExpiresOn") || null,
        caExpiresOn: field(form, "caExpiresOn") || null, supplier: field(form, "supplier"),
        internalCode: field(form, "internalCode"), stockAdjustmentReason: field(form, "stockAdjustmentReason"),
      };
    case "delivery":
      return {
        companyId: field(form, "companyId"), productId: field(form, "productId"), employeeId: field(form, "employeeId"),
        deliveredOn: field(form, "deliveredOn"), quantity: Number(field(form, "quantity") || 0),
        caNumber: field(form, "caNumber"), size: field(form, "size"),
        unitValue: Number(field(form, "unitValue") || 0), positionName: field(form, "positionName"),
        departmentName: field(form, "departmentName"), deliveryReason: field(form, "deliveryReason"),
        status: field(form, "status"), signatureName: field(form, "signatureName"), notes: field(form, "notes"),
      };
    case "return":
      return {
        deliveryId: editor.delivery.id, returnedOn: field(form, "returnedOn"),
        quantity: Number(field(form, "quantity") || 0), epiCondition: state.condition,
        receivedBy: field(form, "receivedBy"), notes: field(form, "notes"),
      };
    case "damage":
      return {
        companyId: field(form, "companyId"), employeeId: field(form, "employeeId"),
        productId: field(form, "productId"), deliveryId: field(form, "deliveryId") || null,
        occurredOn: field(form, "occurredOn"), quantity: Number(field(form, "quantity") || 1),
        damageReason: field(form, "damageReason"), description: field(form, "description"),
        decision: state.decision, replacementProductId: field(form, "replacementProductId") || null,
        replacementQuantity: Number(field(form, "replacementQuantity") || 0),
        replacementCaNumber: field(form, "replacementCaNumber"), replacementSize: field(form, "replacementSize"),
        notes: field(form, "notes"),
      };
    case "disposal":
      return {
        companyId: field(form, "companyId"), productId: field(form, "productId"),
        employeeId: field(form, "employeeId") || null, disposalDate: field(form, "disposalDate"),
        quantity: Number(field(form, "quantity") || 0), disposalReason: field(form, "disposalReason"),
        caNumber: field(form, "caNumber"), size: field(form, "size"), notes: field(form, "notes"),
      };
    case "disposal-decision":
      return { action: editor.action, notes: field(form, "notes") };
    case "discount":
      return {
        decision: state.discountDecision, decidedValue: Number(field(form, "decidedValue") || 0),
        comment: field(form, "comment"),
      };
  }
}

const Required = () => <b className={styles.requiredMark} aria-hidden="true"> *</b>;

function ProductForm({ product }: { product?: EpiProduct }) {
  const [stock, setStock] = useState(String(product?.stockQuantity ?? 0));
  const changed = Boolean(product) && Number(stock) !== product?.stockQuantity;
  return <>
    <input type="hidden" name="companyId" value={product?.companyId ?? ""} />
    <div className={styles.formGrid}>
      <label><span>NOME DO EPI<Required /></span><input name="name" defaultValue={product?.name ?? ""} required maxLength={160} /></label>
      <label><span>TIPO<Required /></span><select name="epiType" defaultValue={product?.epiType ?? "head"}>
        {epiTypes.map((item) => <option key={item} value={item}>{epiTypeLabels[item]}</option>)}
      </select></label>
      <label><span>NÚMERO DO CA<Required /></span><input name="caNumber" defaultValue={product?.caNumber ?? ""} required maxLength={40} /></label>
      <label><span>TAMANHO<Required /></span><input name="size" defaultValue={product?.size ?? ""} required maxLength={40} /></label>
      <label><span>MARCA<Required /></span><input name="brand" defaultValue={product?.brand ?? ""} required maxLength={120} /></label>
      <label><span>MODELO<Required /></span><input name="model" defaultValue={product?.model ?? ""} required maxLength={120} /></label>
      <label><span>VALOR UNITÁRIO<Required /></span><input name="unitValue" type="number" min="0" step="0.01" defaultValue={product?.unitValue ?? 0} required /></label>
      <label><span>QUANTIDADE EM ESTOQUE<Required /></span>
        <input name="stockQuantity" type="number" min="0" step="1" value={stock} onChange={(event) => setStock(event.target.value)} required />
      </label>
      <label><span>DATA DO CADASTRO<Required /></span><input name="registeredOn" type="date" defaultValue={product?.registeredOn || today()} required /></label>
      <label><span>STATUS<Required /></span><select name="status" defaultValue={product?.status ?? "in_stock"}>
        {epiProductStatuses.map((item) => <option key={item} value={item}>{epiProductStatusLabels[item]}</option>)}
      </select></label>
      <label><span>MOTIVO DO CADASTRO<Required /></span><select name="registrationReason" defaultValue={product?.registrationReason ?? "initial_purchase"}>
        {epiRegistrationReasons.map((item) => <option key={item} value={item}>{epiRegistrationReasonLabels[item]}</option>)}
      </select></label>
      <label><span>VALIDADE DO PRODUTO</span><input name="productExpiresOn" type="date" defaultValue={product?.productExpiresOn ?? ""} /></label>
      <label><span>VALIDADE DO CA</span><input name="caExpiresOn" type="date" defaultValue={product?.caExpiresOn ?? ""} /></label>
      <label><span>FORNECEDOR</span><input name="supplier" defaultValue={product?.supplier ?? ""} maxLength={160} /></label>
      <label><span>CÓDIGO INTERNO</span><input name="internalCode" defaultValue={product?.internalCode ?? ""} maxLength={80} /></label>
      {changed && <label className={styles.formWide}>
        <span>MOTIVO DO AJUSTE DE ESTOQUE<Required /></span>
        <input name="stockAdjustmentReason" required maxLength={240} placeholder="Inventário, correção de lançamento, devolução de compra…" />
        <em className={styles.fieldHint}>O saldo muda de {product?.stockQuantity} para {stock}. O ajuste entra no histórico com este motivo.</em>
      </label>}
      <label className={styles.formWide}><span>OBSERVAÇÃO<Required /></span>
        <textarea name="notes" defaultValue={product?.notes ?? ""} required maxLength={2000} />
      </label>
    </div>
  </>;
}

function DeliveryForm({ products, employees, preselected }: { products: EpiProduct[]; employees: EmployeeOption[]; preselected?: EpiProduct }) {
  const available = products.filter((item) => !["discarded", "lost", "inactive"].includes(item.status));
  const [productId, setProductId] = useState(preselected?.id ?? available[0]?.id ?? "");
  const product = available.find((item) => item.id === productId) ?? preselected;
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? "");
  const employee = employees.find((item) => item.id === employeeId);

  if (!available.length) {
    return <div className={styles.noticeBar}><Info aria-hidden="true" />
      <span><strong>Nenhum EPI disponível</strong>Cadastre um equipamento com saldo em estoque antes de registrar a entrega.</span></div>;
  }
  return <>
    <input type="hidden" name="companyId" value={product?.companyId ?? ""} />
    <div className={styles.formGrid}>
      <label className={styles.formWide}><span>EPI<Required /></span>
        <select name="productId" value={productId} onChange={(event) => setProductId(event.target.value)} required>
          {available.map((item) => <option key={item.id} value={item.id}>
            {item.name} · CA {item.caNumber} · {item.size} · {item.stockQuantity} em estoque
          </option>)}
        </select>
      </label>
      <label className={styles.formWide}><span>COLABORADOR<Required /></span>
        <select name="employeeId" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} required>
          {employees.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.registrationNumber}</option>)}
        </select>
      </label>
      <label><span>CARGO</span><input name="positionName" key={employee?.id} defaultValue={employee?.positionName ?? ""} maxLength={160} /></label>
      <label><span>SETOR</span><input name="departmentName" key={`${employee?.id}-dep`} defaultValue={employee?.departmentName ?? ""} maxLength={160} /></label>
      <label><span>DATA DA ENTREGA<Required /></span><input name="deliveredOn" type="date" defaultValue={today()} required /></label>
      <label><span>QUANTIDADE<Required /></span>
        <input name="quantity" type="number" min="1" max={product?.stockQuantity || 1} step="1" defaultValue={1} required />
      </label>
      <label><span>CA</span><input name="caNumber" key={`${productId}-ca`} defaultValue={product?.caNumber ?? ""} maxLength={40} /></label>
      <label><span>TAMANHO</span><input name="size" key={`${productId}-size`} defaultValue={product?.size ?? ""} maxLength={40} /></label>
      <label><span>VALOR UNITÁRIO</span>
        <input name="unitValue" key={`${productId}-value`} type="number" min="0" step="0.01" defaultValue={product?.unitValue ?? 0} />
      </label>
      <label><span>MOTIVO DA ENTREGA<Required /></span><select name="deliveryReason" defaultValue="first_delivery">
        {epiRegistrationReasons.map((item) => <option key={item} value={item}>{epiRegistrationReasonLabels[item]}</option>)}
      </select></label>
      <label><span>STATUS DA ENTREGA<Required /></span><select name="status" defaultValue="pending_signature">
        {(["delivered", "pending_signature", "signed"] as const).map((item) =>
          <option key={item} value={item}>{epiDeliveryStatusLabels[item]}</option>)}
      </select></label>
      <label><span>ASSINATURA DO COLABORADOR</span><input name="signatureName" maxLength={160} placeholder="Quem assinou o termo, se já assinado" /></label>
      <label className={styles.formWide}><span>OBSERVAÇÃO</span><textarea name="notes" maxLength={2000} /></label>
    </div>
    <div className={styles.consequence}>
      <strong>O que acontece ao gravar</strong>
      <ul>
        <li>A quantidade sai do estoque de {product?.name || "—"} ({product?.stockQuantity ?? 0} disponíveis).</li>
        <li>O EPI passa a constar com {employee?.name || "o colaborador"} até a devolução.</li>
        <li>A entrega entra no histórico do colaborador e no razão de movimentações.</li>
      </ul>
    </div>
    <p className={styles.fieldHint}>
      <Paperclip aria-hidden="true" /> O termo de entrega assinado pode ser anexado ao registro depois de gravar, pela gaveta da entrega.
    </p>
  </>;
}

function ReturnForm({ delivery, condition, onCondition, preview }: {
  delivery: { id: string; epiName: string; employeeName: string; outstanding: number; caNumber: string; size: string };
  condition: EpiReturnCondition;
  onCondition: (value: EpiReturnCondition) => void;
  preview: ReturnType<typeof returnRouting>;
}) {
  return <>
    <dl className={styles.factList}>
      <div><dt>EPI</dt><dd>{delivery.epiName} · CA {delivery.caNumber || "—"} · {delivery.size || "—"}</dd></div>
      <div><dt>Colaborador</dt><dd>{delivery.employeeName}</dd></div>
      <div><dt>Em poder do colaborador</dt><dd>{delivery.outstanding}</dd></div>
    </dl>
    <div className={styles.formGrid}>
      <label><span>DATA DA DEVOLUÇÃO<Required /></span><input name="returnedOn" type="date" defaultValue={today()} required /></label>
      <label><span>QUANTIDADE<Required /></span>
        <input name="quantity" type="number" min="1" max={delivery.outstanding} step="1" defaultValue={delivery.outstanding} required />
      </label>
      <label className={styles.formWide}><span>CONDIÇÃO DO EPI<Required /></span>
        <select name="epiCondition" value={condition} onChange={(event) => onCondition(event.target.value as EpiReturnCondition)} required>
          {epiReturnConditions.map((item) => <option key={item} value={item}>{epiReturnConditionLabels[item]}</option>)}
        </select>
      </label>
      <label><span>RESPONSÁVEL PELO RECEBIMENTO</span><input name="receivedBy" maxLength={120} /></label>
      <label className={styles.formWide}><span>OBSERVAÇÃO</span><textarea name="notes" maxLength={2000} /></label>
    </div>
    <div className={styles.consequence}>
      <strong>Destino desta devolução</strong>
      <ul>
        <li>{preview.backToStock ? "Volta ao estoque e fica disponível para nova entrega." : "Não volta ao estoque."}</li>
        {preview.needsSanitizing && <li>Segue para higienização — o EPI fica com o status “Em higienização”.</li>}
        {preview.sendToDisposal && <li data-alert="true">Entra na janela de descarte como “Aguardando descarte”.</li>}
        {preview.generateDpDemand && <li data-alert="true">
          Abre demanda automática para o DP analisar possível desconto. Nenhum valor é descontado aqui.
        </li>}
        <li>A baixa é registrada na entrega e no histórico do colaborador.</li>
      </ul>
    </div>
  </>;
}

function DamageForm({ products, employees, deliveries, delivery, decision, onDecision, preview }: {
  products: EpiProduct[];
  employees: EmployeeOption[];
  deliveries: Array<{ id: string; label: string; outstanding: number }>;
  delivery?: { id: string; productId: string; employeeId: string; companyId: string; outstanding: number };
  decision: EpiDamageDecision;
  onDecision: (value: EpiDamageDecision) => void;
  preview: ReturnType<typeof damageRouting>;
}) {
  const [productId, setProductId] = useState(delivery?.productId ?? products[0]?.id ?? "");
  const product = products.find((item) => item.id === productId);
  const replacements = products.filter((item) => item.id !== productId && item.stockQuantity > 0);
  return <>
    <input type="hidden" name="companyId" value={delivery?.companyId ?? product?.companyId ?? ""} />
    <div className={styles.formGrid}>
      <label className={styles.formWide}><span>COLABORADOR<Required /></span>
        <select name="employeeId" defaultValue={delivery?.employeeId ?? employees[0]?.id ?? ""} required>
          {employees.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.registrationNumber}</option>)}
        </select>
      </label>
      <label className={styles.formWide}><span>EPI DANIFICADO<Required /></span>
        <select name="productId" value={productId} onChange={(event) => setProductId(event.target.value)} required>
          {products.map((item) => <option key={item.id} value={item.id}>{item.name} · CA {item.caNumber} · {item.size}</option>)}
        </select>
      </label>
      <label className={styles.formWide}><span>ENTREGA DE ORIGEM</span>
        <select name="deliveryId" defaultValue={delivery?.id ?? ""}>
          <option value="">Sem entrega vinculada</option>
          {deliveries.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <label><span>DATA DA OCORRÊNCIA<Required /></span><input name="occurredOn" type="date" defaultValue={today()} required /></label>
      <label><span>QUANTIDADE<Required /></span>
        <input name="quantity" type="number" min="1" max={delivery?.outstanding || undefined} step="1" defaultValue={1} required />
      </label>
      <label className={styles.formWide}><span>MOTIVO DA DANIFICAÇÃO<Required /></span>
        <select name="damageReason" defaultValue="natural_wear" required>
          {epiDamageReasons.map((item) => <option key={item} value={item}>{epiDamageReasonLabels[item]}</option>)}
        </select>
      </label>
      <label className={styles.formWide}><span>DESCRIÇÃO DO OCORRIDO<Required /></span>
        <textarea name="description" required maxLength={2000} placeholder="O que aconteceu, quando e em que circunstância." />
      </label>
      <label className={styles.formWide}><span>DECISÃO<Required /></span>
        <select name="decision" value={decision} onChange={(event) => onDecision(event.target.value as EpiDamageDecision)} required>
          {epiDamageDecisions.map((item) => <option key={item} value={item}>{epiDamageDecisionLabels[item]}</option>)}
        </select>
      </label>
      {preview.deliverReplacement && <>
        <label className={styles.formWide}><span>NOVO EPI ENTREGUE{decision === "exchange_without_discount" && <Required />}</span>
          <select name="replacementProductId" defaultValue="">
            <option value="">Não entregar substituto agora</option>
            {replacements.map((item) => <option key={item.id} value={item.id}>
              {item.name} · CA {item.caNumber} · {item.size} · {item.stockQuantity} em estoque
            </option>)}
          </select>
        </label>
        <label><span>CA DO NOVO EPI</span><input name="replacementCaNumber" maxLength={40} /></label>
        <label><span>TAMANHO DO NOVO EPI</span><input name="replacementSize" maxLength={40} /></label>
        <label><span>QUANTIDADE DO NOVO EPI</span><input name="replacementQuantity" type="number" min="0" step="1" defaultValue={1} /></label>
      </>}
      <label className={styles.formWide}><span>OBSERVAÇÃO</span><textarea name="notes" maxLength={2000} /></label>
    </div>
    <div className={styles.consequence}>
      <strong>O que esta decisão provoca</strong>
      <ul>
        {preview.settleOldDelivery && <li>Baixa do equipamento antigo na entrega — ele deixa de constar com o colaborador.</li>}
        {preview.createDisposal && <li data-alert="true">Abre registro na janela de descarte.</li>}
        {preview.productStatus === "sanitizing" && <li>O EPI passa para “Em higienização”.</li>}
        {preview.deliverReplacement && <li>Permite entregar o substituto na mesma operação, com novo termo pendente de assinatura.</li>}
        {preview.discountTrigger && <li data-alert="true">
          Abre demanda automática para o DP analisar possível desconto. Nenhum valor é descontado aqui.
        </li>}
        {!preview.settleOldDelivery && !preview.createDisposal && !preview.discountTrigger
          && <li>Somente o registro da ocorrência é gravado, com a evidência anexada.</li>}
      </ul>
    </div>
  </>;
}

function DisposalForm({ products, preselected }: { products: EpiProduct[]; preselected?: { id: string; companyId: string; name: string; caNumber: string; size: string; stockQuantity: number } }) {
  const [productId, setProductId] = useState(preselected?.id ?? products[0]?.id ?? "");
  const product = products.find((item) => item.id === productId);
  const stock = product?.stockQuantity ?? preselected?.stockQuantity ?? 0;
  return <>
    <input type="hidden" name="companyId" value={product?.companyId ?? preselected?.companyId ?? ""} />
    <div className={styles.formGrid}>
      <label className={styles.formWide}><span>EPI<Required /></span>
        <select name="productId" value={productId} onChange={(event) => setProductId(event.target.value)} required>
          {products.map((item) => <option key={item.id} value={item.id}>
            {item.name} · CA {item.caNumber} · {item.size} · {item.stockQuantity} em estoque
          </option>)}
        </select>
      </label>
      <label><span>DATA DO DESCARTE<Required /></span><input name="disposalDate" type="date" defaultValue={today()} required /></label>
      <label><span>QUANTIDADE<Required /></span>
        <input name="quantity" type="number" min="1" max={stock || 1} step="1" defaultValue={Math.min(1, stock) || 1} required />
      </label>
      <label><span>CA</span><input name="caNumber" key={`${productId}-ca`} defaultValue={product?.caNumber ?? preselected?.caNumber ?? ""} maxLength={40} /></label>
      <label><span>TAMANHO</span><input name="size" key={`${productId}-size`} defaultValue={product?.size ?? preselected?.size ?? ""} maxLength={40} /></label>
      <label className={styles.formWide}><span>MOTIVO DO DESCARTE<Required /></span>
        <select name="disposalReason" defaultValue="natural_wear" required>
          {epiDisposalReasons.map((item) => <option key={item} value={item}>{epiDisposalReasonLabels[item]}</option>)}
        </select>
      </label>
      <label className={styles.formWide}><span>OBSERVAÇÃO</span><textarea name="notes" maxLength={2000} /></label>
    </div>
    <div className={styles.consequence}>
      <strong>O que acontece ao gravar</strong>
      <ul>
        <li>O registro entra na janela como “Aguardando descarte”; o estoque só é debitado na confirmação.</li>
        <li>A confirmação exige responsável e data, e depois dela o registro fica imutável.</li>
      </ul>
    </div>
  </>;
}

function DisposalDecisionForm({ disposal, action }: {
  disposal: { epiName: string; quantity: number; disposalDate: string; employeeName: string; originType: string };
  action: "confirm" | "cancel" | "reevaluate";
}) {
  return <>
    <dl className={styles.factList}>
      <div><dt>EPI</dt><dd>{disposal.epiName}</dd></div>
      <div><dt>Quantidade</dt><dd>{disposal.quantity}</dd></div>
      <div><dt>Aberto em</dt><dd>{dateLabel(disposal.disposalDate)}</dd></div>
      {disposal.employeeName && <div><dt>Colaborador vinculado</dt><dd>{disposal.employeeName}</dd></div>}
    </dl>
    {action === "confirm" && <div className={styles.noticeBar}><AlertTriangle aria-hidden="true" />
      <span><strong>Esta ação não tem volta</strong>
        Depois de confirmado, o equipamento não retorna ao estoque e o registro não aceita alteração.
        {disposal.originType === "manual" ? " A quantidade sai do estoque agora." : " O equipamento já havia saído do estoque na entrega."}
      </span></div>}
    <div className={styles.formField}>
      <span>{action === "confirm" ? "OBSERVAÇÃO" : "MOTIVO"}{action !== "confirm" && <Required />}</span>
      <textarea name="notes" required={action !== "confirm"} maxLength={2000}
        placeholder={action === "confirm" ? "Destinação dada ao equipamento, número do manifesto…" : "Por que este descarte não vai acontecer."} />
    </div>
  </>;
}

function DiscountForm({ discount, decision, onDecision }: {
  discount: { employeeName: string; epiName: string; quantity: number; unitValue: number; totalValue: number; occurredOn: string; reasonNote: string };
  decision: EpiDiscountDecision;
  onDecision: (value: EpiDiscountDecision) => void;
}) {
  const needsValue = decision === "partial_discount";
  return <>
    <dl className={styles.factList}>
      <div><dt>Colaborador</dt><dd>{discount.employeeName}</dd></div>
      <div><dt>EPI</dt><dd>{discount.epiName}</dd></div>
      <div><dt>Quantidade</dt><dd>{discount.quantity}</dd></div>
      <div><dt>Valor unitário</dt><dd>{currency(discount.unitValue)}</dd></div>
      <div><dt>Valor em análise</dt><dd>{currency(discount.totalValue)}</dd></div>
      <div><dt>Ocorrência</dt><dd>{dateLabel(discount.occurredOn)}</dd></div>
    </dl>
    {discount.reasonNote && <p className={styles.fieldHint}>{discount.reasonNote}</p>}
    <div className={styles.formGrid}>
      <label className={styles.formWide}><span>DECISÃO<Required /></span>
        <select name="decision" value={decision} onChange={(event) => onDecision(event.target.value as EpiDiscountDecision)} required>
          {epiDiscountDecisions.map((item) => <option key={item} value={item}>{epiDiscountDecisionLabels[item]}</option>)}
        </select>
      </label>
      {needsValue && <label><span>VALOR DO DESCONTO<Required /></span>
        <input name="decidedValue" type="number" min="0.01" max={discount.totalValue} step="0.01" required />
        <em className={styles.fieldHint}>No máximo {currency(discount.totalValue)}.</em>
      </label>}
      <label className={styles.formWide}>
        <span>PARECER{(decision === "no_discount" || decision === "request_more_info") && <Required />}</span>
        <textarea name="comment" required={decision === "no_discount" || decision === "request_more_info"} maxLength={2000} />
      </label>
    </div>
    <div className={styles.consequence}>
      <strong>O que fica registrado</strong>
      <ul>
        <li>A decisão e o parecer entram na demanda do DP e no histórico do colaborador.</li>
        <li>Nenhum valor é lançado em folha por esta tela: o desconto aprovado segue para execução com o registro em mãos.</li>
      </ul>
    </div>
  </>;
}
