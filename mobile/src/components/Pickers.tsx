/**
 * Busca de colaborador e de EPI, compartilhada pelos fluxos.
 *
 * Os normalizadores vêm do painel (`app/painel/features/epi/epi.api.ts`), o
 * mesmo arquivo que o app web usa: as três telas leem as mesmas rotas, e uma
 * segunda cópia do mapeamento divergiria na primeira mudança de coluna.
 */
import Ionicons from "@expo/vector-icons/Ionicons";
import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { normalizeEmployeeOption, normalizeProduct, type Row } from "@/app/painel/features/epi/epi.api";
import type { EmployeeOption, EpiProduct } from "@/app/painel/features/epi/epi.types";
import { api } from "../lib/api";
import { colors, radius, TARGET } from "../lib/theme";
import { CodeScanner } from "./CodeScanner";
import { Hint, Row as ListRow, SectionTitle } from "./ui";

function SearchBar({ value, onChange, onSubmit, placeholder, scanLabel, onScan, busy }: {
  value: string; onChange: (value: string) => void; onSubmit: () => void; placeholder: string;
  scanLabel: string; onScan: () => void; busy?: boolean;
}) {
  return <View style={styles.searchRow}>
    <TextInput value={value} onChangeText={onChange} onSubmitEditing={onSubmit} placeholder={placeholder}
      placeholderTextColor={colors.soft} returnKeyType="search" autoCorrect={false} autoCapitalize="none"
      style={styles.searchInput} accessibilityLabel={placeholder} />
    <IconButton icon="search" label="Procurar" onPress={onSubmit} disabled={busy} />
    <IconButton icon="scan" label={scanLabel} onPress={onScan} />
  </View>;
}

export function IconButton({ icon, label, onPress, disabled }: {
  icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; disabled?: boolean;
}) {
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}
    style={({ pressed }) => [styles.iconButton, disabled && { opacity: 0.45 }, pressed && { transform: [{ scale: 0.95 }] }]}>
    <Ionicons name={icon} size={22} color={colors.text} />
  </Pressable>;
}

export function EmployeePicker({ companyId, onPick, title = "Quem vai receber?" }: {
  companyId: string; onPick: (employee: EmployeeOption) => void; title?: string;
}) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<EmployeeOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [problem, setProblem] = useState("");

  const search = useCallback(async (value: string) => {
    const query = value.trim();
    if (!query) { setResults([]); setProblem("Digite parte do nome ou a matrícula."); return; }
    setBusy(true);
    try {
      const params = new URLSearchParams({ companyId, status: "active", limit: "25", search: query });
      const payload = await api<{ employees?: Row[] }>(`/api/employees?${params}`);
      const list = (payload.employees ?? []).map(normalizeEmployeeOption);
      setResults(list);
      setProblem(list.length ? "" : "Nenhum colaborador com esse nome ou matrícula.");
      // Leitura de crachá que acha um só: segue direto, que é o ganho do leitor.
      if (list.length === 1) onPick(list[0]);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Erro ao buscar colaborador.");
    } finally { setBusy(false); }
  }, [companyId, onPick]);

  return <View style={styles.block}>
    <SectionTitle>{title}</SectionTitle>
    <SearchBar value={term} onChange={setTerm} onSubmit={() => void search(term)} placeholder="Nome ou matrícula"
      scanLabel="Ler crachá" onScan={() => setScanning(true)} busy={busy} />
    {busy ? <Hint>Procurando…</Hint> : problem ? <Hint>{problem}</Hint> : null}
    {results.map((employee) => <ListRow key={employee.id} title={employee.name}
      lines={[`${employee.registrationNumber} · ${employee.positionName || "Sem cargo"}`]}
      left={<Ionicons name="person-outline" size={22} color={colors.soft} />}
      onPress={() => onPick(employee)} accessibilityLabel={`Escolher ${employee.name}`} />)}
    <CodeScanner visible={scanning} label="Ler crachá do colaborador" onClose={() => setScanning(false)}
      onCode={(code) => { setScanning(false); setTerm(code); void search(code); }} />
  </View>;
}

/**
 * Saldo do EPI **no local escolhido**.
 *
 * `stockQuantity` soma todos os locais, e a entrega debita um só. Mostrar o
 * total faria a tela oferecer doze unidades onde há zero — a recusa chegaria
 * depois, longe do colaborador que já assinou.
 */
export const availableAt = (product: EpiProduct, locationId: string) =>
  product.stockLocations.find((place) => place.id === locationId)?.quantity ?? 0;

export async function searchProducts(query: string, limit = 25) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (query.trim()) params.set("search", query.trim());
  const payload = await api<{ products?: Row[] }>(`/api/epi/products?${params}`);
  return (payload.products ?? []).map(normalizeProduct)
    .filter((item) => !["discarded", "lost", "inactive"].includes(item.status));
}

export function ProductPicker({ locationId, onPick, title = "Qual EPI?", allowEmpty = false, initialTerm = "", preferId = "" }: {
  locationId: string; onPick: (product: EpiProduct) => void; title?: string;
  /** Entrada de estoque escolhe justamente o EPI zerado; entrega e transferência não podem. */
  allowEmpty?: boolean;
  /** Busca já preenchida — a entrega aberta da lista de vencimentos chega sabendo o EPI. */
  initialTerm?: string;
  preferId?: string;
}) {
  const [term, setTerm] = useState(initialTerm);
  const [results, setResults] = useState<EpiProduct[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [problem, setProblem] = useState("");
  const usable = useCallback((product: EpiProduct) => allowEmpty || availableAt(product, locationId) > 0, [allowEmpty, locationId]);

  const search = useCallback(async (value: string, auto: boolean) => {
    setBusy(true);
    try {
      const list = await searchProducts(value);
      setResults(list);
      setProblem(list.length ? "" : "Nenhum EPI com esse nome, código interno ou CA.");
      const preferred = auto && preferId ? list.find((item) => item.id === preferId) : undefined;
      if (preferred && usable(preferred)) onPick(preferred);
      else if (value.trim() && list.length === 1 && usable(list[0])) onPick(list[0]);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Erro ao buscar EPI.");
    } finally { setBusy(false); }
  }, [onPick, preferId, usable]);

  // Uma vez, na abertura: `initialTerm` é valor inicial, não estado controlado.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void search(initialTerm, true); }, []);

  return <View style={styles.block}>
    <SectionTitle>{title}</SectionTitle>
    <SearchBar value={term} onChange={setTerm} onSubmit={() => void search(term, false)} placeholder="Nome, código interno ou CA"
      scanLabel="Ler código do EPI" onScan={() => setScanning(true)} busy={busy} />
    {busy ? <Hint>Procurando…</Hint> : problem ? <Hint>{problem}</Hint> : null}
    {results.map((product) => {
      const here = availableAt(product, locationId);
      return <ListRow key={product.id} title={product.name} disabled={!usable(product)}
        lines={[`CA ${product.caNumber || "—"} · ${product.size || "—"}`,
          here > 0 ? `${here} neste local` : `Sem saldo aqui${product.stockQuantity > 0 ? ` (${product.stockQuantity} em outros locais)` : ""}`]}
        left={<Ionicons name="shield-checkmark-outline" size={22} color={colors.soft} />}
        onPress={() => onPick(product)} accessibilityLabel={`Escolher ${product.name}`} />;
    })}
    <CodeScanner visible={scanning} label="Ler código do EPI" onClose={() => setScanning(false)}
      onCode={(code) => { setScanning(false); setTerm(code); void search(code, false); }} />
  </View>;
}

const styles = StyleSheet.create({
  block: { gap: 10 },
  searchRow: { flexDirection: "row", gap: 8 },
  searchInput: {
    flex: 1, minWidth: 0, minHeight: TARGET, paddingHorizontal: 12, borderRadius: radius.sm, borderWidth: 1,
    borderColor: colors.border, backgroundColor: colors.surface, color: colors.text, fontSize: 16,
  },
  iconButton: {
    width: TARGET, height: TARGET, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface, alignItems: "center", justifyContent: "center",
  },
});
