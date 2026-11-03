/**
 * Entrega de EPI com assinatura.
 *
 * Aberta da tela inicial, começa pelo colaborador. Aberta de uma pendência em
 * "Vencimentos e trocas", já chega com colaborador, EPI e — o que importa para
 * o termo — o motivo certo: troca periódica não pode sair como primeira
 * entrega.
 */
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import type { EmployeeOption, EpiProduct } from "@/app/painel/features/epi/epi.types";
import { availableAt, EmployeePicker, ProductPicker } from "../components/Pickers";
import { saveSignaturePng, SignaturePad, type SignatureValue } from "../components/SignaturePad";
import { ActionBar, Banner, Button, Chosen, Field, Hint, Screen, SectionTitle, Stepper } from "../components/ui";
import { today } from "../lib/format";
import { outcome } from "../lib/outcome";
import { submitOperation } from "../lib/queue";
import { useUser } from "../lib/session";
import { useWorkspace } from "../lib/workspace";

type Reason = "first_delivery" | "periodic_exchange" | "expiry_replacement";
const reasonLabels: Record<Reason, string> = {
  first_delivery: "Primeira entrega",
  periodic_exchange: "Troca periódica",
  expiry_replacement: "Substituição por vencimento",
};

export default function Delivery() {
  const router = useRouter();
  const user = useUser();
  const ws = useWorkspace();
  const params = useLocalSearchParams<{
    employeeId?: string; employeeName?: string; registration?: string; position?: string; department?: string;
    productId?: string; productName?: string; reason?: string;
  }>();
  const preset = params.employeeId ? {
    employee: { id: params.employeeId, name: params.employeeName ?? "", registrationNumber: params.registration ?? "",
      positionName: params.position ?? "", departmentName: params.department ?? "" } as EmployeeOption,
    productId: params.productId ?? "", productName: params.productName ?? "",
    reason: (params.reason && params.reason in reasonLabels ? params.reason : "first_delivery") as Reason,
  } : null;

  const [employee, setEmployee] = useState<EmployeeOption | null>(preset?.employee ?? null);
  const [product, setProduct] = useState<EpiProduct | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [signature, setSignature] = useState<SignatureValue | null>(null);
  const [signatureName, setSignatureName] = useState(preset?.employee.name ?? "");
  const [notes, setNotes] = useState("");
  const [drawing, setDrawing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const reason = preset?.reason ?? "first_delivery";
  const companyId = ws.company?.id ?? "";
  const locationId = ws.location?.id ?? "";

  if (!employee) return <Screen>
    <EmployeePicker companyId={companyId} onPick={(picked) => { setEmployee(picked); setSignatureName(picked.name); }} />
  </Screen>;

  if (!product) return <Screen>
    <Chosen label="Colaborador" value={employee.name} onClear={() => setEmployee(null)} />
    <ProductPicker locationId={locationId} onPick={setProduct} initialTerm={preset?.productName ?? ""} preferId={preset?.productId ?? ""} />
  </Screen>;

  const here = availableAt(product, locationId);

  async function submit() {
    if (!employee || !product) return;
    setBusy(true); setProblem("");
    try {
      const attachment = signature ? { ...saveSignaturePng(signature), mimeType: "image/png" as const, kind: "delivery_term" as const } : null;
      const result = await submitOperation({
        kind: "delivery",
        label: `Entrega · ${product.name} · ${employee.name}`,
        owner: user.email,
        payload: {
          companyId, productId: product.id, employeeId: employee.id, stockLocationId: locationId,
          deliveredOn: today(), quantity, caNumber: product.caNumber, size: product.size,
          positionName: employee.positionName, departmentName: employee.departmentName,
          deliveryReason: reason,
          // Sem assinatura a entrega nasce pendente, e o relatório de termos sem
          // assinatura é justamente o que cobra isso depois.
          status: signature ? "signed" : "pending_signature",
          signatureName: signature ? signatureName : "",
          notes,
        },
        attachment,
      });
      ws.notify(outcome(result, {
        sent: "Entrega registrada e estoque atualizado.",
        queued: "Sem rede: entrega guardada no aparelho e será enviada sozinha.",
        partial: "Entrega registrada. O termo assinado ainda não subiu e vai sozinho — não precisa assinar de novo.",
      }));
      await ws.refreshQueue();
      router.dismissTo("/");
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Não foi possível registrar a entrega.");
    } finally { setBusy(false); }
  }

  return <Screen scrollEnabled={!drawing} footer={<ActionBar>
    <Button label="Cancelar" onPress={() => router.back()} disabled={busy} />
    <Button label={busy ? "Gravando…" : "Confirmar entrega"} tone="primary" busy={busy} onPress={() => void submit()} disabled={here <= 0} />
  </ActionBar>}>
    <Chosen label="Colaborador" value={employee.name} onClear={() => setEmployee(null)} />
    <Chosen label="EPI" value={`${product.name} · CA ${product.caNumber || "—"}`} onClear={() => setProduct(null)} />
    {preset ? <Hint>Motivo no termo: {reasonLabels[reason]} — veio da lista de vencimentos.</Hint> : null}

    <SectionTitle>Quantidade</SectionTitle>
    <Stepper value={quantity} onChange={setQuantity} max={here} />
    <Hint tone={here <= 0 ? "warning" : undefined}>{here > 0 ? `${here} disponível(is) neste local.` : "Sem saldo neste local. Troque o local na tela inicial ou faça uma entrada de estoque."}</Hint>

    <SectionTitle>Assinatura do colaborador</SectionTitle>
    <SignaturePad onChange={setSignature} onDrawing={setDrawing} disabled={busy} />
    <Field label="Quem assinou" value={signatureName} onChangeText={setSignatureName} autoCorrect={false} />
    {!signature ? <Hint>Sem assinatura a entrega é gravada como pendente de assinatura e aparece no relatório de termos pendentes.</Hint> : null}

    <Field label="Observação" value={notes} onChangeText={setNotes} multiline placeholder="Opcional" />
    {problem ? <Banner>{problem}</Banner> : null}
  </Screen>;
}
