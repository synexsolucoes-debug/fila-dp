/**
 * Vencimentos e trocas.
 *
 * A lista vem na ordem de gravidade do mapa de conformidade do painel — sem o
 * EPI, vencido, troca atrasada, troca próxima — calculada por `dueEntries`, a
 * mesma função do app web. Os quadros do topo são o filtro. Tocar numa
 * pendência abre a entrega já com colaborador, EPI e motivo certo no termo.
 */
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { TextInput, View, StyleSheet } from "react-native";
import type { EpiEmployeeCompliance } from "@/lib/epi-compliance";
import {
  countByStatus, dueDateLabel, dueDeliveryReason, dueEntries, dueStatusLabels, matchesTerm,
  type ActionableStatus, type DueEntry,
} from "@/app/campo/sesmt.logic";
import { IconButton } from "../components/Pickers";
import { Banner, Button, Consequence, EmptyState, Hint, Loading, Pill, Row, Screen, Stat, StatRow } from "../components/ui";
import { api } from "../lib/api";
import { today } from "../lib/format";
import { colors, radius, TARGET } from "../lib/theme";
import { useWorkspace } from "../lib/workspace";

type Payload = {
  employees?: EpiEmployeeCompliance[];
  shortages?: Array<{ productId: string; productName: string; missing: number; available: number; shortage: number }>;
  summary?: { unconfiguredEmployees?: number };
};
type Filter = "all" | "missing" | "expired" | "exchange";

/** Troca atrasada e troca próxima são um quadro só: as duas pedem a mesma ação, trocar. */
const filters: Array<{ id: Exclude<Filter, "all">; label: string; tone: "danger" | "warning"; statuses: ActionableStatus[] }> = [
  { id: "missing", label: "Sem EPI", tone: "danger", statuses: ["missing"] },
  { id: "expired", label: "Vencidos", tone: "danger", statuses: ["expired"] },
  { id: "exchange", label: "Trocas", tone: "warning", statuses: ["overdue", "due_soon"] },
];
const tone: Record<ActionableStatus, "danger" | "warning" | "info"> = { missing: "danger", expired: "danger", overdue: "warning", due_soon: "info" };
const PAGE = 50;

export default function Due() {
  const router = useRouter();
  const ws = useWorkspace();
  const companyId = ws.company?.id ?? "";
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [term, setTerm] = useState("");
  const [shown, setShown] = useState(PAGE);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<Payload>(`/api/epi/dashboard?companyId=${encodeURIComponent(companyId)}`));
      setProblem("");
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Não foi possível carregar os vencimentos.");
    } finally { setLoading(false); }
  }, [companyId]);
  useEffect(() => { void load(); }, [load]);

  const entries = useMemo(() => dueEntries(data?.employees ?? []), [data]);
  const counts = useMemo(() => countByStatus(entries), [entries]);
  const visible = useMemo(() => entries.filter((entry) =>
    (filter === "all" || (filters.find((item) => item.id === filter)?.statuses.includes(entry.status) ?? false))
    && matchesTerm(entry, term)), [entries, filter, term]);
  const now = today();

  const deliver = (entry: DueEntry) => router.push({
    pathname: "/entrega",
    params: {
      employeeId: entry.employeeId, employeeName: entry.employeeName, registration: entry.registrationNumber,
      position: entry.positionName, department: entry.departmentName,
      productId: entry.productId, productName: entry.productName, reason: dueDeliveryReason[entry.status],
    },
  });

  if (loading && !data) return <Loading text="Calculando vencimentos…" />;

  return <Screen refreshing={loading && Boolean(data)}>
    {problem ? <Banner>{problem}</Banner> : null}

    <StatRow>
      {filters.map((item) => <Stat key={item.id} label={item.label} tone={item.tone} active={filter === item.id}
        value={item.statuses.reduce((sum, status) => sum + counts[status], 0)}
        onPress={() => { setFilter((current) => current === item.id ? "all" : item.id); setShown(PAGE); }} />)}
    </StatRow>

    {(data?.shortages?.length ?? 0) > 0 && <Consequence tone="warning" title="Estoque não cobre as pendências"
      items={(data?.shortages ?? []).slice(0, 5).map((item) => ({
        text: `${item.productName}: faltam ${item.shortage} (precisa de ${item.missing}, há ${item.available})`, alert: true,
      }))} />}

    {filter !== "all" && <View style={styles.filterRow}>
      <Hint>Mostrando só {filters.find((item) => item.id === filter)?.label.toLowerCase()} · {visible.length}</Hint>
      <Button label="Ver todas" tone="ghost" onPress={() => setFilter("all")} />
    </View>}

    <View style={styles.searchRow}>
      <TextInput value={term} onChangeText={(value) => { setTerm(value); setShown(PAGE); }} placeholder="Filtrar por nome, matrícula ou EPI"
        placeholderTextColor={colors.soft} autoCorrect={false} style={styles.search} accessibilityLabel="Filtrar pendências" />
      <IconButton icon="refresh" label="Atualizar" onPress={() => void load()} disabled={loading} />
    </View>

    {!entries.length && !problem && <EmptyState title="Nenhuma pendência nesta empresa"
      text={data?.summary?.unconfiguredEmployees
        ? `${data.summary.unconfiguredEmployees} colaborador(es) ainda não têm EPI obrigatório definido para o cargo. As regras são cadastradas no painel.`
        : "Todos os colaboradores ativos estão com o EPI obrigatório em dia."} />}
    {entries.length > 0 && !visible.length ? <Hint>Nada com esse filtro.</Hint> : null}

    {visible.slice(0, shown).map((entry) => <Row key={entry.key} title={entry.employeeName}
      lines={[`${entry.productName}${entry.caNumber ? ` · CA ${entry.caNumber}` : ""}`,
        `${entry.registrationNumber}${entry.positionName ? ` · ${entry.positionName}` : ""}`]}
      below={<Pill tone={tone[entry.status]} label={entry.status === "missing" ? dueStatusLabels.missing : dueDateLabel(entry, now)} />}
      left={<Ionicons name="calendar-outline" size={22} color={colors.soft} />}
      onPress={ws.permissions.deliver ? () => deliver(entry) : undefined}
      accessibilityLabel={`${entry.employeeName}, ${entry.productName}: ${dueStatusLabels[entry.status]}. Abrir entrega`} />)}

    {visible.length > shown && <Button label={`Mostrar mais ${Math.min(PAGE, visible.length - shown)} de ${visible.length - shown}`}
      onPress={() => setShown((value) => value + PAGE)} />}

    {ws.permissions.deliver && entries.length > 0
      ? <Hint>Toque numa pendência para abrir a entrega já com o colaborador, o EPI e o motivo certo.</Hint> : null}
  </Screen>;
}

const styles = StyleSheet.create({
  filterRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  searchRow: { flexDirection: "row", gap: 8 },
  search: { flex: 1, minWidth: 0, minHeight: TARGET, paddingHorizontal: 12, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, color: colors.text, fontSize: 16 },
});
