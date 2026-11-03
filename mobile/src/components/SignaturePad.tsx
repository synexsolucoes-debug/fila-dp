/**
 * Assinatura do colaborador com o dedo.
 *
 * O traço é desenhado com SVG enquanto a pessoa assina e, ao confirmar a
 * entrega, vira um PNG pelo codificador próprio (`lib/png.ts`) — sem
 * depender de captura de tela, que não é garantida no Expo Go.
 *
 * A rolagem da tela é desligada enquanto o dedo está na área: sem isso,
 * assinar arrasta a página e sai um risco torto.
 */
import { File, Paths } from "expo-file-system";
import { useRef, useState } from "react";
import { PanResponder, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Path } from "react-native-svg";
import { rasterizeSignature, type Stroke } from "../lib/png";
import { colors, font, radius } from "../lib/theme";
import { Button } from "./ui";

export type SignatureValue = { strokes: Stroke[]; width: number; height: number };

const toPath = (stroke: Stroke) => stroke.length === 1
  ? `M${stroke[0].x} ${stroke[0].y} l0.1 0.1`
  : stroke.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");

export function SignaturePad({ onChange, onDrawing, disabled }: {
  onChange: (value: SignatureValue | null) => void;
  /** Avisa a tela para travar a rolagem enquanto o dedo desenha. */
  onDrawing: (drawing: boolean) => void;
  disabled?: boolean;
}) {
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const size = useRef({ width: 1, height: 1 });
  const current = useRef<Stroke | null>(null);

  const publish = (next: Stroke[]) => {
    setStrokes(next);
    onChange(next.length ? { strokes: next, ...size.current } : null);
  };

  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => !disabled,
    onMoveShouldSetPanResponder: () => !disabled,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (event) => {
      onDrawing(true);
      current.current = [{ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }];
      setStrokes((previous) => [...previous, current.current as Stroke]);
    },
    onPanResponderMove: (event) => {
      if (!current.current) return;
      const x = Math.max(0, Math.min(size.current.width, event.nativeEvent.locationX));
      const y = Math.max(0, Math.min(size.current.height, event.nativeEvent.locationY));
      current.current.push({ x, y });
      // Nova referência para o React redesenhar o traço em andamento.
      setStrokes((previous) => [...previous.slice(0, -1), [...(current.current as Stroke)]]);
    },
    onPanResponderRelease: () => {
      onDrawing(false);
      const finished = current.current;
      current.current = null;
      if (!finished) return;
      setStrokes((previous) => {
        const next = [...previous.slice(0, -1), finished];
        onChange({ strokes: next, ...size.current });
        return next;
      });
    },
    onPanResponderTerminate: () => { onDrawing(false); current.current = null; },
  })).current;

  return <View style={styles.block}>
    <View style={styles.pad} accessibilityLabel="Área de assinatura do colaborador" accessibilityRole="image"
      onLayout={(event: LayoutChangeEvent) => { size.current = { width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height }; }}
      {...responder.panHandlers}>
      <Svg width="100%" height="100%">
        {strokes.map((stroke, index) => <Path key={index} d={toPath(stroke)} stroke="#111827" strokeWidth={3}
          strokeLinecap="round" strokeLinejoin="round" fill="none" />)}
      </Svg>
      {!strokes.length && <Text pointerEvents="none" style={styles.placeholder}>Assine aqui com o dedo</Text>}
    </View>
    <View style={styles.footer}>
      <Text style={styles.status}>{strokes.length ? "Assinatura capturada" : "O colaborador assina na área branca"}</Text>
      <Button label="Limpar" tone="ghost" disabled={disabled || !strokes.length} onPress={() => publish([])} />
    </View>
  </View>;
}

/**
 * Grava a assinatura como PNG na pasta de documentos do app.
 *
 * Documentos, não cache: se a entrega cair na fila sem rede, o arquivo
 * precisa estar lá quando o envio acontecer, mesmo depois de fechar o app.
 */
export function saveSignaturePng(value: SignatureValue) {
  const bytes = rasterizeSignature(value.strokes, value.width, value.height);
  const file = new File(Paths.document, `assinatura-${Date.now()}.png`);
  file.create();
  file.write(bytes);
  return { uri: file.uri, filename: file.name };
}

const styles = StyleSheet.create({
  block: { gap: 8 },
  pad: { height: 200, borderRadius: radius.md, backgroundColor: "#ffffff", borderWidth: 2, borderColor: colors.border, overflow: "hidden" },
  placeholder: { position: "absolute", alignSelf: "center", top: 88, color: "#9aa5b4", fontSize: font.body },
  footer: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  status: { color: colors.soft, fontSize: font.caption, flexShrink: 1 },
});
