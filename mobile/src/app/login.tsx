/**
 * Entrada no app: e-mail e senha do Vinculato.
 *
 * O endereço do servidor vem preenchido e fica escondido atrás de "Outro
 * endereço" — quem usa a produção nunca precisa ver; quem testa uma prévia
 * consegue trocar sem reinstalar nada.
 */
import { useState } from "react";
import { Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Banner, Button, Field, Hint } from "../components/ui";
import { useSession } from "../lib/session";
import { colors, font } from "../lib/theme";

export default function Login() {
  const { state, signIn } = useSession();
  const [server, setServer] = useState(state.server);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showServer, setShowServer] = useState(!state.server);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(state.status === "signedOut" ? state.notice ?? "" : "");

  async function submit() {
    if (!email.trim() || !password) { setProblem("Informe e-mail e senha."); return; }
    setBusy(true); setProblem("");
    try {
      await signIn(server, email, password);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Não foi possível entrar.");
    } finally { setBusy(false); }
  }

  return <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.brand}>
          <Image source={require("../../assets/icon.png")} style={styles.logo} accessibilityIgnoresInvertColors />
          <Text style={styles.title}>Vinculato Campo</Text>
          <Text style={styles.subtitle}>Controle de EPI no local de trabalho</Text>
        </View>

        {problem ? <Banner>{problem}</Banner> : null}

        <Field label="E-mail" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none"
          autoCorrect={false} autoComplete="email" textContentType="username" returnKeyType="next" />
        <Field label="Senha" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password"
          textContentType="password" returnKeyType="go" onSubmitEditing={() => void submit()} />

        {showServer
          ? <Field label="Endereço do Vinculato" value={server} onChangeText={setServer} keyboardType="url"
            autoCapitalize="none" autoCorrect={false} placeholder="https://vinculato.vercel.app" />
          : <Button label="Outro endereço do Vinculato" tone="ghost" onPress={() => setShowServer(true)} />}

        <Button label={busy ? "Entrando…" : "Entrar"} tone="primary" busy={busy} onPress={() => void submit()} style={styles.submit} />
        <Hint>Use o mesmo e-mail e senha do Vinculato. As permissões são as mesmas do painel.</Hint>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, gap: 14, flexGrow: 1, justifyContent: "center" },
  brand: { alignItems: "center", gap: 6, marginBottom: 12 },
  logo: { width: 84, height: 84, borderRadius: 20 },
  title: { color: colors.text, fontSize: 24, fontWeight: "800", marginTop: 8 },
  subtitle: { color: colors.soft, fontSize: font.body },
  submit: { flex: 0, marginTop: 4 },
});
