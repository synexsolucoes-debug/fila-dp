/**
 * Leitor de crachá e de código do EPI, em tela cheia.
 *
 * Apontar a câmera pede as duas mãos e nenhuma distração em volta. A primeira
 * leitura fecha o leitor — continuar lendo depois do primeiro código dispararia
 * a busca dez vezes enquanto a câmera ainda vê a etiqueta. Sem permissão de
 * câmera, ou com etiqueta ilegível, o código pode ser digitado.
 */
import Ionicons from "@expo/vector-icons/Ionicons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState } from "react";
import { Modal, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, font, radius } from "../lib/theme";
import { Button, Field } from "./ui";

export function CodeScanner({ visible, label, onCode, onClose }: {
  visible: boolean; label: string; onCode: (code: string) => void; onClose: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState("");
  const done = useRef(false);

  const finish = (code: string) => {
    const value = code.trim();
    if (!value || done.current) return;
    done.current = true;
    setManual("");
    onCode(value);
  };

  return <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}
    onShow={() => { done.current = false; }}>
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Text style={styles.title}>{label}</Text>
        <Button label="Fechar" tone="ghost" onPress={onClose} icon={<Ionicons name="close" size={22} color={colors.accentText} />} />
      </View>

      <View style={styles.stage}>
        {permission?.granted && visible
          ? <>
            <CameraView style={StyleSheet.absoluteFill} facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr", "code128", "code39", "ean13", "ean8", "itf14", "datamatrix", "pdf417", "upc_a", "upc_e", "codabar", "code93"] }}
              onBarcodeScanned={(result) => finish(result.data)} />
            <View pointerEvents="none" style={styles.frame} />
          </>
          : <View style={styles.idle}>
            <Ionicons name="camera-outline" size={36} color={colors.soft} />
            <Text style={styles.idleText}>
              {permission && !permission.canAskAgain
                ? "A câmera foi negada. Libere em Ajustes › Expo Go › Câmera, ou digite o código abaixo."
                : "Permita a câmera para ler o código."}
            </Text>
            {permission?.canAskAgain !== false && <Button label="Permitir câmera" tone="primary" style={styles.allow}
              onPress={() => void requestPermission()} />}
          </View>}
      </View>

      <View style={styles.manual}>
        <Field label="Ou digite o código" value={manual} onChangeText={setManual} autoCapitalize="characters"
          autoCorrect={false} returnKeyType="search" onSubmitEditing={() => finish(manual)} />
        <Button label="Usar este código" tone="primary" disabled={!manual.trim()} onPress={() => finish(manual)} />
      </View>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 16, paddingRight: 6, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { color: colors.text, fontSize: font.title, fontWeight: "700", flexShrink: 1 },
  stage: { flex: 1, backgroundColor: colors.muted, overflow: "hidden" },
  frame: { position: "absolute", left: "12%", right: "12%", top: "30%", bottom: "30%", borderWidth: 3, borderColor: colors.accent, borderRadius: radius.lg },
  idle: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  idleText: { color: colors.soft, fontSize: font.body, textAlign: "center", lineHeight: 22 },
  allow: { flex: 0, paddingHorizontal: 24 },
  manual: { gap: 10, padding: 14, borderTopWidth: 1, borderTopColor: colors.border },
});
