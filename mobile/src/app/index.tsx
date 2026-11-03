/**
 * Tela inicial: empresa, local de estoque e as ações.
 *
 * Duas seções. "Operação" é o almoxarifado diante do colaborador (entregar,
 * receber, dano, consultar). "SESMT" é o técnico andando pela unidade
 * (vencimentos, estoque, higienização e descarte), com os contadores que fazem
 * a pessoa entrar.
 */
import Ionicons from "@expo/vector-icons/Ionicons";
import { useFocusEffect, useRouter, Stack } from "expo-router";
import { useCallback } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Select } from "../components/Select";
import { Banner, Button, EmptyState, Loading, Screen, SectionTitle } from "../components/ui";
import { useSession, useUser } from "../lib/session";
import { colors, font, radius } from "../lib/theme";
import { useWorkspace } from "../lib/workspace";

type Href = "/entrega" | "/devolucao" | "/dano" | "/consulta" | "/vencimentos" | "/estoque" | "/cuidado";
type Action = { href: Href; label: string; hint: string; icon: keyof typeof Ionicons.glyphMap; allowed: boolean; badge?: number };

export default function Home() {
  const router = useRouter();
  const user = useUser();
  const { signOut } = useSession();
  const ws = useWorkspace();
  const { refreshSummary, refreshQueue } = ws;

  // Volta para a tela inicial = números e fila atualizados.
  useFocusEffect(useCallback(() => { void refreshSummary(); void refreshQueue(); }, [refreshSummary, refreshQueue]));

  /**
   * Saída do turno. O aparelho é compartilhado: o que ainda está na fila
   * subiria no nome de quem entrar depois — e quem registrou é o que o termo
   * precisa carregar. Por isso o aviso antes.
   */
  const leave = () => {
    const pending = ws.queue.length;
    Alert.alert("Sair do Vinculato Campo?",
      pending ? `Há ${pending} registro(s) aguardando envio. Se sair agora, eles serão enviados no nome de quem entrar depois.` : "Você precisará entrar de novo com e-mail e senha.",
      [{ text: "Cancelar", style: "cancel" }, { text: "Sair", style: "destructive", onPress: () => void signOut() }]);
  };

  const header = <Stack.Screen options={{
    headerRight: () => <Pressable onPress={leave} accessibilityRole="button" accessibilityLabel="Sair" hitSlop={10} style={styles.headerButton}>
      <Ionicons name="log-out-outline" size={24} color={colors.text} />
    </Pressable>,
  }} />;

  if (ws.loading && !ws.companies.length) return <>{header}<Loading text="Carregando empresas, locais de estoque e pendências…" /></>;

  if (ws.error && !ws.companies.length) {
    return <>{header}<Screen>
      <Banner>{ws.error}</Banner>
      <Button label="Tentar novamente" tone="primary" onPress={() => void ws.reload()} />
    </Screen></>;
  }

  if (!ws.permissions.view) {
    return <>{header}<Screen>
      <EmptyState title="Sem acesso ao Controle de EPI"
        text="Peça ao administrador do grupo a permissão epi.view. O app usa as mesmas permissões do painel." />
    </Screen></>;
  }

  if (!ws.companies.length || !ws.locations.length) {
    return <>{header}<Screen>
      <EmptyState title={!ws.companies.length ? "Nenhuma empresa disponível" : "Nenhum local de estoque"}
        text={!ws.companies.length
          ? "O Controle de EPI é organizado por empresa. Cadastre uma empresa ativa, ou peça acesso a uma, no painel."
          : "O estoque é controlado por local. Crie um local de estoque no painel, em Controle de EPI."}
        action={<Button label="Tentar novamente" onPress={() => void ws.reload()} />} />
    </Screen></>;
  }

  const { permissions: p, summary: s } = ws;
  const careQueue = s.pendingSanitizing + s.awaitingDisposal;
  const field: Action[] = [
    { href: "/entrega", label: "Entregar EPI", hint: "Sai do estoque e o colaborador assina", icon: "cube-outline", allowed: p.deliver },
    { href: "/devolucao", label: "Receber devolução", hint: "A condição decide o destino", icon: "return-down-back-outline", allowed: p.receiveReturn },
    { href: "/dano", label: "Registrar dano", hint: "Com foto da evidência", icon: "camera-outline", allowed: p.damage },
    { href: "/consulta", label: "Consultar colaborador", hint: "O que está em poder de quem", icon: "search-outline", allowed: p.view },
  ];
  const sesmt: Action[] = [
    { href: "/vencimentos", label: "Vencimentos e trocas", icon: "calendar-outline", allowed: p.view, badge: s.caExpired,
      hint: s.caExpired + s.caExpiring ? `${s.caExpired} CA vencido(s), ${s.caExpiring} vencendo` : "Quem está sem EPI, vencido ou com troca chegando" },
    { href: "/estoque", label: "Estoque", icon: "layers-outline", allowed: p.view,
      hint: p.stockAdjust ? "Saldo do local, entrada e transferência" : "Saldo deste local e dos outros" },
    { href: "/cuidado", label: "Higienização e descarte", icon: "sparkles-outline", allowed: p.view, badge: careQueue,
      hint: careQueue ? `${s.pendingSanitizing} para higienizar, ${s.awaitingDisposal} para descartar` : "Nada parado agora" },
  ];

  return <>{header}<Screen>
    <Text style={styles.greeting}>Olá, {user.name.split(" ")[0]}</Text>

    <Select label="Empresa" value={ws.company?.id ?? ""} onChange={ws.setCompanyId}
      options={ws.companies.map((item) => ({ id: item.id, label: item.name + (item.status === "inactive" ? " (inativa)" : "") }))} />
    <Select label="Local de estoque" value={ws.location?.id ?? ""} onChange={ws.setLocationId}
      options={ws.locations.map((item) => ({ id: item.id, label: item.name, detail: item.code || undefined }))} />

    {ws.queue.length > 0 && <Pressable onPress={() => router.push("/pendencias")} accessibilityRole="button"
      style={({ pressed }) => [styles.queue, pressed && styles.pressed]}>
      <Ionicons name="cloud-upload-outline" size={24} color={colors.warning} />
      <View style={styles.flex}>
        <Text style={styles.queueTitle}>{ws.queue.length} registro(s) aguardando envio</Text>
        <Text style={styles.queueText}>Feitos sem rede. Vão sozinhos quando a conexão voltar.</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={colors.warning} />
    </Pressable>}

    <SectionTitle>Operação</SectionTitle>
    <Grid actions={field} onOpen={(href) => router.push(href)} />
    <SectionTitle>SESMT</SectionTitle>
    <Grid actions={sesmt} onOpen={(href) => router.push(href)} />
  </Screen></>;
}

function Grid({ actions, onOpen }: { actions: Action[]; onOpen: (href: Href) => void }) {
  return <View style={styles.grid}>
    {actions.map((action) => <Pressable key={action.href} onPress={() => onOpen(action.href)} disabled={!action.allowed}
      accessibilityRole="button" accessibilityLabel={`${action.label}. ${action.allowed ? action.hint : "Sem permissão"}`}
      style={({ pressed }) => [styles.card, !action.allowed && styles.disabled, pressed && styles.pressed]}>
      <View style={styles.cardTop}>
        <View style={styles.cardIcon}><Ionicons name={action.icon} size={22} color={colors.accentText} /></View>
        {action.badge ? <View style={styles.badge}><Text style={styles.badgeText}>{action.badge > 99 ? "99+" : action.badge}</Text></View> : null}
      </View>
      <Text style={styles.cardTitle}>{action.label}</Text>
      <Text style={styles.cardHint}>{action.allowed ? action.hint : "Sem permissão para esta ação"}</Text>
    </Pressable>)}
  </View>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerButton: { paddingHorizontal: 6 },
  greeting: { color: colors.text, fontSize: 20, fontWeight: "800" },
  queue: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.warning, backgroundColor: colors.surface },
  queueTitle: { color: colors.text, fontSize: font.body, fontWeight: "700" },
  queueText: { color: colors.soft, fontSize: font.caption, marginTop: 2 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  card: { width: "48.5%", flexGrow: 1, flexBasis: "45%", minHeight: 128, padding: 14, gap: 4, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 },
  cardIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center" },
  badge: { minWidth: 26, height: 26, paddingHorizontal: 7, borderRadius: 13, backgroundColor: colors.danger, alignItems: "center", justifyContent: "center" },
  badgeText: { color: colors.bg, fontSize: 13, fontWeight: "800" },
  cardTitle: { color: colors.text, fontSize: font.body, fontWeight: "700" },
  cardHint: { color: colors.soft, fontSize: font.caption, lineHeight: 18 },
  disabled: { opacity: 0.45 },
  pressed: { transform: [{ scale: 0.97 }], opacity: 0.9 },
});
