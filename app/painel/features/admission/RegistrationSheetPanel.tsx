"use client";

import { useEffect, useState } from "react";
import { Copy, FileText, LoaderCircle, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { requestSheet, type RegistrationSheet, type SheetBlock, type SheetField } from "./admission.api";
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

function FieldRow({ field, onCopy, copiedKey }: {
  field: SheetField;
  onCopy: (field: SheetField) => void;
  copiedKey: string;
}) {
  const ready = field.status === "ok";
  return (
    <div className={styles.field} data-status={field.status}>
      <dt>{field.label}</dt>
      <dd>
        {ready
          ? <span className={styles.value}>{field.value}</span>
          : <span className={styles.missing}><TriangleAlert aria-hidden="true" />{statusLabel(field.status)}</span>}
        {ready && (
          <button
            type="button"
            className={styles.copyField}
            onClick={() => onCopy(field)}
            aria-label={`Copiar ${field.label}`}
          >
            <Copy aria-hidden="true" />
            {copiedKey === field.key ? "Copiado" : "Copiar"}
          </button>
        )}
      </dd>
      {!ready && <p className={styles.note}>{field.note}</p>}
    </div>
  );
}

export function RegistrationSheetPanel({ cardId, canBuild, canRead, archived, pdfUrl }: {
  cardId: string;
  canBuild: boolean;
  canRead: boolean;
  archived: boolean;
  pdfUrl: string | null;
}) {
  const [sheet, setSheet] = useState<RegistrationSheet | null>(null);
  const [loading, setLoading] = useState(canRead);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copiedKey, setCopiedKey] = useState("");

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
        const payload = await requestSheet<{ sheet: RegistrationSheet | null }>(`/api/cards/${cardId}/registration-sheet`);
        if (!cancelled) setSheet(payload.sheet);
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
      const payload = await requestSheet<{ sheet: RegistrationSheet }>(`/api/cards/${cardId}/registration-sheet`, { method: "POST" });
      setSheet(payload.sheet);
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível apagar a ficha.");
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

  return (
    <section className={styles.panel} aria-labelledby="registration-sheet-title">
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>FICHA DE CONTRATAÇÃO</span>
          <h3 id="registration-sheet-title">Campos prontos para o ERP</h3>
          <p>
            {loading
              ? "Carregando…"
              : sheet
                ? `${sheet.readable} de ${sheet.filled} campos preenchidos passaram na conferência.`
                : "A ficha ainda não foi lida. O Registro de Empregado precisa estar anexado à demanda."}
          </p>
        </div>
        <div className={styles.actions}>
          {pdfUrl && (
            <a className={styles.secondary} href={pdfUrl} target="_blank" rel="noreferrer">
              <FileText aria-hidden="true" /> Abrir o PDF
            </a>
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

      {error && <p className={styles.alert} role="alert">{error}</p>}

      {!loading && !sheet && (
        <div className={styles.empty}>
          <strong>Nenhuma ficha lida</strong>
          <p>
            Traga os arquivos com <b>Autorizar anexos da Sólides</b> na aba de anexos e depois use <b>Ler a ficha</b>.
            Os valores ficam cifrados e são apagados quando a demanda é concluída.
          </p>
        </div>
      )}

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
                <FieldRow key={field.key} field={field} copiedKey={copiedKey} onCopy={(target) => void copy(target.value, target.key)} />
              ))}
            </dl>
          </article>
        );
      })}

      {sheet && sheet.warnings.length > 0 && (
        <section className={styles.warnings} aria-labelledby="registration-sheet-warnings">
          <h4 id="registration-sheet-warnings">O que a leitura não resolveu</h4>
          {/* Os avisos nomeiam rótulos, nunca conteúdo — é o que permite
              guardá-los em coluna aberta ao lado do envelope cifrado. */}
          <ul>{sheet.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </section>
      )}

      {sheet?.sourceFilename && (
        <p className={styles.source}>Lida de <b>{sheet.sourceFilename}</b>. Confira no arquivo antes de concluir a admissão.</p>
      )}
    </section>
  );
}
