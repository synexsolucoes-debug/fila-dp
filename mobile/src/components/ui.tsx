/**
 * Peças de interface do Vinculato Campo.
 *
 * Feitas para uma mão, de luva: alvo mínimo de 48pt, contraste alto, uma coisa
 * por vez. A barra de ações fica fora da rolagem, presa ao rodapé e acima do
 * indicador de gesto do iPhone — é onde o polegar está.
 */
import { useState, type ReactNode } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type PressableProps, type StyleProp, type TextInputProps, type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, font, radius, TARGET } from "../lib/theme";

/** Tela com rolagem, teclado que empurra o conteúdo e barra de ações no rodapé. */
export function Screen({ children, footer, scrollEnabled = true, refreshing }: {
  children: ReactNode; footer?: ReactNode; scrollEnabled?: boolean; refreshing?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}
    keyboardVerticalOffset={Platform.OS === "ios" ? 96 : 0}>
    <View style={styles.flex}>
      <ScrollView style={styles.flex} contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag" scrollEnabled={scrollEnabled}>
        {refreshing ? <ActivityIndicator color={colors.accentText} style={styles.spinner} /> : null}
        {children}
      </ScrollView>
      {footer ? <View style={[styles.footer, { paddingBottom: 10 + insets.bottom }]}>{footer}</View> : null}
    </View>
  </KeyboardAvoidingView>;
}

type ButtonTone = "primary" | "secondary" | "ghost" | "danger";

export function Button({ label, onPress, tone = "secondary", disabled, busy, icon, style, accessibilityLabel }: {
  label: string; onPress: () => void; tone?: ButtonTone; disabled?: boolean; busy?: boolean; icon?: ReactNode;
  style?: StyleProp<ViewStyle>; accessibilityLabel?: string;
}) {
  const off = disabled || busy;
  return <Pressable onPress={onPress} disabled={off} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled: Boolean(off), busy: Boolean(busy) }}
    style={({ pressed }) => [styles.button, buttonTone[tone], off && styles.disabled, pressed && !off && styles.pressed, style]}>
    {busy ? <ActivityIndicator color={tone === "primary" ? colors.onAccent : colors.accentText} /> : icon}
    <Text numberOfLines={1} style={[styles.buttonText, tone === "primary" && { color: colors.onAccent },
      (tone === "ghost") && { color: colors.accentText }, tone === "danger" && { color: colors.danger }]}>{label}</Text>
  </Pressable>;
}

const buttonTone: Record<ButtonTone, ViewStyle> = {
  primary: { backgroundColor: colors.accent, borderColor: colors.accent, flex: 1 },
  secondary: { backgroundColor: colors.surface, borderColor: colors.border },
  ghost: { backgroundColor: "transparent", borderColor: "transparent", minHeight: 40, paddingHorizontal: 10 },
  danger: { backgroundColor: colors.surface, borderColor: colors.danger },
};

/** Linha tocável de lista: ícone, título, até duas linhas de detalhe e um complemento à direita ou embaixo. */
export function Row({ title, lines = [], onPress, disabled, left, below, right, accessibilityLabel }: {
  title: string; lines?: string[]; onPress?: () => void; disabled?: boolean; left?: ReactNode; below?: ReactNode;
  right?: ReactNode; accessibilityLabel?: string;
}) {
  const content = <>
    {left ? <View style={styles.rowLeft}>{left}</View> : null}
    <View style={styles.flexShrink}>
      <Text style={styles.rowTitle}>{title}</Text>
      {lines.filter(Boolean).map((line, index) => <Text key={index} style={styles.rowLine}>{line}</Text>)}
      {below}
    </View>
    {right ? <View style={styles.rowRight}>{right}</View> : null}
  </>;
  if (!onPress) return <View style={styles.row}>{content}</View>;
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
    accessibilityState={{ disabled: Boolean(disabled) }}
    style={({ pressed }) => [styles.row, disabled && styles.disabled, pressed && !disabled && styles.rowPressed]}>
    {content}
  </Pressable>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionTitle} accessibilityRole="header">{children}</Text>;
}

export function Hint({ children, tone }: { children: ReactNode; tone?: "warning" | "danger" }) {
  return <Text style={[styles.hint, tone === "warning" && { color: colors.warning }, tone === "danger" && { color: colors.danger }]}>{children}</Text>;
}

export function Banner({ children, tone = "danger" }: { children: ReactNode; tone?: "danger" | "warning" | "info" }) {
  const color = tone === "danger" ? colors.danger : tone === "warning" ? colors.warning : colors.accentText;
  return <View accessibilityRole="alert" style={[styles.banner, { borderColor: color }]}>
    <Text style={[styles.bannerText, { color }]}>{children}</Text>
  </View>;
}

/** Bloco "o que acontece ao confirmar": a consequência aparece antes de gravar. */
export function Consequence({ title, items, tone }: {
  title: string; items: Array<{ text: string; alert?: boolean }>; tone?: "warning";
}) {
  return <View style={[styles.consequence, tone === "warning" && { borderColor: colors.warning }]}>
    <Text style={[styles.consequenceTitle, tone === "warning" && { color: colors.warning }]}>{title}</Text>
    {items.map((item, index) => <Text key={index} style={[styles.consequenceItem, item.alert && { color: colors.warning, fontWeight: "700" }]}>
      • {item.text}
    </Text>)}
  </View>;
}

/** O que já foi escolhido no fluxo, com "Trocar" para voltar um passo. */
export function Chosen({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  return <View style={styles.chosen}>
    <View style={styles.flexShrink}>
      <Text style={styles.chosenLabel}>{label}</Text>
      <Text style={styles.chosenValue}>{value}</Text>
    </View>
    <Button label="Trocar" tone="ghost" onPress={onClear} accessibilityLabel={`Trocar ${label.toLowerCase()}`} />
  </View>;
}

export function Field({ label, ...props }: { label: string } & TextInputProps) {
  const [focused, setFocused] = useState(false);
  return <View style={styles.field}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <TextInput placeholderTextColor={colors.soft} {...props}
      onFocus={(event) => { setFocused(true); props.onFocus?.(event); }}
      onBlur={(event) => { setFocused(false); props.onBlur?.(event); }}
      style={[styles.input, props.multiline && styles.inputMultiline, focused && styles.inputFocused, props.style]} />
  </View>;
}

/** Quantidade com alvo de luva. `max` é o teto real — saldo do local ou o que está em poder. */
export function Stepper({ value, onChange, max }: { value: number; onChange: (next: number) => void; max: number }) {
  const ceiling = Math.max(max, 1);
  return <View style={styles.stepper}>
    <StepButton label="−" a11y="Diminuir" disabled={value <= 1} onPress={() => onChange(Math.max(1, value - 1))} />
    <Text style={styles.stepperValue} accessibilityLiveRegion="polite">{value}</Text>
    <StepButton label="+" a11y="Aumentar" disabled={value >= ceiling} onPress={() => onChange(Math.min(ceiling, value + 1))} />
  </View>;
}

function StepButton({ label, a11y, onPress, disabled }: { label: string; a11y: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={a11y}
    style={({ pressed }) => [styles.stepButton, disabled && styles.disabled, pressed && styles.pressed]}>
    <Text style={styles.stepButtonText}>{label}</Text>
  </Pressable>;
}

/** Escolha entre opções fixas (condição, motivo, decisão). */
export function Choices<T extends string>({ value, options, onChange, label }: {
  value: T; options: Array<{ id: T; label: string }>; onChange: (next: T) => void; label: string;
}) {
  return <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel={label}>
    {options.map((option) => {
      const active = option.id === value;
      return <Pressable key={option.id} onPress={() => onChange(option.id)} accessibilityRole="radio"
        accessibilityState={{ checked: active }}
        style={({ pressed }) => [styles.choice, active && styles.choiceActive, pressed && styles.pressed]}>
        <Text style={[styles.choiceText, active && styles.choiceTextActive]}>{option.label}</Text>
      </Pressable>;
    })}
  </View>;
}

/** Etiqueta de situação. A cor reforça; o texto é que informa. */
export function Pill({ label, tone }: { label: string; tone: "danger" | "warning" | "info" | "success" }) {
  const color = tone === "danger" ? colors.danger : tone === "warning" ? colors.warning : tone === "success" ? colors.success : colors.accentText;
  return <View style={[styles.pill, { borderColor: color }]}><Text style={[styles.pillText, { color }]}>{label}</Text></View>;
}

/** Quadros de números. Tocáveis quando servem de filtro. */
export function Stat({ label, value, tone, active, onPress }: {
  label: string; value: number | string; tone?: "danger" | "warning"; active?: boolean; onPress?: () => void;
}) {
  const color = tone === "danger" ? colors.danger : tone === "warning" ? colors.warning : colors.text;
  const body = <>
    <Text style={[styles.statLabel, active && { color: colors.accentText, fontWeight: "700" }]} numberOfLines={1}>{label}</Text>
    <Text style={[styles.statValue, { color }]}>{value}</Text>
  </>;
  if (!onPress) return <View style={styles.stat}>{body}</View>;
  return <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: Boolean(active) }}
    accessibilityLabel={`${label}: ${value}${active ? ", filtro ativo" : ""}`}
    style={({ pressed }) => [styles.stat, active && styles.statActive, pressed && styles.pressed]}>{body}</Pressable>;
}

export function StatRow({ children }: { children: ReactNode }) {
  return <View style={styles.statRow}>{children}</View>;
}

export function EmptyState({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return <View style={styles.empty}>
    <Text style={styles.emptyTitle}>{title}</Text>
    {text ? <Text style={styles.emptyText}>{text}</Text> : null}
    {action}
  </View>;
}

/** Duas ou três ações no rodapé. Com três, a principal ocupa a largura toda embaixo. */
export function ActionBar({ children, stacked }: { children: ReactNode; stacked?: boolean }) {
  return <View style={[styles.actionBar, stacked && styles.actionBarStacked]}>{children}</View>;
}

export function Loading({ text }: { text: string }) {
  return <View style={styles.loading}>
    <ActivityIndicator size="large" color={colors.accentText} />
    <Text style={styles.hint}>{text}</Text>
  </View>;
}

export type IconPressableProps = PressableProps & { label: string };

export const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  flexShrink: { flex: 1, minWidth: 0 },
  screen: { padding: 14, paddingBottom: 32, gap: 14 },
  spinner: { marginBottom: 4 },
  footer: { paddingHorizontal: 14, paddingTop: 10, backgroundColor: colors.bg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  button: {
    minHeight: TARGET, paddingHorizontal: 16, borderRadius: radius.md, borderWidth: 1,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
  },
  buttonText: { color: colors.text, fontSize: font.body, fontWeight: "700" },
  disabled: { opacity: 0.45 },
  pressed: { transform: [{ scale: 0.97 }], opacity: 0.9 },
  row: {
    minHeight: 64, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface, flexDirection: "row", alignItems: "center", gap: 12,
  },
  rowPressed: { backgroundColor: colors.muted, transform: [{ scale: 0.985 }] },
  rowLeft: { width: 28, alignItems: "center" },
  rowRight: { alignItems: "flex-end" },
  rowTitle: { color: colors.text, fontSize: font.body, fontWeight: "700" },
  rowLine: { color: colors.soft, fontSize: font.caption, marginTop: 2 },
  sectionTitle: { color: colors.soft, fontSize: font.label, fontWeight: "800", marginTop: 4 },
  hint: { color: colors.soft, fontSize: font.caption, lineHeight: 19 },
  banner: { padding: 12, borderRadius: radius.sm, borderWidth: 1, backgroundColor: colors.surface },
  bannerText: { fontSize: font.caption, lineHeight: 19, fontWeight: "600" },
  consequence: { padding: 13, borderRadius: radius.md, borderWidth: 1, borderColor: colors.accentSoft, backgroundColor: colors.surface, gap: 5 },
  consequenceTitle: { color: colors.accentText, fontSize: font.label, fontWeight: "800" },
  consequenceItem: { color: colors.text, fontSize: font.caption, lineHeight: 19 },
  chosen: {
    padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.muted,
    flexDirection: "row", alignItems: "center", gap: 8,
  },
  chosenLabel: { color: colors.soft, fontSize: 12, fontWeight: "800" },
  chosenValue: { color: colors.text, fontSize: font.body, fontWeight: "700", marginTop: 2 },
  field: { gap: 6 },
  fieldLabel: { color: colors.soft, fontSize: font.label, fontWeight: "800" },
  // 16pt: abaixo disso o iOS amplia o campo ao focar.
  input: {
    minHeight: TARGET, paddingHorizontal: 12, paddingVertical: 10, borderRadius: radius.sm, borderWidth: 1,
    borderColor: colors.border, backgroundColor: colors.surface, color: colors.text, fontSize: 16,
  },
  inputMultiline: { minHeight: 84, textAlignVertical: "top" },
  inputFocused: { borderColor: colors.accent },
  stepper: { flexDirection: "row", alignItems: "center", gap: 14 },
  stepButton: {
    width: 56, height: 56, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface, alignItems: "center", justifyContent: "center",
  },
  stepButtonText: { color: colors.text, fontSize: 26, fontWeight: "700" },
  stepperValue: { color: colors.text, fontSize: 28, fontWeight: "800", minWidth: 44, textAlign: "center", fontVariant: ["tabular-nums"] },
  choices: { gap: 8 },
  choice: { minHeight: TARGET, paddingHorizontal: 13, paddingVertical: 11, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, justifyContent: "center" },
  choiceActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  choiceText: { color: colors.text, fontSize: font.body },
  choiceTextActive: { color: colors.accentText, fontWeight: "700" },
  pill: { alignSelf: "flex-start", marginTop: 6, paddingHorizontal: 9, paddingVertical: 3, borderRadius: radius.pill, borderWidth: 1 },
  pillText: { fontSize: font.caption, fontWeight: "800" },
  statRow: { flexDirection: "row", gap: 8 },
  stat: { flex: 1, minHeight: 66, padding: 11, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, gap: 2 },
  statActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  statLabel: { color: colors.soft, fontSize: 12 },
  statValue: { fontSize: font.number, fontWeight: "800", fontVariant: ["tabular-nums"] },
  empty: { alignItems: "center", gap: 10, padding: 24, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, marginTop: 12 },
  emptyTitle: { color: colors.text, fontSize: font.title, fontWeight: "700", textAlign: "center" },
  emptyText: { color: colors.soft, fontSize: font.caption, lineHeight: 20, textAlign: "center" },
  actionBar: { flexDirection: "row", gap: 9 },
  actionBarStacked: { flexDirection: "column" },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24, backgroundColor: colors.bg },
});
