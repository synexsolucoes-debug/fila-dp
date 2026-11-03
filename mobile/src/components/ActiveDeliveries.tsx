/**
 * EPIs em poder do colaborador — o primeiro passo de devolução e de dano.
 */
import Ionicons from "@expo/vector-icons/Ionicons";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { normalizeDossier, type Row } from "@/app/painel/features/epi/epi.api";
import type { EmployeeEpiDossier, EpiDelivery } from "@/app/painel/features/epi/epi.types";
import { api } from "../lib/api";
import { dateLabel } from "../lib/format";
import { colors } from "../lib/theme";
import { Hint, Row as ListRow, SectionTitle } from "./ui";

export function useDossier(employeeId: string | null) {
  const [dossier, setDossier] = useState<EmployeeEpiDossier | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    if (!employeeId) { setDossier(null); return; }
    let alive = true;
    setLoading(true); setProblem("");
    api<Row>(`/api/epi/employees/${encodeURIComponent(employeeId)}`)
      .then((payload) => { if (alive) setDossier(normalizeDossier(payload)); })
      .catch((cause) => { if (alive) setProblem(cause instanceof Error ? cause.message : "Erro ao carregar os EPIs do colaborador."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [employeeId]);
  return { dossier, loading, problem };
}

export function ActiveDeliveries({ title, items, loading, problem, empty, onPick }: {
  title: string; items: EpiDelivery[]; loading: boolean; problem: string; empty: string; onPick: (item: EpiDelivery) => void;
}) {
  return <View style={{ gap: 10 }}>
    <SectionTitle>{title}</SectionTitle>
    {loading ? <Hint>Carregando…</Hint> : problem ? <Hint tone="danger">{problem}</Hint> : !items.length ? <Hint>{empty}</Hint> : null}
    {items.map((item) => <ListRow key={item.id} title={item.epiName}
      lines={[`CA ${item.caNumber || "—"} · ${item.size || "—"}`, `${item.outstanding} em poder · entregue ${dateLabel(item.deliveredOn)}`]}
      left={<Ionicons name="shield-checkmark-outline" size={22} color={colors.soft} />}
      onPress={() => onPick(item)} accessibilityLabel={`Escolher ${item.epiName}`} />)}
  </View>;
}
