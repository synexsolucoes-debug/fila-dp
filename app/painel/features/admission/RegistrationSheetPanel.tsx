"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import {
  BadgeCheck, Check, Copy, Download, FileText, Image as ImageIcon, LoaderCircle,
  Maximize2, Minimize2, Pencil, RefreshCw, ShieldAlert, Trash2, TriangleAlert,
} from "lucide-react";
import {
  FIELD_SOURCE_LABELS, requestSheet, type FieldProvenance, type PhotoOcrSuggestion, type RegistrationSheet,
  type SheetBlock, type SheetField, type SheetPayload, type SheetPreparationState,
} from "./admission.api";
import styles from "./admission.module.css";

/**
 * A ficha de contratação, do lado de quem transcreve.
 *
 * O trabalho que esta tela substitui é concreto: abrir o PDF do Registro de
 * Empregado numa janela, o ERP na outra, e digitar quarenta e poucos campos
 * olhando de um para o outro. O erro que ela evita não é o de digitação — é o
 * de **leitura**: trocar o número do RG pelo do CPF, pular um dígito do PIS,
 * ler 2026 onde está 2025.
 *
 * ## Por que campo reprovado aparece, em vez de sumir
 *
 * Seria mais limpo mostrar só o que deu certo. Seria também uma armadilha: quem
 * transcreve contaria os campos da tela, acharia que acabou, e o ERP ficaria
 * sem o dado que a leitura não conseguiu recuperar. O campo ilegível ocupa o
 * mesmo lugar que ocuparia se tivesse valor, e diz o que fazer — conferir no
 * arquivo, que está a um clique.
 *
 * A distinção entre "em branco no registro" e "não foi possível ler" está na
 * tela porque pede ações opostas: a primeira manda buscar na origem, a segunda
 * manda abrir o PDF. Chamar as duas de "sem valor" mandaria metade das pessoas
 * para o lugar errado.
 *
 * ## Por que não existe "copiar a ficha inteira"
 *
 * Porque não existe campo no ERP que receba a ficha inteira. O que existe é
 * campo a campo e, na melhor das hipóteses, bloco a bloco — que é o recorte das
 * abas do próprio ERP. Um botão que copiasse tudo produziria um texto que
 * ninguém tem onde colar.
 */

const BLOCK_HINTS: Readonly<Record<string, string>> = {
  employer: "Confira se a empresa do ERP é esta antes de seguir.",
  personal: "Dados pessoais do cadastro.",
  documents: "Documentos conferidos por dígito verificador.",
  contract: "O que define o contrato no ERP.",
  fgtsPis: "FGTS, PIS e dados bancários.",
};

function statusLabel(status: SheetField["status"]) {
  return status === "blank" ? "Em branco no registro" : "Não foi possível ler";
}

type FieldSuggestion = { value: string; confidence: "ok" | "low"; sourceFilename: string };

/**
 * Uma foto pode render mais de uma sugestão para o mesmo campo (RG e CTPS
 * às vezes repetem o CPF, por exemplo) — junta todas por campo, mais
 * confiantes primeiro, para a tela oferecer sem escolher por quem transcreve.
 */
function suggestionsByField(photoSuggestions: readonly PhotoOcrSuggestion[] | undefined) {
  const byField = new Map<string, FieldSuggestion[]>();
  for (const photo of photoSuggestions ?? []) {
    for (const [key, field] of Object.entries(photo.fields)) {
      const list = byField.get(key) ?? [];
      list.push({ value: field.value, confidence: field.confidence, sourceFilename: photo.sourceFilename });
      byField.set(key, list);
    }
  }
  for (const list of byField.values()) list.sort((first) => (first.confidence === "ok" ? -1 : 1));
  return byField;
}

function FieldRow({
  field, provenance, onCopy, copiedKey, canEdit, onEdit, checked, onToggleChecked, suggestions, onUseSuggestion,
}: {
  field: SheetField;
  provenance: FieldProvenance | undefined;
  onCopy: (field: SheetField) => void;
  copiedKey: string;
  canEdit: boolean;
  onEdit: (field: SheetField) => void;
  checked: boolean;
  onToggleChecked: (key: string) => void;
  suggestions?: FieldSuggestion[];
  onUseSuggestion: (field: SheetField, value: string) => void;
}) {
  const ready = field.status === "ok";
  const source = provenance?.source ?? "document";

  /* Teclado: C copia, V (ou espaço) marca conferido.
     
     A transcrição é uma sequência longa de campo → ERP → campo, e tirar a mão
     do teclado a cada um é o que faz quem transcreve abandonar a conferência no
     meio. O atalho só vale com o foco na linha, e não quando está dentro de um
     campo de texto — senão digitar "c" num formulário copiaria algo. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!ready) return;
    const pressed = event.key.toLowerCase();
    if (pressed === "c") { event.preventDefault(); onCopy(field); }
    if (pressed === "v" || pressed === " ") { event.preventDefault(); onToggleChecked(field.key); }
  };

  return (
    <div className={styles.field} data-status={field.status} data-source={source}
      data-checked={checked || undefined}
      tabIndex={ready ? 0 : -1} onKeyDown={onKeyDown}
      aria-label={ready ? `${field.label}: ${field.value}${checked ? " — conferido" : ""}` : undefined}>
      <dt>
        {field.label}
        {/* A origem fica junto do rótulo porque muda a confiança: um CPF lido do
            documento tem o arquivo ao lado para conferir; um digitado por um
            colega tem uma pessoa e uma data. */}
        {ready && <span className={styles.sourceTag}>{FIELD_SOURCE_LABELS[source]}</span>}
      </dt>
      <dd>
        {ready
          ? <span className={styles.value}>{field.value}</span>
          : <span className={styles.missing}><TriangleAlert aria-hidden="true" />{statusLabel(field.status)}</span>}
        <span className={styles.fieldActions}>
          {ready && (
            <button type="button" className={styles.copyField} onClick={() => onCopy(field)}
              aria-label={`Copiar ${field.label}`}>
              <Copy aria-hidden="true" />{copiedKey === field.key ? "Copiado" : "Copiar"}
            </button>
          )}
          {ready && (
            <button type="button" className={styles.checkField} aria-pressed={checked}
              onClick={() => onToggleChecked(field.key)}
              aria-label={`Marcar ${field.label} como conferido`}>
              <Check aria-hidden="true" />{checked ? "Conferido" : "Conferir"}
            </button>
          )}
          {canEdit && (
            <button type="button" className={styles.copyField} onClick={() => onEdit(field)}
              aria-label={`${ready ? "Corrigir" : "Preencher"} ${field.label}`}>
              <Pencil aria-hidden="true" />{ready ? "Corrigir" : "Preencher"}
            </button>
          )}
        </span>
      </dd>
      {!ready && <p className={styles.note}>{field.note}</p>}
      {/* Sugestão do OCR de foto: nunca preenche sozinha. O botão abre o mesmo
          formulário de correção manual já usado para preencher à mão, só com
          o valor lido pré-carregado — quem transcreve ainda confere e salva. */}
      {!ready && canEdit && suggestions && suggestions.length > 0 && (
        <div className={styles.note}>
          {suggestions.map((suggestion) => (
            <p key={`${suggestion.sourceFilename}:${suggestion.value}`}>
              Sugestão lida em <b>{suggestion.sourceFilename}</b>: <b>{suggestion.value}</b>
              {suggestion.confidence === "low" ? " (conferir com atenção — leitura de texto livre)" : ""}
              {" "}
              <button type="button" className={styles.copyField} onClick={() => onUseSuggestion(field, suggestion.value)}>
                <Pencil aria-hidden="true" />Usar sugestão
              </button>
            </p>
          ))}
        </div>
      )}
      {/* Corrigir não apaga o que o documento disse — mostra os dois. */}
      {provenance?.source === "manual" && provenance.documentValue && (
        <p className={styles.note}>
          O documento dizia <b>{provenance.documentValue}</b>
          {provenance.by ? ` · corrigido por ${provenance.by}` : ""}
        </p>
      )}
    </div>
  );
}

/**
 * O que a tela mostra quando ainda não há campos.
 *
 * Três situações, três instruções. Antes as três apareciam como "nenhuma ficha
 * lida" — o que mandava a pessoa clicar em "Ler a ficha" durante uma leitura em
 * curso, e não dizia nada a quem tinha um PDF que o leitor não entende.
 */
function PreparationState({ state, payload }: { state: SheetPreparationState; payload: SheetPayload | null }) {
  if (state === "pending") {
    return (
      <div className={styles.empty}>
        <strong>Preparando a ficha…</strong>
        <p>
          O documento chegou e está sendo lido. Isso acontece sozinho depois da transferência —
          não é preciso clicar em nada. Atualize em instantes.
          {payload?.attempts ? ` Tentativa ${payload.attempts} de ${payload.maxAttempts ?? 3}.` : ""}
        </p>
      </div>
    );
  }
  if (state === "failed") {
    return (
      <div className={styles.empty} data-tone="failed">
        <strong>Não foi possível ler a ficha</strong>
        <p>{payload?.errorMessage || "A leitura não pôde ser concluída."}</p>
        <p>
          O documento continua anexado à demanda e pode ser conferido à mão. Reler não baixa nada de novo:
          o arquivo já está guardado aqui.
        </p>
      </div>
    );
  }
  return (
    <div className={styles.empty}>
      <strong>Nenhuma ficha ainda</strong>
      <p>
        Traga os arquivos com <b>Autorizar anexos da Sólides</b> na aba de anexos. Assim que o PDF chegar,
        a ficha é preparada sozinha. Os valores ficam cifrados e são apagados quando a demanda é concluída.
      </p>
    </div>
  );
}

export type SheetDocument = { id: string; filename: string; contentType?: string; downloadUrl: string };

function inlineDocumentUrl(document: SheetDocument) {
  return `${document.downloadUrl}${document.downloadUrl.includes("?") ? "&" : "?"}disposition=inline`;
}

function isImageDocument(document: SheetDocument) {
  return document.contentType?.startsWith("image/") || /\.(?:jpe?g|png|webp)$/iu.test(document.filename);
}

/** Rótulo ausente já aparece no campo como "Em branco"; aqui basta resumir. */
function WarningSummary({ warnings }: { warnings: readonly string[] }) {
  const unique = [...new Set(warnings)];
  const missingLabels = unique.filter((warning) => warning.startsWith("Rótulo não encontrado no documento:"));
  const actionable = unique.filter((warning) => !warning.startsWith("Rótulo não encontrado no documento:"));
  if (!unique.length) return null;
  return (
    <section className={styles.warnings} aria-labelledby="registration-sheet-warnings">
      <h4 id="registration-sheet-warnings">Pendências para conferência</h4>
      {missingLabels.length > 0 && (
        <p>
          {missingLabels.length} {missingLabels.length === 1 ? "campo não aparece" : "campos não aparecem"} na ficha da Sólides.
          Eles já estão identificados acima como <b>Em branco no registro</b>; confira nas fotos dos documentos.
        </p>
      )}
      {actionable.length > 0 && <ul>{actionable.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
    </section>
  );
}

/**
 * As cinco etapas do trabalho dentro da demanda.
 *
 * Elas existem para responder "em que pé isto está?" sem abrir três abas. A
 * última não é derivada de nada que a máquina observe: só a confirmação de uma
 * pessoa move para `cadastrada`, porque só ela sabe se o ERP salvou.
 */
const STEPS = [
  { key: "documents", label: "Aguardando documentos" },
  { key: "preparing", label: "Preparando ficha" },
  { key: "review", label: "Aguardando conferência" },
  { key: "ready", label: "Pronta para cadastro" },
  { key: "registered", label: "Cadastro confirmado" },
] as const;

/**
 * Marcas de conferência: estado pessoal de quem transcreve, no navegador.
 *
 * Copiar, conferir e cadastrar são três coisas distintas. `copiado` é
 * transitório; `cadastrado` é registro compartilhado e auditado, e vive no
 * banco; `conferido` fica no meio — é o risco que a pessoa marca para si
 * enquanto compara campo e documento, e não uma afirmação sobre o trabalho dos
 * outros. Guardá-lo no servidor faria a marca de um colega parecer conferência
 * feita, que é exatamente a confusão que estes três estados evitam.
 */
function useCheckedFields(cardId: string) {
  const storageKey = `vinculato:ficha-conferida:${cardId}`;
  /* Leitura na inicialização preguiçosa, e não num efeito: a aba é montada com
     `key` no cartão, então cada pessoa é uma instância nova — e escrever estado
     dentro do efeito encadearia uma renderização a mais em toda abertura.
     
     Navegador anônimo ou armazenamento bloqueado caem no conjunto vazio: a
     ficha funciona sem as marcas, e fingir que salvou seria pior que não
     oferecer. */
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const saved = window.localStorage.getItem(storageKey);
      return new Set(saved ? JSON.parse(saved) as string[] : []);
    } catch {
      return new Set();
    }
  });

  const toggle = useCallback((key: string) => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { window.localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* sem persistência */ }
      return next;
    });
  }, [storageKey]);

  return { checked, toggle };
}

export function RegistrationSheetPanel({ cardId, canBuild, canRead, archived, pdfUrl, documents = [] }: {
  cardId: string;
  canBuild: boolean;
  canRead: boolean;
  archived: boolean;
  pdfUrl: string | null;
  /** Os demais documentos da pessoa, para conferir sem trocar de aba. */
  documents?: readonly SheetDocument[];
}) {
  const [sheet, setSheet] = useState<RegistrationSheet | null>(null);
  const [preparation, setPreparation] = useState<SheetPayload | null>(null);
  const [loading, setLoading] = useState(canRead);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copiedKey, setCopiedKey] = useState("");
  const [editing, setEditing] = useState<SheetField | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [registration, setRegistration] = useState("");
  const [expanded, setExpanded] = useState(false);
  const { checked, toggle: toggleChecked } = useCheckedFields(cardId);

  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [expanded]);

  /**
   * A primeira leitura acontece no efeito, e nenhum `setState` roda de forma
   * síncrona dentro dele: `loading` já nasce verdadeiro, e todo o resto só é
   * escrito depois do `await`. Chamar `setLoading(true)` aqui encadearia uma
   * renderização a mais em toda abertura da aba, sem mudar nada na tela.
   *
   * Trocar de demanda não recarrega: a aba é montada com `key` no cartão, então
   * outra pessoa é outra instância, com estado limpo. É o que impede a ficha de
   * uma pessoa aparecer por um quadro na demanda de outra.
   */
  useEffect(() => {
    if (!canRead) return;
    let cancelled = false;
    void (async () => {
      try {
        const payload = await requestSheet<SheetPayload>(`/api/cards/${cardId}/registration-sheet`);
        if (!cancelled) { setSheet(payload.sheet); setPreparation(payload); }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Não foi possível ler a ficha.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [cardId, canRead]);

  async function build() {
    setBusy(true);
    setError("");
    try {
      const payload = await requestSheet<SheetPayload>(`/api/cards/${cardId}/registration-sheet`, { method: "POST" });
      setSheet(payload.sheet);
      setPreparation(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível ler a ficha.");
    } finally {
      setBusy(false);
    }
  }

  async function purge() {
    setBusy(true);
    setError("");
    try {
      await requestSheet(`/api/cards/${cardId}/registration-sheet`, { method: "DELETE" });
      setSheet(null);
      setPreparation(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível apagar a ficha.");
    } finally {
      setBusy(false);
    }
  }

  async function saveField(key: string, value: string) {
    setBusy(true);
    setError("");
    try {
      await requestSheet(`/api/cards/${cardId}/registration-sheet`, {
        method: "PATCH", body: JSON.stringify({ fields: { [key]: value } }),
      });
      setEditing(null);
      const payload = await requestSheet<SheetPayload>(`/api/cards/${cardId}/registration-sheet`);
      setSheet(payload.sheet);
      setPreparation(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível salvar o campo.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmRegistration() {
    setBusy(true);
    setError("");
    try {
      await requestSheet(`/api/cards/${cardId}/registration-sheet/confirm`, {
        method: "POST", body: JSON.stringify({ erpRegistration: registration.trim() }),
      });
      setConfirming(false);
      const payload = await requestSheet<SheetPayload>(`/api/cards/${cardId}/registration-sheet`);
      setSheet(payload.sheet);
      setPreparation(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível registrar o cadastro.");
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(""), 1500);
    } catch {
      // Dizer "copiado" quando não copiou é pior que não dizer nada: o valor
      // está à vista e dá para selecionar à mão.
      setError("O navegador bloqueou a cópia automática. Selecione o valor e copie manualmente.");
    }
  }

  function copyBlock(block: SheetBlock) {
    const text = block.fields.filter((field) => field.status === "ok")
      .map((field) => `${field.label}: ${field.value}`).join("\n");
    if (text) void copy(text, `block:${block.block}`);
  }

  if (!canRead) {
    return (
      <section className={styles.panel}>
        <div className={styles.empty}>
          <strong>Sem permissão para ler a ficha</strong>
          <p>Ver os anexos e ler os documentos transcritos são permissões separadas. Fale com o administrador do grupo.</p>
        </div>
      </section>
    );
  }

  const photoSuggestions = suggestionsByField(preparation?.photoSuggestions);

  return (
    <section className={styles.panel} data-expanded={expanded || undefined} aria-labelledby="registration-sheet-title">
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>FICHA DE CONTRATAÇÃO</span>
          <h3 id="registration-sheet-title">Campos prontos para o ERP</h3>
          <p>
            {loading
              ? "Carregando…"
              : sheet
                ? `${sheet.readable} campos prontos; ${Math.max(0, sheet.blocks.reduce((total, block) => total + block.fields.length, 0) - sheet.readable)} precisam ser preenchidos ou conferidos.`
                : "A ficha ainda não foi lida. O Registro de Empregado precisa estar anexado à demanda."}
          </p>
        </div>
        <div className={styles.actions}>
          {pdfUrl && (
            <a className={styles.secondary}
              href={`${pdfUrl}${pdfUrl.includes("?") ? "&" : "?"}disposition=inline`}
              target="_blank" rel="noreferrer">
              <FileText aria-hidden="true" /> Ficha da Sólides
            </a>
          )}
          {sheet && (
            <a className={styles.primary} href={`/api/cards/${cardId}/registration-sheet/pdf`}>
              <Download aria-hidden="true" /> Emitir ficha Vinculato
            </a>
          )}
          {sheet && (
            <button type="button" className={styles.secondary} onClick={() => setExpanded((current) => !current)}
              aria-pressed={expanded}>
              {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
              {expanded ? "Sair da tela cheia" : "Ver em tela cheia"}
            </button>
          )}
          {canBuild && !archived && (
            <button type="button" className={styles.primary} onClick={() => void build()} disabled={busy || loading}>
              {busy ? <LoaderCircle aria-hidden="true" className={styles.spin} /> : <RefreshCw aria-hidden="true" />}
              {busy ? "Lendo…" : sheet ? "Reler a ficha" : "Ler a ficha"}
            </button>
          )}
          {canBuild && sheet && !archived && (
            <button type="button" className={styles.danger} onClick={() => void purge()} disabled={busy}>
              <Trash2 aria-hidden="true" /> Apagar
            </button>
          )}
        </div>
      </header>

      {/* Em que pé está o trabalho. A última etapa não é observada pela
          máquina: só a confirmação de uma pessoa move para "cadastrada",
          porque só ela sabe se o ERP salvou. */}
      {!loading && (
        <ol className={styles.steps} aria-label="Etapas da admissão">
          {STEPS.map((step, index) => {
            const current = preparation?.confirmation ? 4
              : preparation?.state === "ready"
                ? (sheet && sheet.readable === sheet.filled ? 3 : 2)
                : preparation?.state === "pending" ? 1
                  : preparation?.state === "failed" ? 2 : 0;
            return (
              <li key={step.key} data-state={index < current ? "done" : index === current ? "current" : "todo"}
                aria-current={index === current ? "step" : undefined}>
                <span>{step.label}</span>
              </li>
            );
          })}
        </ol>
      )}

      {error && <p className={styles.alert} role="alert">{error}</p>}

      {!loading && !sheet && <PreparationState state={preparation?.state ?? "absent"} payload={preparation} />}

      {sheet?.blocks.map((block) => {
        const ready = block.fields.filter((field) => field.status === "ok").length;
        return (
          <article key={block.block} className={styles.block}>
            <header>
              <div>
                <strong>{block.label}</strong>
                <small>{BLOCK_HINTS[block.block] ?? ""}</small>
              </div>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => copyBlock(block)}
                disabled={ready === 0}
                aria-label={`Copiar os campos conferidos de ${block.label}`}
              >
                <Copy aria-hidden="true" />
                {copiedKey === `block:${block.block}` ? "Copiado" : `Copiar ${ready}`}
              </button>
            </header>
            <dl className={styles.fields}>
              {block.fields.map((field) => (
                <FieldRow
                  key={field.key}
                  field={field}
                  provenance={sheet?.provenance?.[field.key]}
                  copiedKey={copiedKey}
                  canEdit={canBuild && !archived && !preparation?.confirmation}
                  checked={checked.has(field.key)}
                  onToggleChecked={toggleChecked}
                  onCopy={(target) => void copy(target.value, target.key)}
                  onEdit={(target) => { setEditing(target); setDraft(target.value); }}
                  suggestions={photoSuggestions.get(field.key)}
                  onUseSuggestion={(target, value) => { setEditing(target); setDraft(value); }}
                />
              ))}
            </dl>
          </article>
        );
      })}

      {sheet && <WarningSummary warnings={sheet.warnings} />}

      {/* Divergência de identidade fica ANTES dos campos: quem transcreve
          precisa ver isso antes de copiar qualquer coisa, e não depois. */}
      {(preparation?.divergences?.length ?? 0) > 0 && (
        <section className={styles.divergences} role="alert">
          <h4><ShieldAlert aria-hidden="true" /> O documento pode não ser desta pessoa</h4>
          <ul>{preparation?.divergences?.map((item) => <li key={item.field}><b>{item.label}:</b> {item.detail}</li>)}</ul>
          <p>
            O preenchimento pelo cadastro foi suspenso. Confira o arquivo antes de usar qualquer campo —
            anexar dados de outra pessoa a esta admissão é o erro mais difícil de perceber depois.
          </p>
        </section>
      )}

      {/* Confirmação do cadastro: é ela que conclui a demanda. Copiar não conclui. */}
      {sheet && (preparation?.confirmation ? (
        <section className={styles.confirmed}>
          <strong><BadgeCheck aria-hidden="true" /> Cadastrado no Sankhya</strong>
          <p>
            Matrícula <b>{preparation.confirmation.erpRegistration}</b> · registrado por {preparation.confirmation.confirmedBy}
          </p>
        </section>
      ) : canBuild && !archived && (
        <section className={styles.confirmBox}>
          {confirming ? (
            <form onSubmit={(event) => { event.preventDefault(); void confirmRegistration(); }}>
              <label htmlFor="erp-registration">Matrícula ou identificador gerado pelo Sankhya</label>
              <div>
                <input id="erp-registration" value={registration} maxLength={60} required
                  onChange={(event) => setRegistration(event.target.value)} placeholder="Ex.: 549" />
                <button type="submit" className={styles.primary} disabled={busy || !registration.trim()}>
                  {busy ? "Registrando…" : "Confirmar cadastro"}
                </button>
                <button type="button" className={styles.secondary} onClick={() => setConfirming(false)}>Cancelar</button>
              </div>
              <small>
                A demanda só é concluída por esta confirmação. Copiar os campos não prova que o ERP salvou.
                A ficha fica disponível por 30 dias para conferência e depois é apagada.
              </small>
            </form>
          ) : (
            <button type="button" className={styles.primary} onClick={() => setConfirming(true)}>
              <BadgeCheck aria-hidden="true" /> Já cadastrei no Sankhya
            </button>
          )}
        </section>
      ))}

      {editing && (
        <div className={styles.editBox} role="dialog" aria-label={`Editar ${editing.label}`}>
          <form onSubmit={(event) => { event.preventDefault(); void saveField(editing.key, draft.trim()); }}>
            <label htmlFor="sheet-field-draft">{editing.label}</label>
            <div>
              <input id="sheet-field-draft" value={draft} maxLength={220} autoFocus
                onChange={(event) => setDraft(event.target.value)} />
              <button type="submit" className={styles.primary} disabled={busy || !draft.trim()}>Salvar</button>
              <button type="button" className={styles.secondary} onClick={() => setEditing(null)}>Cancelar</button>
            </div>
            <small>O valor lido do documento continua guardado e aparece ao lado da sua correção.</small>
          </form>
        </div>
      )}

      {/* Os documentos que sustentam os campos, à mão.

          A leitura por OCR das fotos (RG, CPF, CTPS) vira sugestão nos campos
          em branco acima — nunca substitui o valor sozinha, porque o layout
          de uma foto varia e o OCR erra mais que a leitura do PDF. O papel
          destes arquivos continua sendo a conferência visual, e por isso eles
          seguem aqui, e não em outra aba. */}
      {sheet && documents.length > 0 && (
        <section className={styles.documents}>
          <h4>Documentos desta pessoa</h4>
          <p>As fotos ficam visíveis aqui para conferir RG, CPF e CTPS sem sair da ficha.</p>
          {documents.some(isImageDocument) && (
            <div className={styles.photoGrid}>
              {documents.filter(isImageDocument).map((document) => (
                <a key={document.id} className={styles.photoCard} href={inlineDocumentUrl(document)}
                  target="_blank" rel="noreferrer">
                  <Image src={inlineDocumentUrl(document)} alt={`Documento ${document.filename}`}
                    width={520} height={360} unoptimized />
                  <span><ImageIcon aria-hidden="true" />{document.filename}</span>
                </a>
              ))}
            </div>
          )}
          <ul>
            {documents.filter((document) => !isImageDocument(document)).map((document) => (
              <li key={document.id}>
                <a href={inlineDocumentUrl(document)} target="_blank" rel="noreferrer">
                  <FileText aria-hidden="true" />{document.filename}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sheet?.sourceFilename && (
        <p className={styles.source}>Lida de <b>{sheet.sourceFilename}</b>. Confira no arquivo antes de concluir a admissão.</p>
      )}
    </section>
  );
}
