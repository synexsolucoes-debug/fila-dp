/**
 * Registro de dano, com foto da evidência.
 *
 * A foto abre a câmera traseira direto (sem passar pela galeria) e é copiada
 * para a pasta de documentos do app: se a ocorrência cair na fila sem rede, a
 * evidência precisa sobreviver a fechar o app.
 */
import Ionicons from "@expo/vector-icons/Ionicons";
import { File, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import {
  damageRouting, epiDamageDecisionLabels, epiDamageDecisions, epiDamageReasonLabels, epiDamageReasons,
  type EpiDamageDecision, type EpiDamageReason,
} from "@/lib/epi";
import type { EmployeeOption, EpiDelivery } from "@/app/painel/features/epi/epi.types";
import { ActiveDeliveries, useDossier } from "../components/ActiveDeliveries";
import { EmployeePicker } from "../components/Pickers";
import { ActionBar, Banner, Button, Choices, Chosen, Consequence, Field, Hint, Screen, SectionTitle } from "../components/ui";
import { today } from "../lib/format";
import { outcome } from "../lib/outcome";
import { submitOperation } from "../lib/queue";
import { useUser } from "../lib/session";
import { colors, font, radius } from "../lib/theme";
import { useWorkspace } from "../lib/workspace";

export default function Damage() {
  const router = useRouter();
  const user = useUser();
  const ws = useWorkspace();
  const [employee, setEmployee] = useState<EmployeeOption | null>(null);
  const [delivery, setDelivery] = useState<EpiDelivery | null>(null);
  const [reason, setReason] = useState<EpiDamageReason>("natural_wear");
  const [decision, setDecision] = useState<EpiDamageDecision>("exchange_without_discount");
  const [description, setDescription] = useState("");
  const [photo, setPhoto] = useState<{ uri: string; filename: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const { dossier, loading, problem: loadProblem } = useDossier(employee?.id ?? null);
  const routing = useMemo(() => damageRouting(decision), [decision]);

  if (!employee) return <Screen>
    <EmployeePicker companyId={ws.company?.id ?? ""} title="De quem é o EPI danificado?" onPick={setEmployee} />
  </Screen>;

  if (!delivery) return <Screen>
    <Chosen label="Colaborador" value={employee.name} onClear={() => setEmployee(null)} />
    <ActiveDeliveries title="Qual EPI foi danificado?" items={dossier?.activeDeliveries ?? []} loading={loading}
      problem={loadProblem} empty="Este colaborador não tem EPI em poder para registrar dano." onPick={setDelivery} />
  </Screen>;

  async function takePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) { setProblem("Sem permissão de câmera. Libere em Ajustes › Expo Go › Câmera."); return; }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.6 });
    if (result.canceled || !result.assets[0]) return;
    const filename = `dano-${Date.now()}.jpg`;
    const target = new File(Paths.document, filename);
    await new File(result.assets[0].uri).copy(target);
    if (photo) { try { new File(photo.uri).delete(); } catch { /* já apagada */ } }
    setPhoto({ uri: target.uri, filename });
    setProblem("");
  }

  async function submit() {
    if (!employee || !delivery) return;
    if (!description.trim()) { setProblem("Descreva o que aconteceu — é a evidência escrita da ocorrência."); return; }
    setBusy(true); setProblem("");
    try {
      const result = await submitOperation({
        kind: "damage",
        label: `Dano · ${delivery.epiName} · ${employee.name}`,
        owner: user.email,
        payload: {
          // O local vai explícito: sem ele as consequências (descarte,
          // higienização, reposição) lançariam no local padrão do grupo.
          companyId: ws.company?.id ?? "", employeeId: employee.id, productId: delivery.productId, deliveryId: delivery.id,
          stockLocationId: ws.location?.id ?? "", occurredOn: today(), quantity: 1, damageReason: reason, decision, description,
        },
        attachment: photo ? { uri: photo.uri, filename: photo.filename, mimeType: "image/jpeg", kind: "photo" } : null,
      });
      ws.notify(outcome(result, {
        sent: "Dano registrado com a decisão tomada.",
        queued: "Sem rede: ocorrência guardada no aparelho e será enviada sozinha.",
        partial: "Dano registrado. A foto ainda não subiu e vai sozinha — não precisa fotografar de novo.",
      }));
      await ws.refreshQueue();
      router.dismissTo("/");
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Não foi possível registrar o dano.");
    } finally { setBusy(false); }
  }

  const effects = [
    ...(routing.settleOldDelivery ? [{ text: "Baixa do equipamento na entrega do colaborador." }] : []),
    ...(routing.createDisposal ? [{ text: "Abre registro na fila de descarte.", alert: true }] : []),
    ...(routing.productStatus === "sanitizing" ? [{ text: "O EPI passa para higienização." }] : []),
    ...(routing.discountTrigger ? [{ text: "Abre demanda para o DP analisar possível desconto. Nenhum valor é descontado aqui.", alert: true }] : []),
  ];

  return <Screen footer={<ActionBar>
    <Button label="Cancelar" onPress={() => router.back()} disabled={busy} />
    <Button label={busy ? "Gravando…" : "Registrar dano"} tone="primary" busy={busy} onPress={() => void submit()} />
  </ActionBar>}>
    <Chosen label="Colaborador" value={employee.name} onClear={() => { setEmployee(null); setDelivery(null); }} />
    <Chosen label="EPI" value={delivery.epiName} onClear={() => setDelivery(null)} />

    <SectionTitle>Foto da evidência</SectionTitle>
    <Pressable onPress={() => void takePhoto()} accessibilityRole="button" accessibilityLabel={photo ? "Tirar outra foto" : "Tirar foto do equipamento"}
      style={({ pressed }) => [styles.photo, pressed && { opacity: 0.85 }]}>
      {photo
        ? <Image source={{ uri: photo.uri }} style={styles.preview} />
        : <Ionicons name="camera-outline" size={28} color={colors.accentText} />}
      <Text style={styles.photoText}>{photo ? "Foto anexada · tocar para refazer" : "Tirar foto do equipamento"}</Text>
    </Pressable>

    <SectionTitle>Motivo</SectionTitle>
    <Choices label="Motivo da danificação" value={reason} onChange={setReason}
      options={epiDamageReasons.map((id) => ({ id, label: epiDamageReasonLabels[id] }))} />

    <Field label="O que aconteceu" value={description} onChangeText={setDescription} multiline placeholder="Quando, como e em que circunstância." />

    <SectionTitle>Decisão</SectionTitle>
    <Choices label="Decisão da análise" value={decision} onChange={setDecision}
      options={epiDamageDecisions.map((id) => ({ id, label: epiDamageDecisionLabels[id] }))} />

    <Consequence title="O que esta decisão provoca" items={effects.length ? effects : [{ text: "Somente o registro da ocorrência, com a evidência." }]} />
    {routing.deliverReplacement ? <Hint>A entrega do substituto é feita depois, por uma nova entrega.</Hint> : null}
    {problem ? <Banner>{problem}</Banner> : null}
    <View style={{ height: 4 }} />
  </Screen>;
}

const styles = StyleSheet.create({
  photo: { minHeight: 72, padding: 12, borderRadius: radius.md, borderWidth: 2, borderStyle: "dashed", borderColor: colors.border, backgroundColor: colors.surface, flexDirection: "row", alignItems: "center", gap: 12 },
  preview: { width: 64, height: 64, borderRadius: 8 },
  photoText: { color: colors.text, fontSize: font.body, flexShrink: 1 },
});
