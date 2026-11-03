/**
 * Estoque do local escolhido: saldo, entrada e transferência.
 *
 * Entrada e transferência entram na fila sem rede como a entrega: as duas
 * rotas deduplicam pela chave de idempotência, então reenviar não soma duas
 * vezes.
 */
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import type { EpiProduct } from "@/app/painel/features/epi/epi.types";
import { availableAt, IconButton, ProductPicker, searchProducts } from "../components/Pickers";
import { Select } from "../components/Select";
import {
  ActionBar, Banner, Button, Choices, Chosen, EmptyState, Field, Hint, Row, Screen, SectionTitle, Stat, StatRow, Stepper,
} from "../components/ui";
import { dateLabel, today } from "../lib/format";
import { submitOperation } from "../lib/queue";
import { useUser } from "../lib/session";
import { colors, font, radius, TARGET } from "../lib/theme";
import { useWorkspace } from "../lib/workspace";

type Mode = "list" | "entry" | "transfer";

export default function Stock() {
  const [mode, setMode] = useState<Mode>("list");
  if (mode === "entry") return <Entry onBack={() => setMode("list")} />;
  if (mode === "transfer") return <Transfer onBack={() => setMode("list")} />;
  return <List onMode={setMode} />;
}

function List({ onMode }: { onMode: (mode: Mode) => void }) {
  const ws = useWorkspace();
  const locationId = ws.location?.id ?? "";
  const [term, setTerm] = useState("");
  const [products, setProducts] = useState<EpiProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState("");
  const [scope, setScope] = useState<"all" | "here">("all");

  const load = useCallback(async (query: string) => {
    setLoading(true);
    try { setProducts(await searchProducts(query, 200)); setProblem(""); }
    catch (cause) { setProblem(cause instanceof Error ? cause.message : "Não foi possível carregar o estoque."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(""); }, [load]);

  const list = scope === "here" ? products.filter((item) => availableAt(item, locationId) > 0) : products;
  const now = today();
  const unitsHere = products.reduce((sum, item) => sum + availableAt(item, locationId), 0);
  const zeroHere = products.filter((item) => availableAt(item, locationId) <= 0).length;

  return <Screen refreshing={loading && products.length > 0}>
    <StatRow>
      <Stat label="Unidades" value={unitsHere} />
      <Stat label="EPIs" value={products.length} />
      <Stat label="Zerados" value={zeroHere} tone={zeroHere ? "warning" : undefined} />
    </StatRow>
    <Hint>Saldos de {ws.location?.name ?? "este local"}. Para ver outro local, troque na tela inicial.</Hint>

    <ActionBar>
      <Button label="Entrada" tone="primary" disabled={!ws.permissions.stockAdjust} onPress={() => onMode("entry")}
        icon={<Ionicons name="add-circle-outline" size={20} color={colors.onAccent} />} />
      <Button label="Transferir" style={{ flex: 1 }} disabled={!ws.permissions.stockAdjust} onPress={() => onMode("transfer")}
        icon={<Ionicons name="swap-horizontal" size={20} color={colors.text} />} />
    </ActionBar>
    {!ws.permissions.stockAdjust ? <Hint>Entrada e transferência pedem a permissão epi.stock.adjust. A consulta continua liberada.</Hint> : null}

    <View style={styles.searchRow}>
      <TextInput value={term} onChangeText={setTerm} onSubmitEditing={() => void load(term)} placeholder="Nome, código interno ou CA"
        placeholderTextColor={colors.soft} returnKeyType="search" autoCorrect={false} autoCapitalize="none" style={styles.search}
        accessibilityLabel="Buscar EPI no estoque" />
      <IconButton icon="search" label="Procurar no estoque" onPress={() => void load(term)} disabled={loading} />
    </View>
    <Choices label="Recorte" value={scope} onChange={setScope}
      options={[{ id: "all", label: "Todos os EPIs" }, { id: "here", label: "Só com saldo aqui" }]} />

    {problem ? <Banner>{problem}</Banner> : null}
    {loading && !products.length ? <Hint>Carregando…</Hint> : null}
    {list.map((product) => {
      const here = availableAt(product, locationId);
      const others = product.stockLocations.filter((place) => place.id !== locationId && place.quantity > 0);
      const caExpired = Boolean(product.caExpiresOn) && product.caExpiresOn < now;
      return <Row key={product.id} title={product.name}
        lines={[
          `CA ${product.caNumber || "—"} · ${product.size || "—"}${product.internalCode ? ` · ${product.internalCode}` : ""}`,
          product.caExpiresOn ? `CA ${caExpired ? "vencido em" : "válido até"} ${dateLabel(product.caExpiresOn)}` : "",
          others.length ? `Outros locais: ${others.map((place) => `${place.name} ${place.quantity}`).join(" · ")}` : "",
        ]}
        right={<Text style={[styles.qty, here <= 0 && { color: colors.warning }]}>{here}<Text style={styles.unit}> un.</Text></Text>} />;
    })}
    {!loading && !list.length && !problem ? <EmptyState title="Nenhum EPI neste recorte" /> : null}
  </Screen>;
}

function Entry({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const user = useUser();
  const ws = useWorkspace();
  const locationId = ws.location?.id ?? "";
  const [product, setProduct] = useState<EpiProduct | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  if (!product) return <Screen footer={<ActionBar><Button label="Voltar ao estoque" style={{ flex: 1 }} onPress={onBack} /></ActionBar>}>
    <ProductPicker locationId={locationId} onPick={setProduct} allowEmpty title={`Entrada em ${ws.location?.name ?? "este local"}: qual EPI?`} />
  </Screen>;

  const before = availableAt(product, locationId);

  async function submit() {
    if (!product) return;
    setBusy(true); setProblem("");
    try {
      const result = await submitOperation({
        kind: "stock_entry", owner: user.email, label: `Entrada · ${product.name} · ${quantity} un.`,
        payload: { productId: product.id, stockLocationId: locationId, quantity, movementDate: today(), reason: "stock_replenishment", notes },
      });
      ws.notify(result.status === "queued" ? "Sem rede: entrada guardada no aparelho e será enviada sozinha."
        : `Entrada de ${quantity} un. registrada em ${ws.location?.name ?? "este local"}.`);
      await ws.refreshQueue();
      router.dismissTo("/");
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Não foi possível registrar a entrada.");
    } finally { setBusy(false); }
  }

  return <Screen footer={<ActionBar>
    <Button label="Cancelar" onPress={onBack} disabled={busy} />
    <Button label={busy ? "Gravando…" : "Confirmar entrada"} tone="primary" busy={busy} onPress={() => void submit()} />
  </ActionBar>}>
    <Chosen label="EPI" value={`${product.name} · CA ${product.caNumber || "—"}`} onClear={() => setProduct(null)} />
    <SectionTitle>Quantidade recebida</SectionTitle>
    <Stepper value={quantity} onChange={setQuantity} max={9999} />
    <Field label="Ou digite" value={String(quantity)} keyboardType="number-pad"
      onChangeText={(value) => setQuantity(Math.min(9999, Math.max(1, Math.trunc(Number(value.replace(/\D/gu, "")) || 1))))} />
    <Hint>Hoje há {before} neste local. Depois da entrada: {before + quantity}.</Hint>
    <Field label="Observação" value={notes} onChangeText={setNotes} multiline placeholder="Nota fiscal, fornecedor… (opcional)" />
    {problem ? <Banner>{problem}</Banner> : null}
  </Screen>;
}

function Transfer({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const user = useUser();
  const ws = useWorkspace();
  const locationId = ws.location?.id ?? "";
  const targets = ws.locations.filter((item) => item.id !== locationId);
  const [product, setProduct] = useState<EpiProduct | null>(null);
  const [targetId, setTargetId] = useState(targets[0]?.id ?? "");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  if (!targets.length) return <Screen>
    <EmptyState title="Só existe um local de estoque"
      text="Transferir precisa de um segundo local. Crie no painel, em Controle de EPI › Locais de estoque."
      action={<Button label="Voltar ao estoque" onPress={onBack} />} />
  </Screen>;

  if (!product) return <Screen footer={<ActionBar><Button label="Voltar ao estoque" style={{ flex: 1 }} onPress={onBack} /></ActionBar>}>
    <ProductPicker locationId={locationId} onPick={(picked) => { setProduct(picked); setQuantity(1); }}
      title={`Sai de ${ws.location?.name ?? "este local"}: qual EPI?`} />
  </Screen>;

  const here = availableAt(product, locationId);
  const target = targets.find((item) => item.id === targetId);

  async function submit() {
    if (!product || !targetId) return;
    setBusy(true); setProblem("");
    try {
      const result = await submitOperation({
        kind: "stock_transfer", owner: user.email, label: `Transferência · ${product.name} · ${quantity} un. → ${target?.name ?? ""}`,
        payload: { productId: product.id, sourceStockLocationId: locationId, targetStockLocationId: targetId, quantity, movementDate: today(), notes },
      });
      ws.notify(result.status === "queued" ? "Sem rede: transferência guardada no aparelho e será enviada sozinha."
        : `${quantity} un. transferida(s) para ${target?.name ?? "o destino"}.`);
      await ws.refreshQueue();
      router.dismissTo("/");
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Não foi possível transferir.");
    } finally { setBusy(false); }
  }

  return <Screen footer={<ActionBar>
    <Button label="Cancelar" onPress={onBack} disabled={busy} />
    <Button label={busy ? "Gravando…" : "Transferir"} tone="primary" busy={busy} disabled={here <= 0} onPress={() => void submit()} />
  </ActionBar>}>
    <Chosen label="EPI" value={`${product.name} · CA ${product.caNumber || "—"}`} onClear={() => setProduct(null)} />
    <Select label="Para qual local" value={targetId} onChange={setTargetId}
      options={targets.map((item) => ({ id: item.id, label: item.name, detail: item.code || undefined }))} />
    <SectionTitle>Quantidade</SectionTitle>
    <Stepper value={quantity} onChange={setQuantity} max={here} />
    <Hint>{here} disponível(is) em {ws.location?.name ?? "este local"}.</Hint>
    <Field label="Observação" value={notes} onChangeText={setNotes} multiline placeholder="Opcional" />
    {problem ? <Banner>{problem}</Banner> : null}
  </Screen>;
}

const styles = StyleSheet.create({
  searchRow: { flexDirection: "row", gap: 8 },
  search: { flex: 1, minWidth: 0, minHeight: TARGET, paddingHorizontal: 12, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, color: colors.text, fontSize: 16 },
  qty: { color: colors.text, fontSize: 22, fontWeight: "800", fontVariant: ["tabular-nums"] },
  unit: { color: colors.soft, fontSize: font.caption, fontWeight: "600" },
});
