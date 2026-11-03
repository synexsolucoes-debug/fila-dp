/**
 * O que ficou para enviar.
 *
 * Dizer qual parte está pendente evita o pior engano possível aqui: descartar
 * achando que nada foi registrado, quando a entrega já debitou o estoque e só
 * a evidência ficou na fila.
 */
import Ionicons from "@expo/vector-icons/Ionicons";
import { useState } from "react";
import { Alert } from "react-native";
import { ActionBar, Button, EmptyState, Hint, Pill, Row, Screen } from "../components/ui";
import { discardOperation } from "../lib/queue";
import { colors } from "../lib/theme";
import { useWorkspace } from "../lib/workspace";

export default function Pending() {
  const ws = useWorkspace();
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    try {
      const result = await ws.flush();
      ws.notify(result.sent > 0 ? `${result.sent} enviado(s).`
        : result.failed > 0 ? `${result.failed} recusado(s) pelo servidor — veja o motivo na pendência.`
          : "Nada foi enviado — sem conexão com o servidor.");
    } finally { setBusy(false); }
  }

  function discard(id: string, partial: boolean) {
    Alert.alert(partial ? "Descartar a evidência?" : "Descartar esta pendência?",
      partial ? "O registro já está no servidor; só o anexo deixa de subir." : "O registro não foi gravado no servidor e será perdido.",
      [{ text: "Voltar", style: "cancel" }, { text: "Descartar", style: "destructive", onPress: async () => { await discardOperation(id); await ws.refreshQueue(); } }]);
  }

  if (!ws.queue.length) return <Screen>
    <EmptyState title="Nada pendente" text="Tudo o que você registrou já está no servidor." />
  </Screen>;

  return <Screen footer={<ActionBar>
    <Button label={busy ? "Enviando…" : "Enviar agora"} tone="primary" busy={busy} onPress={() => void send()}
      icon={<Ionicons name="cloud-upload-outline" size={20} color={colors.onAccent} />} />
  </ActionBar>}>
    <Hint>Vai sozinho quando a conexão voltar. A chave de idempotência garante que reenviar não duplica a entrega.</Hint>
    {ws.queue.map((item) => <Row key={item.id} title={item.label}
      lines={[`${new Date(item.createdAt).toLocaleString("pt-BR")} · ${item.attempts} tentativa(s)`, item.lastError]}
      below={<>
        <Pill tone={item.recordId ? "warning" : "info"} label={item.recordId ? "Registro gravado · falta a evidência" : "Registro ainda não enviado"} />
        {item.attempts > 0 && item.lastError
          ? <Button label={item.recordId ? "Descartar a evidência" : "Descartar"} tone="ghost" style={{ alignSelf: "flex-start" }}
            onPress={() => discard(item.id, Boolean(item.recordId))} /> : null}
      </>} />)}
  </Screen>;
}
