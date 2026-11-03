/**
 * Escolha de uma opção numa lista própria (empresa, local de estoque).
 *
 * O React Native não tem `<select>`. Uma folha que sobe do rodapé, com linhas
 * de 56pt, é o que o iOS faz nos próprios ajustes e o que cabe com luva.
 */
import Ionicons from "@expo/vector-icons/Ionicons";
import { useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, font, radius, TARGET } from "../lib/theme";

export function Select<T extends string>({ label, value, options, onChange, placeholder = "Escolher" }: {
  label: string; value: T | ""; options: Array<{ id: T; label: string; detail?: string }>;
  onChange: (id: T) => void; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const current = options.find((option) => option.id === value);

  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`${label}: ${current?.label ?? placeholder}. Trocar`}
      style={({ pressed }) => [styles.control, pressed && styles.pressed]}>
      <Text style={styles.value} numberOfLines={1}>{current?.label ?? placeholder}</Text>
      <Ionicons name="chevron-down" size={20} color={colors.soft} />
    </Pressable>

    <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
      <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessibilityLabel="Fechar" />
      <View style={[styles.sheet, { paddingBottom: 12 + insets.bottom }]}>
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>{label}</Text>
          <Pressable onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel="Fechar" style={styles.close}>
            <Ionicons name="close" size={22} color={colors.text} />
          </Pressable>
        </View>
        <FlatList data={options} keyExtractor={(item) => item.id} style={styles.list}
          renderItem={({ item }) => {
            const active = item.id === value;
            return <Pressable onPress={() => { onChange(item.id); setOpen(false); }} accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={({ pressed }) => [styles.option, active && styles.optionActive, pressed && styles.pressed]}>
              <View style={styles.optionText}>
                <Text style={[styles.optionLabel, active && { color: colors.accentText }]}>{item.label}</Text>
                {item.detail ? <Text style={styles.optionDetail}>{item.detail}</Text> : null}
              </View>
              {active ? <Ionicons name="checkmark" size={22} color={colors.accentText} /> : null}
            </Pressable>;
          }} />
      </View>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  label: { color: colors.soft, fontSize: font.label, fontWeight: "800" },
  control: {
    minHeight: TARGET, paddingHorizontal: 12, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface, flexDirection: "row", alignItems: "center", gap: 8,
  },
  value: { flex: 1, color: colors.text, fontSize: 16 },
  pressed: { opacity: 0.85 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: { maxHeight: "70%", backgroundColor: colors.surface, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderTopWidth: 1, borderColor: colors.border },
  sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 16, paddingRight: 6, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  sheetTitle: { color: colors.text, fontSize: font.title, fontWeight: "700" },
  close: { width: TARGET, height: TARGET, alignItems: "center", justifyContent: "center" },
  list: { paddingHorizontal: 10, paddingTop: 8 },
  option: { minHeight: 56, paddingHorizontal: 12, borderRadius: radius.sm, flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 4 },
  optionActive: { backgroundColor: colors.accentSoft },
  optionText: { flex: 1 },
  optionLabel: { color: colors.text, fontSize: 16 },
  optionDetail: { color: colors.soft, fontSize: font.caption, marginTop: 2 },
});
