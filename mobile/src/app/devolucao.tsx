/**
 * Devolução de EPI.
 *
 * O destino não é escolhido: é consequência da condição informada, calculada
 * por `returnRouting` — a mesma função que o servidor usa. A tela mostra a
 * consequência antes de gravar, enquanto a pessoa ainda pode mudar de ideia.
 */
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { epiReturnConditionLabels, epiReturnConditions, returnRouting, type EpiReturnCondition } from "@/lib/epi";
import type { EmployeeOption, EpiDelivery } from "@/app/painel/features/epi/epi.types";
import { ActiveDeliveries, useDossier } from "../components/ActiveDeliveries";
import { EmployeePicker } from "../components/Pickers";
import { ActionBar, Banner, Button, Choices, Chosen, Consequence, Field, Hint, Screen, SectionTitle, Stepper } from "../components/ui";
import { today } from "../lib/format";
import { outcome } from "../lib/outcome";
import { submitOperation } from "../lib/queue";
import { useUser } from "../lib/session";
import { useWorkspace } from "../lib/workspace";

export default function Return() {
  const router = useRouter();
  const user = useUser();
  const ws = useWorkspace();
  const [employee, setEmployee] = useState<EmployeeOption | null>(null);
  const [delivery, setDelivery] = useState<EpiDelivery | null>(null);
  const [condition, setCondition] = useState<EpiReturnCondition>("returned_sanitized");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const { dossier, loading, problem: loadProblem } = useDossier(employee?.id ?? null);
  const routing = useMemo(() => returnRouting(condition), [condition]);

  if (!employee) return <Screen>
    <EmployeePicker companyId={ws.company?.id ?? ""} title="Quem está devolvendo?" onPick={setEmployee} />
  </Screen>;

  if (!delivery) return <Screen>
    <Chosen label="Colaborador" value={employee.name} onClear={() => setEmployee(null)} />
    <ActiveDeliveries title="O que está sendo devolvido?" items={dossier?.activeDeliveries ?? []} loading={loading}
      problem={loadProblem} empty="Este colaborador não tem EPI em poder para devolver."
      onPick={(item) => { setDelivery(item); setQuantity(item.outstanding); }} />
  </Screen>;

  async function submit() {
    if (!employee || !delivery) return;
    setBusy(true); setProblem("");
    try {
      const result = await submitOperation({
        kind: "return",
        label: `Devolução · ${delivery.epiName} · ${employee.name}`,
        owner: user.email,
        payload: {
          deliveryId: delivery.id, stockLocationId: ws.location?.id ?? "", returnedOn: today(),
          quantity, epiCondition: condition, notes,
        },
      });
      ws.notify(outcome(result, {
        sent: "Devolução registrada.",
        queued: "Sem rede: devolução guardada no aparelho e será enviada sozinha.",
        partial: "Devolução registrada. Um envio pendente ficou na fila e vai sozinho.",
      }));
      await ws.refreshQueue();
      router.dismissTo("/");
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Não foi possível registrar a devolução.");
    } finally { setBusy(false); }
  }

  return <Screen footer={<ActionBar>
    <Button label="Cancelar" onPress={() => router.back()} disabled={busy} />
    <Button label={busy ? "Gravando…" : "Confirmar devolução"} tone="primary" busy={busy} onPress={() => void submit()} />
  </ActionBar>}>
    <Chosen label="Colaborador" value={employee.name} onClear={() => { setEmployee(null); setDelivery(null); }} />
    <Chosen label="EPI" value={delivery.epiName} onClear={() => setDelivery(null)} />

    <SectionTitle>Quantidade devolvida</SectionTitle>
    <Stepper value={quantity} onChange={setQuantity} max={delivery.outstanding} />
    <Hint>{delivery.outstanding} em poder do colaborador.</Hint>

    <SectionTitle>Condição do EPI</SectionTitle>
    <Choices label="Condição do EPI" value={condition} onChange={setCondition}
      options={epiReturnConditions.map((id) => ({ id, label: epiReturnConditionLabels[id] }))} />

    <Consequence title="O que acontece ao confirmar" items={[
      { text: routing.backToStock ? "Volta ao estoque deste local." : "Não volta ao estoque." },
      ...(routing.needsSanitizing ? [{ text: "Segue para higienização." }] : []),
      ...(routing.sendToDisposal ? [{ text: "Entra na fila de descarte.", alert: true }] : []),
      ...(routing.generateDpDemand ? [{ text: "Abre demanda para o DP analisar possível desconto. Nenhum valor é descontado aqui.", alert: true }] : []),
    ]} />

    <Field label="Observação" value={notes} onChangeText={setNotes} multiline placeholder="Opcional" />
    {problem ? <Banner>{problem}</Banner> : null}
  </Screen>;
}
