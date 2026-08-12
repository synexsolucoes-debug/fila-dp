"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertOctagon, Briefcase, CalendarClock, CircleDollarSign, History, LoaderCircle, Plus, RefreshCw, X,
} from "lucide-react";
import styles from "./registrations.module.css";

/**
 * Cadastro de prestador PJ.
 *
 * Responde as quatro perguntas que a operação faz sobre um PJ: quanto ele custa
 * por mês, quanto do contrato ainda sobra, o que se repete todo mês e o que já
 * mudou. Contrato por prazo determinado ganha barra de saldo porque nele existe
 * um fim em valor, não só em data — e é esse fim que costuma pegar de surpresa.
 */

type Balance = {
  type: "determinado" | "indeterminado";
  totalCents: number | null;
  consumedCents: number;
  remainingCents: number | null;
  usagePercent: number | null;
  exhausted: boolean;
};

type ContractorSummary = {
  id: string; code: string; legalName: string; tradeName: string; taxIdLast4: string;
  companyId: string; companyName: string; contractReference: string; roleTitle: string;
  contractType: "determinado" | "indeterminado"; contractStart: string | null; contractEnd: string | null;
  baseAmountCents: number; complementMethod: string; status: string; fixedItemCount: number; balance: Balance;
};

type FixedItem = {
  id: string; direction: "credit" | "debit"; componentType: string; description: string;
  amountCents: number; effectiveFrom: string; effectiveTo: string | null; status: string; note: string;
};

type Movement = {
  id: string; movementType: string; movementLabel: string; effectiveDate: string; title: string;
  reason: string; status: string; appliedAt: string | null; createdAt: string;
};

type Closing = {
  competence: string; status: string; netCents: number; invoiceCents: number;
  complementCents: number; cajuCents: number;
};

type Detail = {
  contractor: ContractorSummary & {
    taxIdMasked: string; email: string; phone: string; contractSignedAt: string | null;
    paymentDay: number | null; invoiceLimitCents: number | null; notes: string;
  };
  balance: Balance;
  fixedItems: FixedItem[];
  movements: Movement[];
  closings: Closing[];
  permissions: { manage: boolean };
};

const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const inputDate = (value: string | null | undefined) => String(value ?? "").slice(0, 10);
const day = (value: string | null) => {
  const normalized = inputDate(value);
  return normalized ? new Date(`${normalized}T12:00:00Z`).toLocaleDateString("pt-BR") : "—";
};

const statusLabels: Record<string, string> = {
  active: "Ativo", suspended: "Suspenso", inactive: "Encerrado",
  draft: "Rascunho", pending_approval: "Aguardando aprovação", approved: "Aprovada",
  rejected: "Recusada", applied: "Aplicada", canceled: "Cancelada", ended: "Encerrado",
};
const complementLabels: Record<string, string> = {
  none: "Sem complemento", caju_saldo_livre: "Caju Saldo Livre",
  other_benefit_card: "Outro cartão", manual_transfer: "Transferência",
};

async function send<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init, cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.message || payload.error || "Não foi possível concluir a operação.");
  return payload;
}

/** Barra de consumo do contrato. Só faz sentido onde existe teto. */
function BalanceBar({ balance }: { balance: Balance }) {
  if (balance.totalCents === null) {
    return (
      <p className={styles.infoNote}>
        Contrato por prazo indeterminado: não há valor global a consumir. O acompanhamento é pelo valor fixo mensal.
      </p>
    );
  }
  const percent = Math.min(balance.usagePercent ?? 0, 100);
  return (
    <div className={styles.detailBand}>
      <div><span>Contratado</span><strong>{money(balance.totalCents)}</strong></div>
      <div><span>Consumido</span><strong>{money(balance.consumedCents)}</strong></div>
      <div>
        <span>Saldo</span>
        <strong className={balance.exhausted ? styles.textDanger : undefined}>
          {money(balance.remainingCents ?? 0)}
        </strong>
        <progress max={100} value={percent} aria-label={`Contrato consumido: ${percent}%`} />
      </div>
    </div>
  );
}

export function ContractorsPanel({ canManage, createSignal }: { canManage: boolean; createSignal: number }) {
  const [list, setList] = useState<ContractorSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [editor, setEditor] = useState<"none" | "new" | "edit">("none");
  const [drawer, setDrawer] = useState<"none" | "fixed" | "movement">("none");
  const dialogRef = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await send<{ contractors: ContractorSummary[] }>("/api/registrations/contractors");
      setList(payload.contractors);
      setSelectedId((current) => current || payload.contractors[0]?.id || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar os prestadores.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    if (!id) { setDetail(null); return; }
    try {
      setDetail(await send<Detail>(`/api/registrations/contractors/${id}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível abrir o prestador.");
    }
  }, []);

  // A carga sai do corpo do efeito, como no resto do painel: `setLoading(true)`
  // durante a renderização é erro de fase, não de dado.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadList());
    return () => window.cancelAnimationFrame(frame);
  }, [loadList]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void loadDetail(selectedId));
    return () => window.cancelAnimationFrame(frame);
  }, [loadDetail, selectedId]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3800);
    return () => window.clearTimeout(timer);
  }, [toast]);
  // O botão de cadastrar da barra de comando é o mesmo desta tela. Sem esta
  // ligação ele viraria um aviso mandando usar outro botão — o tipo de botão
  // que existe sem fazer nada.
  useEffect(() => {
    if (createSignal <= 0 || !canManage) return;
    const frame = window.requestAnimationFrame(() => setEditor("new"));
    return () => window.cancelAnimationFrame(frame);
  }, [canManage, createSignal]);

  const selected = useMemo(() => list.find((row) => row.id === selectedId) ?? null, [list, selectedId]);

  async function mutate(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    try {
      await action();
      setToast(success);
      await loadList();
      await loadDetail(selectedId);
      setEditor("none");
      setDrawer("none");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível concluir a operação.");
    } finally {
      setBusy(false);
    }
  }

  function submitContractor(form: FormData) {
    const contractType = String(form.get("contractType") ?? "indeterminado");
    const body = {
      legalName: form.get("legalName"), tradeName: form.get("tradeName"), taxId: form.get("taxId"),
      email: form.get("email"), phone: form.get("phone"), companyId: form.get("companyId"),
      contractReference: form.get("contractReference"), roleTitle: form.get("roleTitle"),
      contractType,
      contractStart: form.get("contractStart"), contractEnd: form.get("contractEnd"),
      contractSignedAt: form.get("contractSignedAt"),
      // Valor global só existe no prazo determinado; mandar no outro caso seria
      // recusado pela API, e com razão.
      contractTotalAmount: contractType === "determinado" ? form.get("contractTotalAmount") : "",
      baseAmount: form.get("baseAmount"), invoiceLimitOverride: form.get("invoiceLimitOverride"),
      complementMethod: form.get("complementMethod"), paymentDay: form.get("paymentDay"),
      status: form.get("status"), notes: form.get("notes"),
    };
    const isNew = editor === "new";
    void mutate(
      () => send(isNew ? "/api/registrations/contractors" : `/api/registrations/contractors/${selectedId}`,
        { method: isNew ? "POST" : "PATCH", body: JSON.stringify(body) }),
      isNew ? "Prestador cadastrado." : "Cadastro atualizado.",
    );
  }

  const contractor = detail?.contractor;

  return (
    <div className={styles.masterDetail}>
      <aside className={styles.masterPane}>
        <header>
          <div><span>PRESTADORES PJ</span><strong>{list.length} contrato(s)</strong></div>
          <button type="button" onClick={() => void loadList()} disabled={busy} aria-label="Recarregar prestadores">
            <RefreshCw aria-hidden="true" />
          </button>
        </header>
        {loading ? (
          <p className={styles.loadingState}><LoaderCircle className={styles.spin} aria-hidden="true" /> Carregando…</p>
        ) : list.length === 0 ? (
          <p className={styles.emptyState}>
            Nenhum prestador PJ cadastrado. Cadastre para que ele entre na apuração e na exportação do complemento.
          </p>
        ) : (
          <div className={styles.companyList}>
            {list.map((row) => (
              <button
                key={row.id}
                type="button"
                className={`${styles.companyRow} ${row.id === selectedId ? styles.selectedRow : ""}`}
                onClick={() => setSelectedId(row.id)}
                aria-current={row.id === selectedId}
              >
                <span className={row.contractType === "determinado" ? styles.branchMark : styles.principalMark}>
                  <Briefcase aria-hidden="true" />
                </span>
                <span>
                  <strong>{row.tradeName || row.legalName}</strong>
                  <small>{row.companyName} · {money(row.baseAmountCents)}/mês</small>
                </span>
                <span className={styles.statusPill} data-status={row.status}>{statusLabels[row.status] ?? row.status}</span>
              </button>
            ))}
          </div>
        )}
      </aside>

      <section className={styles.detailPane}>
        {error && <p className={styles.errorBanner} role="alert"><AlertOctagon aria-hidden="true" /> {error}</p>}

        <header>
          <div className={styles.companyIdentity}>
            <span><Briefcase aria-hidden="true" /></span>
            <div>
              <small>{contractor ? (contractor.contractType === "determinado" ? "PRAZO DETERMINADO" : "PRAZO INDETERMINADO") : "PRESTADOR PJ"}</small>
              <h2>{contractor?.tradeName || contractor?.legalName || "Selecione um prestador"}</h2>
              <p>{contractor ? `${contractor.companyName} · ${contractor.contractReference || "sem contrato de referência"}` : ""}</p>
            </div>
          </div>
          {canManage && (
            <div className={styles.filters}>
              {selected && (
                <button type="button" className={styles.secondaryButton} onClick={() => setEditor("edit")} disabled={busy}>
                  Editar contrato
                </button>
              )}
            </div>
          )}
        </header>

        {!contractor ? (
          <p className={styles.emptyState}>Escolha um prestador na lista para ver contrato, saldo e movimentação.</p>
        ) : (
          <>
            <section className={styles.detailSection}>
              <h3><CircleDollarSign aria-hidden="true" /> Contrato e saldo</h3>
              <BalanceBar balance={detail.balance} />
              <dl>
                <div><dt>Valor fixo mensal</dt><dd>{money(contractor.baseAmountCents)}</dd></div>
                <div><dt>Vigência</dt><dd>{day(contractor.contractStart)} → {contractor.contractEnd ? day(contractor.contractEnd) : "sem término"}</dd></div>
                <div><dt>Complemento</dt><dd>{complementLabels[contractor.complementMethod] ?? contractor.complementMethod}</dd></div>
                <div><dt>Limite da nota</dt><dd>{contractor.invoiceLimitCents === null ? "pela política" : money(contractor.invoiceLimitCents)}</dd></div>
                <div><dt>Documento</dt><dd className={styles.mono}>{contractor.taxIdMasked || "—"}</dd></div>
                <div><dt>Dia de pagamento</dt><dd>{contractor.paymentDay ?? "—"}</dd></div>
              </dl>
            </section>

            <section className={styles.detailSection}>
              <h3><CalendarClock aria-hidden="true" /> Valores fixos recorrentes</h3>
              {detail.fixedItems.length === 0 ? (
                <p className={styles.infoNote}>
                  Nenhum valor recorrente. Lance aqui o que se repete todo mês — ele entra sozinho em cada competência
                  enquanto estiver vigente.
                </p>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col">Descrição</th><th scope="col">Direção</th><th scope="col">Valor</th>
                        <th scope="col">Vigência</th><th scope="col">Situação</th>
                        {canManage && <th scope="col">Ações</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {detail.fixedItems.map((item) => (
                        <tr key={item.id}>
                          <th scope="row">{item.description || item.componentType}<small>{item.componentType}</small></th>
                          <td>{item.direction === "credit" ? "Crédito" : "Desconto"}</td>
                          <td className={item.direction === "debit" ? styles.textDanger : undefined}>{money(item.amountCents)}</td>
                          <td>{item.effectiveFrom} → {item.effectiveTo ?? "sem fim"}</td>
                          <td><span className={styles.statusPill} data-status={item.status}>{statusLabels[item.status] ?? item.status}</span></td>
                          {canManage && (
                            <td>
                              {item.status === "active" && (
                                <button
                                  type="button"
                                  className={styles.secondaryButton}
                                  disabled={busy}
                                  onClick={() => {
                                    const competence = window.prompt(
                                      "Encerrar a partir de qual competência? (AAAA-MM)\n\nO valor deixa de entrar nas competências seguintes; as já apuradas continuam como estão.",
                                      new Date().toISOString().slice(0, 7));
                                    if (!competence) return;
                                    void mutate(
                                      () => send(`/api/registrations/contractors/${selectedId}/fixed-items/${item.id}`,
                                        { method: "PATCH", body: JSON.stringify({ effectiveTo: competence }) }),
                                      "Valor recorrente encerrado.");
                                  }}
                                >
                                  Encerrar
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {canManage && (
                <button type="button" className={styles.secondaryButton} onClick={() => setDrawer("fixed")} disabled={busy}>
                  <Plus aria-hidden="true" /> Novo valor recorrente
                </button>
              )}
            </section>

            <section className={styles.detailSection}>
              <h3><History aria-hidden="true" /> Movimentação</h3>
              {detail.movements.length === 0 ? (
                <p className={styles.infoNote}>
                  Nenhuma movimentação registrada. Reajuste, prorrogação, suspensão e encerramento passam por aqui —
                  com data de vigência, autor e motivo.
                </p>
              ) : (
                <ol className={styles.historyTrail}>
                  {detail.movements.map((movement) => (
                    <li key={movement.id}>
                      <div>
                        <strong>{movement.title}</strong>
                        <small>{movement.movementLabel} · vigência {day(movement.effectiveDate)}</small>
                        {movement.reason && <p>{movement.reason}</p>}
                      </div>
                      <span className={styles.statusPill} data-status={movement.status}>
                        {statusLabels[movement.status] ?? movement.status}
                      </span>
                      {canManage && movement.status !== "applied" && movement.status !== "canceled" && (
                        <div className={styles.filters}>
                          {movement.status === "draft" && (
                            <button type="button" className={styles.secondaryButton} disabled={busy}
                              onClick={() => void mutate(() => send(`/api/registrations/contractors/${selectedId}/movements/${movement.id}`,
                                { method: "POST", body: JSON.stringify({ status: "pending_approval" }) }), "Enviada para aprovação.")}>
                              Enviar para aprovação
                            </button>
                          )}
                          {movement.status === "pending_approval" && (
                            <button type="button" className={styles.secondaryButton} disabled={busy}
                              onClick={() => void mutate(() => send(`/api/registrations/contractors/${selectedId}/movements/${movement.id}`,
                                { method: "POST", body: JSON.stringify({ status: "approved" }) }), "Movimentação aprovada.")}>
                              Aprovar
                            </button>
                          )}
                          {movement.status === "approved" && (
                            <button type="button" className={styles.primaryButton} disabled={busy}
                              onClick={() => void mutate(() => send(`/api/registrations/contractors/${selectedId}/movements/${movement.id}`,
                                { method: "POST", body: JSON.stringify({ status: "applied" }) }),
                                "Movimentação aplicada ao contrato.")}>
                              Aplicar ao contrato
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              {canManage && (
                <button type="button" className={styles.secondaryButton} onClick={() => setDrawer("movement")} disabled={busy}>
                  <Plus aria-hidden="true" /> Registrar movimentação
                </button>
              )}
            </section>

            {detail.closings.length > 0 && (
              <section className={styles.detailSection}>
                <h3><CircleDollarSign aria-hidden="true" /> Competências apuradas</h3>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col">Competência</th><th scope="col">Líquido</th><th scope="col">Nota</th>
                        <th scope="col">Complemento</th><th scope="col">Situação</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.closings.map((row) => (
                        <tr key={row.competence}>
                          <th scope="row">{row.competence}</th>
                          <td>{money(row.netCents)}</td>
                          <td>{money(row.invoiceCents)}</td>
                          <td>{money(row.complementCents)}{row.cajuCents > 0 && <small>Caju {money(row.cajuCents)}</small>}</td>
                          <td><span className={styles.statusPill} data-status={row.status}>{row.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
      </section>

      {editor !== "none" && (
        <ContractorEditor
          mode={editor}
          current={editor === "edit" ? detail?.contractor ?? null : null}
          busy={busy}
          onClose={() => setEditor("none")}
          onSubmit={submitContractor}
          dialogRef={dialogRef}
        />
      )}

      {drawer === "fixed" && selectedId && (
        <FixedItemDrawer
          busy={busy}
          onClose={() => setDrawer("none")}
          onSubmit={(form) => void mutate(
            () => send(`/api/registrations/contractors/${selectedId}/fixed-items`, {
              method: "POST",
              body: JSON.stringify({
                componentType: form.get("componentType"),
                description: form.get("description"), amount: form.get("amount"),
                effectiveFrom: form.get("effectiveFrom"), effectiveTo: form.get("effectiveTo"),
                note: form.get("note"),
              }),
            }), "Valor recorrente cadastrado.")}
        />
      )}

      {drawer === "movement" && selectedId && (
        <MovementDrawer
          busy={busy}
          onClose={() => setDrawer("none")}
          onSubmit={(form) => {
            const movementType = String(form.get("movementType") ?? "other");
            const effect: Record<string, unknown> = {};
            if (form.get("baseAmount")) effect.baseAmount = form.get("baseAmount");
            if (form.get("contractEnd")) effect.contractEnd = form.get("contractEnd");
            if (form.get("contractTotalAmount")) effect.contractTotalAmount = form.get("contractTotalAmount");
            void mutate(
              () => send(`/api/registrations/contractors/${selectedId}/movements`, {
                method: "POST",
                body: JSON.stringify({
                  movementType, effectiveDate: form.get("effectiveDate"),
                  title: form.get("title"), reason: form.get("reason"), effect,
                }),
              }), "Movimentação registrada como rascunho.");
          }}
        />
      )}

      {toast && <p className={styles.toast} role="status">{toast}</p>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ContractorEditor({ mode, current, busy, onClose, onSubmit, dialogRef }: {
  mode: "new" | "edit";
  current: Detail["contractor"] | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (form: FormData) => void;
  dialogRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [contractType, setContractType] = useState(current?.contractType ?? "indeterminado");
  const reais = (cents: number | null | undefined) => (cents === null || cents === undefined ? "" : (cents / 100).toFixed(2));

  return (
    <div className={styles.drawerOverlay} role="dialog" aria-modal="true" aria-label={mode === "new" ? "Novo prestador PJ" : "Editar contrato"}>
      <div className={styles.employeeDrawer} ref={dialogRef}>
        <header className={styles.drawerHeader}>
          <div><span>PRESTADOR PJ</span><h2>{mode === "new" ? "Novo prestador" : current?.legalName}</h2></div>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Fechar"><X aria-hidden="true" /></button>
        </header>
        <form
          className={styles.drawerForm}
          onSubmit={(event) => { event.preventDefault(); onSubmit(new FormData(event.currentTarget)); }}
        >
          <div className={styles.drawerBody}>
            <div className={styles.formGrid}>
              <label className={styles.spanTwo}>Razão social
                <input name="legalName" defaultValue={current?.legalName ?? ""} required maxLength={180} />
              </label>
              <label>Nome fantasia<input name="tradeName" defaultValue={current?.tradeName ?? ""} maxLength={180} /></label>
              <label>CNPJ ou CPF
                <input name="taxId" defaultValue="" maxLength={20} inputMode="numeric"
                  placeholder={current?.taxIdMasked || "somente dígitos"} />
                <small>
                  {current
                    ? "Deixe em branco para manter o documento atual — ele não é exibido inteiro na tela."
                    : "O CPF é obrigatório para exportar o complemento ao cartão de benefício."}
                </small>
              </label>
              <label>Empresa contratante
                <input name="companyId" defaultValue={current?.companyId ?? ""} required={mode === "new"} />
                <small>Identificador da empresa do grupo.</small>
              </label>
              <label>E-mail<input name="email" type="email" defaultValue={current?.email ?? ""} maxLength={180} /></label>
              <label>Telefone<input name="phone" defaultValue={current?.phone ?? ""} maxLength={40} /></label>
              <label>Contrato de referência<input name="contractReference" defaultValue={current?.contractReference ?? ""} maxLength={120} /></label>
              <label>Função<input name="roleTitle" defaultValue={current?.roleTitle ?? ""} maxLength={120} /></label>
              <label>Contrato assinado em<input name="contractSignedAt" type="date" defaultValue={inputDate(current?.contractSignedAt)} /></label>

              <label>Tipo de contrato
                <select name="contractType" value={contractType}
                  onChange={(event) => setContractType(event.target.value as "determinado" | "indeterminado")}>
                  <option value="indeterminado">Prazo indeterminado</option>
                  <option value="determinado">Prazo determinado</option>
                </select>
              </label>
              <label>Início<input name="contractStart" type="date" defaultValue={inputDate(current?.contractStart)} /></label>
              <label>Término
                <input name="contractEnd" type="date" defaultValue={inputDate(current?.contractEnd)} required={contractType === "determinado"} />
                {contractType === "determinado" && <small>Obrigatório no prazo determinado.</small>}
              </label>
              {contractType === "determinado" && (
                <label>Valor global do contrato
                  <input name="contractTotalAmount" inputMode="decimal" required
                    defaultValue={reais(current?.balance?.totalCents)} />
                  <small>É ele que dá o saldo a acompanhar.</small>
                </label>
              )}

              <label>Valor fixo mensal<input name="baseAmount" inputMode="decimal" defaultValue={reais(current?.baseAmountCents)} /></label>
              <label>Limite da nota
                <input name="invoiceLimitOverride" inputMode="decimal" defaultValue={reais(current?.invoiceLimitCents)} />
                <small>Em branco usa a política vigente.</small>
              </label>
              <label>Forma de complemento
                <select name="complementMethod" defaultValue={current?.complementMethod ?? "none"}>
                  <option value="none">Sem complemento</option>
                  <option value="caju_saldo_livre">Caju Saldo Livre</option>
                  <option value="other_benefit_card">Outro cartão</option>
                  <option value="manual_transfer">Transferência</option>
                </select>
              </label>
              <label>Dia de pagamento<input name="paymentDay" type="number" min={1} max={31} defaultValue={current?.paymentDay ?? ""} /></label>
              <label>Situação
                <select name="status" defaultValue={current?.status ?? "active"}>
                  <option value="active">Ativo</option>
                  <option value="suspended">Suspenso</option>
                  <option value="inactive">Encerrado</option>
                </select>
                <small>Suspenso e encerrado não entram na apuração.</small>
              </label>
              <label className={styles.spanTwo}>Observações
                <textarea name="notes" rows={3} defaultValue={current?.notes ?? ""} maxLength={600} />
              </label>
            </div>
          </div>
          <footer className={styles.drawerFooter}>
            <button type="button" className={styles.secondaryButton} onClick={onClose}>Cancelar</button>
            <button type="submit" className={styles.primaryButton} disabled={busy}>
              {busy ? <LoaderCircle className={styles.spin} aria-hidden="true" /> : null}
              {mode === "new" ? "Cadastrar prestador" : "Salvar contrato"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

function FixedItemDrawer({ busy, onClose, onSubmit }: {
  busy: boolean; onClose: () => void; onSubmit: (form: FormData) => void;
}) {
  return (
    <div className={styles.drawerOverlay} role="dialog" aria-modal="true" aria-label="Novo valor recorrente">
      <div className={styles.employeeDrawer}>
        <header className={styles.drawerHeader}>
          <div><span>VALOR RECORRENTE</span><h2>Novo lançamento fixo</h2></div>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Fechar"><X aria-hidden="true" /></button>
        </header>
        <form className={styles.drawerForm} onSubmit={(event) => { event.preventDefault(); onSubmit(new FormData(event.currentTarget)); }}>
          <div className={styles.drawerBody}>
            <p className={styles.infoNote}>
              O valor entra sozinho em cada competência enquanto estiver vigente. Não é preciso relançar todo mês.
            </p>
            <div className={styles.formGrid}>
              <label className={styles.spanTwo}>Componente
                {/* A direção vem do tipo — escolher as duas separadamente
                    permitiria combinações que a apuração recusaria. */}
                <select name="componentType" required defaultValue="reimbursement">
                  <optgroup label="Créditos (somam)">
                    <option value="commission">Comissão</option>
                    <option value="bonus">Bônus</option>
                    <option value="award">Prêmio</option>
                    <option value="reimbursement">Reembolso</option>
                    <option value="additional">Adicional</option>
                    <option value="positive_adjustment">Ajuste positivo</option>
                    <option value="other_credit">Outro crédito</option>
                  </optgroup>
                  <optgroup label="Descontos (subtraem)">
                    <option value="health_plan">Plano de saúde</option>
                    <option value="dental_plan">Plano odontológico</option>
                    <option value="benefit">Benefício</option>
                    <option value="coparticipation">Coparticipação</option>
                    <option value="equipment">Equipamento</option>
                    <option value="advance">Adiantamento</option>
                    <option value="absence">Falta</option>
                    <option value="loan">Empréstimo</option>
                    <option value="negative_adjustment">Ajuste negativo</option>
                    <option value="other_debit">Outro desconto</option>
                  </optgroup>
                </select>
              </label>
              <label className={styles.spanTwo}>Descrição<input name="description" maxLength={180} placeholder="Ajuda de custo mensal" /></label>
              <label>Valor<input name="amount" inputMode="decimal" required /></label>
              <label>A partir da competência<input name="effectiveFrom" required placeholder="2026-01" pattern="\d{4}-\d{2}" /></label>
              <label>Até a competência
                <input name="effectiveTo" placeholder="2026-12" pattern="\d{4}-\d{2}" />
                <small>Em branco: sem prazo para acabar.</small>
              </label>
              <label className={styles.spanTwo}>Observação<textarea name="note" rows={2} maxLength={300} /></label>
            </div>
          </div>
          <footer className={styles.drawerFooter}>
            <button type="button" className={styles.secondaryButton} onClick={onClose}>Cancelar</button>
            <button type="submit" className={styles.primaryButton} disabled={busy}>Cadastrar valor</button>
          </footer>
        </form>
      </div>
    </div>
  );
}

function MovementDrawer({ busy, onClose, onSubmit }: {
  busy: boolean; onClose: () => void; onSubmit: (form: FormData) => void;
}) {
  const [movementType, setMovementType] = useState("base_change");
  return (
    <div className={styles.drawerOverlay} role="dialog" aria-modal="true" aria-label="Registrar movimentação">
      <div className={styles.employeeDrawer}>
        <header className={styles.drawerHeader}>
          <div><span>MOVIMENTAÇÃO</span><h2>Registrar movimentação</h2></div>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Fechar"><X aria-hidden="true" /></button>
        </header>
        <form className={styles.drawerForm} onSubmit={(event) => { event.preventDefault(); onSubmit(new FormData(event.currentTarget)); }}>
          <div className={styles.drawerBody}>
            <p className={styles.infoNote}>
              A movimentação nasce como rascunho e só altera o contrato quando for aplicada — com data de vigência,
              autor e motivo registrados.
            </p>
            <div className={styles.formGrid}>
              <label>Tipo
                <select name="movementType" value={movementType} onChange={(event) => setMovementType(event.target.value)}>
                  <option value="base_change">Reajuste do valor fixo</option>
                  <option value="contract_extension">Prorrogação de contrato</option>
                  <option value="contract_value_change">Mudança no valor do contrato</option>
                  <option value="suspension">Suspensão</option>
                  <option value="reactivation">Reativação</option>
                  <option value="termination">Encerramento</option>
                  <option value="other">Outra</option>
                </select>
              </label>
              <label>Vigência a partir de<input name="effectiveDate" type="date" required /></label>
              <label className={styles.spanTwo}>Resumo<input name="title" required maxLength={180} placeholder="Reajuste anual de 5%" /></label>
              {movementType === "base_change" && (
                <label>Novo valor fixo mensal<input name="baseAmount" inputMode="decimal" required /></label>
              )}
              {movementType === "contract_extension" && (
                <label>Novo término<input name="contractEnd" type="date" required /></label>
              )}
              {movementType === "contract_value_change" && (
                <label>Novo valor global<input name="contractTotalAmount" inputMode="decimal" required /></label>
              )}
              <label className={styles.spanTwo}>Motivo<textarea name="reason" rows={3} maxLength={400} /></label>
            </div>
          </div>
          <footer className={styles.drawerFooter}>
            <button type="button" className={styles.secondaryButton} onClick={onClose}>Cancelar</button>
            <button type="submit" className={styles.primaryButton} disabled={busy}>Registrar</button>
          </footer>
        </form>
      </div>
    </div>
  );
}
