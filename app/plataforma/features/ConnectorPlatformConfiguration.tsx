"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Save, ShieldCheck } from "lucide-react";
import styles from "../platform.module.css";
import { Row, Status, text } from "./core";

/**
 * Configuração dos conectores que não são o Sankhya, no console da plataforma.
 *
 * Até aqui só o Sankhya tinha configuração aqui: os outros nove conectores
 * abriam um painel somente leitura, e nada na tela dizia que a configuração
 * existia em outro lugar. Quem administra a plataforma encontrava um beco.
 *
 * ## A tela não conhece os campos — ela pergunta
 *
 * `connectorFields` vem do servidor, do mesmo módulo que valida a gravação. Uma
 * lista mantida aqui envelheceria sozinha, e o sintoma seria mudo: a pessoa
 * preenche um campo que o servidor descarta sem erro nenhum, e descobre semanas
 * depois que a configuração nunca chegou.
 *
 * ## O formulário nasce preenchido
 *
 * Gravar substitui o `config_json` inteiro. Um formulário em branco sobre um
 * conector já configurado apagaria tudo que a pessoa não redigitasse — e o
 * estrago só apareceria na próxima sincronização.
 */

export type ConnectorField = {
  key: string; label: string; hint: string;
  kind: "text" | "url" | "date" | "number" | "toggles";
  options?: string[];
};

type Props = {
  integration: Row;
  configuration: Row;
  fields: ConnectorField[];
  automationLabels: Record<string, string>;
  companies: Row[];
  onSend: (kind: string, payload: Row, reason: string) => Promise<void>;
};

const inputType = (kind: ConnectorField["kind"]) =>
  kind === "url" ? "url" : kind === "date" ? "date" : kind === "number" ? "number" : "text";

export function ConnectorPlatformConfiguration({ integration, configuration, fields, automationLabels, companies, onSend }: Props) {
  const displayName = text(integration.display_name);
  const initial = useMemo(() => {
    /* A semente começa pelo que está gravado, inteiro — e não só pelos campos
       que este formulário desenha. `requestBody` é o caso concreto: ele existe
       no `config_json`, é aceito pelo servidor e não tem campo aqui. Semear só
       o desenhado faria a gravação devolver um objeto sem ele, e o corpo
       configurado do conector sumiria sem ninguém ter pedido — um apagamento
       silencioso que só apareceria na sincronização seguinte. */
    const seed: Row = { ...configuration, displayName };
    for (const field of fields) {
      if (field.kind === "toggles") {
        const stored = (configuration[field.key] ?? {}) as Row;
        seed[field.key] = Object.fromEntries((field.options ?? []).map((key) => [key, stored[key] !== false]));
      } else {
        seed[field.key] = text(configuration[field.key]);
      }
    }
    return seed;
  }, [configuration, fields, displayName]);

  const [values, setValues] = useState<Row>(initial);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const reasonValid = reason.trim().length >= 5;

  const set = (key: string, value: unknown) => setValues((current) => ({ ...current, [key]: value }));

  function save(event: FormEvent) {
    event.preventDefault();
    setPending(true); setFailure("");
    void (async () => {
      try { await onSend("configure_connector", values, reason); }
      catch (cause) { setFailure(cause instanceof Error ? cause.message : "Não foi possível gravar a configuração."); }
      finally { setPending(false); }
    })();
  }

  if (!fields.length) return null;

  return <section className={styles.detailSection} aria-labelledby="connector-platform-config">
    <div className={styles.detailSectionHeader}>
      <h3 id="connector-platform-config">Configuração do conector</h3>
      <Status value={text(integration.status)} />
    </div>
    <div className={styles.sankhyaAdminIntro}><ShieldCheck aria-hidden="true" /><div>
      <strong>Gravação administrativa sobre dado de cliente</strong>
      {/* Por que o status cai. Trocar endereço ou destino invalida o que já foi
          conectado: manter "conectado" faria a tela afirmar uma conexão que
          ninguém provou existir contra o endereço novo. */}
      <p>
        As mesmas regras do console do workspace, com motivo obrigatório e registro
        nas auditorias global e do workspace. Gravar substitui a configuração inteira e
        devolve o conector para <strong>aguardando credencial</strong> — é a conexão que
        volta a ser provada, não a configuração que se perde.
      </p>
    </div></div>
    {failure && <p className={styles.itemError}>{failure}</p>}

    <label className={styles.sankhyaReason}>
      <span>Motivo administrativo</span>
      <input required minLength={5} value={reason} onChange={(event) => setReason(event.target.value)}
        placeholder="Ex.: correção do endpoint após migração do cliente" />
    </label>

    <form className={styles.configForm} onSubmit={save}>
      <label className={styles.fullField}>
        <span>Nome exibido</span>
        <input value={text(values.displayName)} onChange={(event) => set("displayName", event.target.value)} />
      </label>

      {fields.map((field) => {
        if (field.kind === "toggles") {
          const stored = (values[field.key] ?? {}) as Row;
          return <fieldset key={field.key} className={styles.fullField}>
            <legend>{field.label}</legend>
            <p className={styles.detailSubtitle}>{field.hint}</p>
            {(field.options ?? []).map((option) => <label key={option} className={styles.confirmCheck}>
              <input type="checkbox" checked={stored[option] !== false}
                onChange={(event) => set(field.key, { ...stored, [option]: event.target.checked })} />
              <span>{automationLabels[option] ?? option}</span>
            </label>)}
          </fieldset>;
        }
        /* Empresa é escolha, não digitação: o servidor recusa identificador de
           outro workspace, e quem administra a plataforma atravessa clientes o
           dia inteiro — deixar digitar aqui é convidar o engano. */
        if (field.key === "companyId" && companies.length) {
          return <label key={field.key}>
            <span>{field.label}</span>
            <select value={text(values[field.key])} onChange={(event) => set(field.key, event.target.value)}>
              <option value="">Nenhuma</option>
              {companies.map((company) => <option key={text(company.id)} value={text(company.id)}>
                {text(company.trade_name) || text(company.legal_name)}
              </option>)}
            </select>
            <small className={styles.detailSubtitle}>{field.hint}</small>
          </label>;
        }
        return <label key={field.key} className={field.kind === "url" ? styles.fullField : undefined}>
          <span>{field.label}</span>
          <input type={inputType(field.kind)} value={text(values[field.key])}
            onChange={(event) => set(field.key, event.target.value)} />
          <small className={styles.detailSubtitle}>{field.hint}</small>
        </label>;
      })}

      <button type="submit" disabled={pending || !reasonValid}>
        <Save aria-hidden="true" />{pending ? "Gravando…" : "Salvar configuração"}
      </button>
    </form>
  </section>;
}
