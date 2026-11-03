/**
 * Raiz do Vinculato Campo.
 *
 * Sem sessão, só a tela de login existe; com sessão, as telas de trabalho, já
 * dentro do contexto de empresa, local e fila. A troca é por `Stack.Protected`
 * (Expo Router do SDK 58): ninguém chega a uma tela de trabalho por link
 * direto sem estar logado.
 */
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { Loading } from "../components/ui";
import { SessionProvider, useSession } from "../lib/session";
import { colors, font, radius } from "../lib/theme";
import { useWorkspace, WorkspaceProvider } from "../lib/workspace";

export default function RootLayout() {
  return <SafeAreaProvider>
    <StatusBar style="light" />
    <SessionProvider>
      <Navigator />
    </SessionProvider>
  </SafeAreaProvider>;
}

const screenOptions = {
  headerStyle: { backgroundColor: colors.surface },
  headerTintColor: colors.text,
  headerTitleStyle: { color: colors.text, fontWeight: "700" as const },
  // No iOS 26 o cabeçalho nasce transparente; aqui ele é sólido para o
  // conteúdo não correr por baixo do título.
  headerTransparent: false,
  headerShadowVisible: false,
  headerBackButtonDisplayMode: "minimal" as const,
  contentStyle: { backgroundColor: colors.bg },
};

function Navigator() {
  const { state } = useSession();
  if (state.status === "loading") return <Loading text="Abrindo o Vinculato Campo…" />;
  const signedIn = state.status === "signedIn";

  const stack = <Stack screenOptions={screenOptions}>
    <Stack.Protected guard={signedIn}>
      <Stack.Screen name="index" options={{ title: "Vinculato Campo" }} />
      <Stack.Screen name="entrega" options={{ title: "Entregar EPI" }} />
      <Stack.Screen name="devolucao" options={{ title: "Receber devolução" }} />
      <Stack.Screen name="dano" options={{ title: "Registrar dano" }} />
      <Stack.Screen name="consulta" options={{ title: "Consultar colaborador" }} />
      <Stack.Screen name="vencimentos" options={{ title: "Vencimentos e trocas" }} />
      <Stack.Screen name="estoque" options={{ title: "Estoque" }} />
      <Stack.Screen name="cuidado" options={{ title: "Higienização e descarte" }} />
      <Stack.Screen name="pendencias" options={{ title: "Pendências de envio" }} />
    </Stack.Protected>
    <Stack.Protected guard={!signedIn}>
      <Stack.Screen name="login" options={{ headerShown: false }} />
    </Stack.Protected>
  </Stack>;

  if (!signedIn) return stack;
  // A chave troca o contexto inteiro na troca de usuário: nada da pessoa
  // anterior (empresa escolhida, contadores) passa para a próxima.
  return <WorkspaceProvider key={state.user.email}>
    {stack}
    <Toast />
  </WorkspaceProvider>;
}

/** Aviso curto no rodapé: "registrado", "guardado para enviar", "falta a evidência". */
function Toast() {
  const { toast } = useWorkspace();
  const insets = useSafeAreaInsets();
  if (!toast) return null;
  return <View pointerEvents="none" style={[styles.toast, { bottom: 16 + insets.bottom }]} accessibilityLiveRegion="polite" accessibilityRole="alert">
    <Text style={styles.toastText}>{toast}</Text>
  </View>;
}

const styles = StyleSheet.create({
  toast: {
    position: "absolute", left: 14, right: 14, padding: 14, borderRadius: radius.md, borderWidth: 1,
    borderColor: colors.success, backgroundColor: colors.surface,
    shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  toastText: { color: colors.success, fontSize: font.body, fontWeight: "700" },
});
