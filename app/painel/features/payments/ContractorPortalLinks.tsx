"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Link2, LoaderCircle, RefreshCw, ShieldOff } from "lucide-react";
import { ConfirmDialog } from "../shared";
import { normalizeInvoicePortalLink, requestJson, type Row } from "./payments.api";
import type { InvoicePortalLink } from "./payments.types";
import styles from "./payments.module.css";

/**
 * O portal do prestador, visto de dentro.
 *
 * Esta é a resposta operacional a "cadê a nota?" — a pergunta que ocupa o
 * fechamento inteiro. Antes ela só podia ser respondida olhando o WhatsApp:
 * mandei? ele viu? A tabela troca isso por três fatos que o link registra
 * sozinho: pedido, aberto, recebido.
 *
 * "Aberto" é o que muda a conversa. Um prestador que nunca abriu não recebeu a
 * mensagem, e a cobrança certa é reenviar; um que abriu e não mandou está com
 * dificuldade em emitir, e a cobrança certa é outra. Sem esse dado, as duas
 * situações viravam a mesma mensagem repetida.
 *
 * O link em si aparece uma vez só, no momento em que nasce, junto das mensagens
 * prontas. Ele não volta: o banco guarda o hash, e uma tela que reexibisse
 * endereços válidos transformaria a lista de pendências num chaveiro.
 */

const statusLabels: Record<InvoicePortalLink["status"], string> = {
  active: "Aguardando envio",
  submitted: "Nota recebida",
  revoked: "Revogado",
  expired: "Prazo vencido",
};

/** Vocabulário do selo compartilhado: o tom vem do estado, não de uma cor solta. */
const statusTone: Record<InvoicePortalLink["status"], string> = {
  active: "pending",
  submitted: "validated",
  revoked: "canceled",
  expired: "divergent",
};

const dayLabel = (value: string) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(date);
};

type Generated = { contractorName: string; url: string };

export function ContractorPortalLinks({ companyId, competence, competenceLabel, money, canManage }: {
  companyId: string;
  competence: string;
  competenceLabel: (value: string) => string;
  money: (value: number) => string;
  canManage: boolean;
}) {
  const [links, setLinks] = useState<InvoicePortalLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [days, setDays] = useState("10");
  const [messages, setMessages] = useState("");
  /* O recorte a que as mensagens pertencem. Um bloco pronto para colar carrega
     valores e links de uma competência específica, e é exatamente o tipo de
     coisa que alguém copia sem reler o cabeçalho. */
  const [messagesScope, setMessagesScope] = useState("");
  const [generated, setGenerated] = useState<Generated[]>([]);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<InvoicePortalLink | null>(null);

  const base = "/api/payments/contractors/invoices/portal-links";

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ companyId, competence });
      const payload = await requestJson<{ links?: Row[] }>(`${base}?${params}`);
      setLinks((payload.links ?? []).map(normalizeInvoicePortalLink));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar os links do portal.");
    } finally {
      setLoading(false);
    }
  }, [companyId, competence]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  const scope = `${companyId}|${competence}`;
  const showMessages = messages !== "" && messagesScope === scope;

  const pending = useMemo(() => links.filter((link) => link.status === "active"), [links]);
  const opened = useMemo(() => pending.filter((link) => link.openedCount > 0).length, [pending]);
  const received = useMemo(() => links.filter((link) => link.status === "submitted").length, [links]);

  async function generate() {
    setBusy(true);
    setError("");
    try {
      const payload = await requestJson<{ links?: Generated[]; messages?: string }>(base, {
        method: "POST",
        body: JSON.stringify({ companyId, competence, days: Number(days) || undefined }),
      });
      setGenerated(payload.links ?? []);
      setMessages(payload.messages ?? "");
      setMessagesScope(scope);
      setCopied(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível gerar os links.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(link: InvoicePortalLink) {
    setBusy(true);
    setError("");
    try {
      await requestJson(`${base}/${encodeURIComponent(link.id)}`, { method: "DELETE" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível revogar o link.");
    } finally {
      setBusy(false);
      setRevoking(null);
    }
  }

  async function copyMessages() {
    try {
      await navigator.clipboard.writeText(messages);
      setCopied(true);
    } catch {
      // Área de transferência bloqueada pelo navegador. O texto está à vista
      // no campo, e selecionar e copiar à mão continua funcionando — dizer
      // "copiado" quando não copiou seria pior que não dizer nada.
      setError("O navegador bloqueou a cópia automática. Selecione o texto e copie manualmente.");
    }
  }

  return (
    <section className={styles.portalPanel} aria-labelledby="portal-links-title">
      <header className={styles.portalHeader}>
        <div>
          <span className={styles.eyebrow}>PORTAL DO PRESTADOR</span>
          <h3 id="portal-links-title">Pedir a nota por link</h3>
          <p>
            {loading
              ? "Carregando os pedidos desta competência…"
              : links.length === 0
                ? `Ninguém recebeu link em ${competenceLabel(competence)}. Gere os links para que cada prestador envie a nota sozinho.`
                : `${pending.length} aguardando envio, ${opened} já abriram, ${received} ${received === 1 ? "nota recebida" : "notas recebidas"} pelo portal.`}
          </p>
        </div>
        <div className={styles.portalActions}>
          <button type="button" className={styles.secondaryButton} onClick={() => void load()} disabled={loading || busy}>
            <RefreshCw aria-hidden="true" /> Atualizar
          </button>
          {canManage && (
            <>
              <label className={styles.portalDays}>
                <span>Prazo</span>
                <select value={days} onChange={(event) => setDays(event.target.value)} aria-label="Dias de validade do link">
                  <option value="5">5 dias</option>
                  <option value="10">10 dias</option>
                  <option value="15">15 dias</option>
                  <option value="30">30 dias</option>
                </select>
              </label>
              <button type="button" className={styles.primaryButton} onClick={() => void generate()} disabled={busy}>
                {busy ? <LoaderCircle aria-hidden="true" className={styles.spin} /> : <Link2 aria-hidden="true" />}
                {busy ? "Gerando…" : "Gerar links e mensagens"}
              </button>
            </>
          )}
        </div>
      </header>

      {error && <p className={styles.portalAlert} role="alert">{error}</p>}

      {showMessages && (
        <div className={styles.portalMessages}>
          <div className={styles.portalMessagesHead}>
            <strong>{generated.length} {generated.length === 1 ? "mensagem pronta" : "mensagens prontas"}</strong>
            <button type="button" className={styles.secondaryButton} onClick={() => void copyMessages()}>
              <Copy aria-hidden="true" /> {copied ? "Copiado" : "Copiar tudo"}
            </button>
          </div>
          {/* O campo é somente leitura e não um bloco de texto: dá para rolar,
              selecionar um prestador só e copiar sem a página inteira junto. */}
          <textarea value={messages} readOnly rows={10} aria-label="Mensagens com o link de envio" />
          <p className={styles.portalWarning}>
            Os endereços aparecem só agora. Guarde ou envie antes de sair desta tela — depois só gerando de novo,
            o que invalida os links anteriores.
          </p>
        </div>
      )}

      {!loading && links.length > 0 && (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <caption className={styles.tableCaption}>Links do portal em {competenceLabel(competence)}</caption>
            <thead>
              <tr>
                <th scope="col">Prestador</th><th scope="col">Valor pedido</th><th scope="col">Situação</th>
                <th scope="col">Abriu</th><th scope="col">Vence</th><th scope="col">Ações</th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.id}>
                  <th scope="row">{link.contractorName}<small>{link.contractorCode}</small></th>
                  <td>{money(link.expectedAmount)}</td>
                  <td><span className={styles.badge} data-tone={statusTone[link.status]}>{statusLabels[link.status]}</span></td>
                  <td>{link.openedCount > 0 ? `${dayLabel(link.firstOpenedAt)} · ${link.openedCount}×` : "Não abriu"}</td>
                  <td>{dayLabel(link.expiresAt)}</td>
                  <td className={styles.rowActions}>
                    {canManage && link.status === "active"
                      ? <button type="button" onClick={() => setRevoking(link)} disabled={busy}><ShieldOff aria-hidden="true" /> Revogar</button>
                      : <span className={styles.mutedCell}>{link.status === "revoked" && link.revokeReason ? link.revokeReason : "—"}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(revoking)}
        title="Revogar o link do portal"
        consequence={revoking
          ? `O link de ${revoking.contractorName} deixa de funcionar imediatamente. Quem já tiver recebido a mensagem verá um aviso para procurar a empresa.`
          : ""}
        confirmLabel="Revogar link"
        busy={busy}
        onConfirm={() => { if (revoking) void revoke(revoking); }}
        onCancel={() => setRevoking(null)}
      />
    </section>
  );
}
