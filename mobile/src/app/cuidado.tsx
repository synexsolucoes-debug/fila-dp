/**
 * Higienização e descarte.
 *
 * As decisões aqui **exigem rede**, de propósito: são decisões sobre um
 * registro que já existe no servidor, e o servidor recusa a segunda decisão.
 * Enfileirada, uma conclusão feita sem sinal poderia chegar depois de alguém
 * decidir o contrário no painel, e a tela teria dito "feito" para algo que não
 * valeu. Confirmar descarte é definitivo e pede confirmação.
 */
import Ionicons from "@expo/vector-icons/Ionicons";
import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { epiDisposalReasonLabels, type EpiDisposalReason } from "@/lib/epi";
import {
  awaitingDisposals, disposalStockEffect, pendingSanitization, type DisposalItem, type SanitizationItem,
} from "@/app/campo/sesmt.logic";
import type { Row as DataRow } from "@/app/painel/features/epi/epi.api";
import { IconButton } from "../components/Pickers";
import { ActionBar, Banner, Button, Chosen, Consequence, EmptyState, Field, Hint, Pill, Row, Screen } from "../components/ui";
import { api, NetworkError } from "../lib/api";
import { dateLabel } from "../lib/format";
import { colors, font, radius } from "../lib/theme";
import { useWorkspace } from "../lib/workspace";

const originLabels: Record<DisposalItem["origin"], string> = {
  manual: "Aberto a partir do estoque",
  return: "Veio de devolução",
  damage: "Veio de registro de dano",
};
const reasonLabel = (reason: string) => epiDisposalReasonLabels[reason as EpiDisposalReason] ?? reason;
const message = (cause: unknown, fallback: string) => cause instanceof NetworkError
  ? "Sem conexão. Higienização e descarte precisam de rede — tente de novo quando tiver sinal."
  : cause instanceof Error ? cause.message : fallback;

export default function Care() {
  const ws = useWorkspace();
  const companyId = ws.company?.id ?? "";
  const canSanitize = ws.permissions.receiveReturn;
  const canDispose = ws.permissions.dispose;
  const [tab, setTab] = useState<"sanitize" | "dispose">(canSanitize || !canDispose ? "sanitize" : "dispose");
  const [sanitizing, setSanitizing] = useState<SanitizationItem[]>([]);
  const [disposals, setDisposals] = useState<DisposalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState("");
  const [selected, setSelected] = useState<{ kind: "sanitize"; item: SanitizationItem } | { kind: "dispose"; item: DisposalItem } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [returns, disposalPayload] = await Promise.all([
        api<{ returns?: DataRow[] }>(`/api/epi/returns?${new URLSearchParams({ companyId, sanitizing: "true", limit: "200" })}`),
        api<{ disposals?: DataRow[] }>(`/api/epi/disposals?${new URLSearchParams({ companyId, status: "awaiting_disposal", limit: "200" })}`),
      ]);
      setSanitizing(pendingSanitization(returns.returns ?? []));
      setDisposals(awaitingDisposals(disposalPayload.disposals ?? []));
      setProblem("");
    } catch (cause) {
      setProblem(message(cause, "Não foi possível carregar higienização e descarte."));
    } finally { setLoading(false); }
  }, [companyId]);
  useEffect(() => { void load(); }, [load]);

  const finished = async (text: string) => {
    setSelected(null);
    ws.notify(text);
    void ws.refreshSummary();
    await load();
  };

  if (selected?.kind === "sanitize") return <Sanitization item={selected.item} allowed={canSanitize} onDone={finished} onCancel={() => setSelected(null)} />;
  if (selected?.kind === "dispose") return <Disposal item={selected.item} allowed={canDispose} onDone={finished} onCancel={() => setSelected(null)} />;

  return <Screen refreshing={loading && (sanitizing.length + disposals.length > 0)}>
    <View style={styles.tabBar}>
      <View style={styles.segmented} accessibilityRole="tablist">
        {([["sanitize", "Higienizar", sanitizing.length], ["dispose", "Descartar", disposals.length]] as const).map(([id, label, count]) =>
          <Pressable key={id} onPress={() => setTab(id)} accessibilityRole="tab" accessibilityState={{ selected: tab === id }}
            style={[styles.segment, tab === id && styles.segmentActive]}>
            <Text style={[styles.segmentText, tab === id && { color: colors.accentText }]}>{label}</Text>
            <View style={styles.count}><Text style={styles.countText}>{count}</Text></View>
          </Pressable>)}
      </View>
      <IconButton icon="refresh" label="Atualizar" onPress={() => void load()} disabled={loading} />
    </View>

    {problem ? <Banner>{problem}</Banner> : null}
    {loading && !(sanitizing.length + disposals.length) ? <Hint>Carregando…</Hint> : null}

    {tab === "sanitize" && <>
      {!loading && !sanitizing.length ? <EmptyState title="Nada aguardando higienização" text="Devoluções marcadas como “pendente de higienização” aparecem aqui." /> : null}
      {sanitizing.map((item) => <Row key={item.id} title={item.epiName}
        lines={[`${item.quantity} un. · devolvido por ${item.employeeName || "—"}`, dateLabel(item.returnedOn)]}
        below={<Pill tone={item.status === "in_progress" ? "info" : "warning"} label={item.status === "in_progress" ? "Em andamento" : "Aguardando"} />}
        left={<Ionicons name="sparkles-outline" size={22} color={colors.soft} />}
        onPress={() => setSelected({ kind: "sanitize", item })} accessibilityLabel={`Tratar ${item.epiName}`} />)}
    </>}

    {tab === "dispose" && <>
      {!loading && !disposals.length ? <EmptyState title="Nada aguardando descarte" text="Devoluções inutilizadas e danos com decisão de descarte caem aqui para confirmação." /> : null}
      {disposals.map((item) => <Row key={item.id} title={item.epiName}
        lines={[`${item.quantity} un. · ${reasonLabel(item.reason)}`, `${item.employeeName ? `${item.employeeName} · ` : ""}${dateLabel(item.disposalDate)}`]}
        left={<Ionicons name="trash-outline" size={22} color={colors.soft} />}
        onPress={() => setSelected({ kind: "dispose", item })} accessibilityLabel={`Decidir descarte de ${item.epiName}`} />)}
    </>}
  </Screen>;
}

function Sanitization({ item, allowed, onDone, onCancel }: {
  item: SanitizationItem; allowed: boolean; onDone: (text: string) => Promise<void>; onCancel: () => void;
}) {
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function send(action: "start" | "complete" | "reject") {
    setBusy(true); setProblem("");
    try {
      await api(`/api/epi/returns/${encodeURIComponent(item.id)}/sanitization`, { method: "POST", body: JSON.stringify({ action, result }) });
      await onDone(action === "start" ? "Higienização iniciada."
        : action === "complete" ? `Higienizado: ${item.quantity} un. voltaram ao estoque.` : "Higienização reprovada. O EPI não voltou ao estoque.");
    } catch (cause) { setProblem(message(cause, "Não foi possível registrar a higienização.")); }
    finally { setBusy(false); }
  }

  function act(action: "start" | "complete" | "reject") {
    if (action !== "start" && !result.trim()) { setProblem("Escreva o resultado — é o registro do que foi feito com o equipamento."); return; }
    if (action === "reject") {
      Alert.alert("Reprovar a higienização?", "O EPI não volta ao estoque.", [
        { text: "Voltar", style: "cancel" }, { text: "Reprovar", style: "destructive", onPress: () => void send("reject") },
      ]);
      return;
    }
    void send(action);
  }

  return <Screen footer={<ActionBar stacked>
    <View style={styles.secondaryRow}>
      {item.status === "awaiting" ? <Button label="Iniciar" style={{ flex: 1 }} onPress={() => act("start")} disabled={busy || !allowed} /> : null}
      <Button label="Reprovar" tone="danger" style={{ flex: 1 }} onPress={() => act("reject")} disabled={busy || !allowed} />
    </View>
    <Button label={busy ? "Gravando…" : "Concluir higienização"} tone="primary" busy={busy} disabled={!allowed} onPress={() => act("complete")} />
  </ActionBar>}>
    <Chosen label="EPI devolvido" value={`${item.epiName} · ${item.quantity} un.`} onClear={onCancel} />
    <Row title={item.employeeName || "—"} lines={[`Devolvido em ${dateLabel(item.returnedOn)}`, item.status === "in_progress" ? "Em andamento" : "Aguardando"]} />
    <Field label="Resultado" value={result} onChangeText={setResult} multiline
      placeholder="Ex.: lavado e inspecionado, sem avaria. Obrigatório para concluir ou reprovar." />
    <Consequence title="O que cada decisão faz" items={[
      { text: `Concluir: ${item.quantity} un. voltam ao estoque do local da devolução.` },
      { text: "Reprovar: não volta ao estoque. Se for para descartar, abra o descarte no painel.", alert: true },
    ]} />
    {!allowed ? <Hint>Sem a permissão epi.return para tratar higienização.</Hint> : null}
    {problem ? <Banner>{problem}</Banner> : null}
  </Screen>;
}

function Disposal({ item, allowed, onDone, onCancel }: {
  item: DisposalItem; allowed: boolean; onDone: (text: string) => Promise<void>; onCancel: () => void;
}) {
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function send(action: "confirm" | "cancel" | "reevaluate") {
    setBusy(true); setProblem("");
    try {
      await api(`/api/epi/disposals/${encodeURIComponent(item.id)}`, { method: "POST", body: JSON.stringify({ action, notes }) });
      await onDone(action === "confirm" ? "Descarte confirmado." : action === "cancel" ? "Descarte cancelado." : "Descarte enviado para reavaliação.");
    } catch (cause) { setProblem(message(cause, "Não foi possível registrar a decisão.")); }
    finally { setBusy(false); }
  }

  function act(action: "confirm" | "cancel" | "reevaluate") {
    if (action !== "confirm" && !notes.trim()) { setProblem("Escreva o motivo — cancelar ou reavaliar sem motivo deixa o histórico sem explicação."); return; }
    if (action === "confirm") {
      // Definitivo: o banco recusa qualquer alteração depois.
      Alert.alert("Confirmar o descarte?", `${item.quantity} un. de ${item.epiName}. Não dá para desfazer.`, [
        { text: "Voltar", style: "cancel" }, { text: "Confirmar descarte", style: "destructive", onPress: () => void send("confirm") },
      ]);
      return;
    }
    void send(action);
  }

  return <Screen footer={<ActionBar stacked>
    <View style={styles.secondaryRow}>
      <Button label="Reavaliar" style={{ flex: 1 }} onPress={() => act("reevaluate")} disabled={busy || !allowed} />
      <Button label="Cancelar" style={{ flex: 1 }} onPress={() => act("cancel")} disabled={busy || !allowed} />
    </View>
    <Button label={busy ? "Gravando…" : "Confirmar descarte"} tone="primary" busy={busy} disabled={!allowed} onPress={() => act("confirm")}
      icon={<Ionicons name="trash-outline" size={20} color={colors.onAccent} />} />
  </ActionBar>}>
    <Chosen label="Descarte" value={`${item.epiName} · ${item.quantity} un.`} onClear={onCancel} />
    <Row title={reasonLabel(item.reason)} lines={[originLabels[item.origin], item.employeeName, item.caNumber ? `CA ${item.caNumber}` : ""]} />
    <Consequence title="Ao confirmar" items={[
      { text: "É definitivo: o EPI não volta ao estoque e o registro não pode ser alterado.", alert: true },
      { text: disposalStockEffect(item.origin, item.quantity) },
    ]} />
    <Field label="Observação / motivo" value={notes} onChangeText={setNotes} multiline placeholder="Opcional para confirmar; obrigatório para cancelar ou reavaliar." />
    {!allowed ? <Hint>Sem a permissão epi.dispose para decidir descarte.</Hint> : null}
    {problem ? <Banner>{problem}</Banner> : null}
  </Screen>;
}

const styles = StyleSheet.create({
  tabBar: { flexDirection: "row", gap: 8 },
  segmented: { flex: 1, flexDirection: "row", gap: 4, padding: 4, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  segment: { flex: 1, minHeight: 40, borderRadius: 10, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  segmentActive: { backgroundColor: colors.accentSoft },
  segmentText: { color: colors.soft, fontSize: font.body, fontWeight: "700" },
  count: { minWidth: 22, paddingHorizontal: 6, borderRadius: 11, backgroundColor: colors.muted, alignItems: "center" },
  countText: { color: colors.text, fontSize: 12, fontWeight: "800" },
  secondaryRow: { flexDirection: "row", gap: 9 },
});
