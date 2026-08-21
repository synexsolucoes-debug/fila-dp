"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, LoaderCircle, Lock, MinusCircle, PlusCircle, RotateCcw } from "lucide-react";
import { ErrorBanner } from "./panel-ui";
import styles from "./member-modules.module.css";

/**
 * Acesso individual aos módulos, dentro da ficha de um membro.
 *
 * A tela mostra três estados por módulo, e a diferença entre eles é o ponto:
 * "segue o papel" (sem exceção), "liberado para esta pessoa" e "bloqueado para
 * esta pessoa". Mostrar só o resultado final esconderia a causa, e numa revisão
 * de acesso a causa é o que se procura.
 */

type ModuleRow = {
  key: string;
  name: string;
  description: string;
  category: string;
  allowed: boolean;
  reason: string;
  message: string;
  allowedByRole: boolean;
  /** `null` = segue o papel; `true` = liberado; `false` = bloqueado. */
  override: boolean | null;
  lockedByPlan: boolean;
  inDepartment: boolean;
  lockedByDepartment: boolean;
};

type Payload = {
  member: {
    id: string; name: string; role: string;
    department: { id: string; name: string; code: string } | null;
    departmentRequired: boolean;
  };
  modules: ModuleRow[];
  permissions: { manage: boolean };
};

const categoryLabels: Record<string, string> = {
  operacao: "Operação", folha: "Folha", gestao: "Gestão", pessoas: "Pessoas",
};

export function MemberModules({ memberId, memberName, canManage }: {
  memberId: string; memberName: string; canManage: boolean;
}) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/members/${memberId}/modules`, { cache: "no-store" });
      const data = await response.json().catch(() => ({})) as Payload & { message?: string; error?: string };
      if (!response.ok) throw new Error(data.message || data.error || "Não foi possível carregar os acessos.");
      setPayload(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar os acessos.");
    } finally {
      setLoading(false);
    }
  }, [memberId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load]);

  async function apply(moduleKey: string, granted: boolean | null) {
    setBusy(moduleKey);
    setError("");
    try {
      const response = await fetch(`/api/members/${memberId}/modules`, {
        method: "PUT",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moduleKey, granted }),
      });
      const data = await response.json().catch(() => ({})) as { message?: string; error?: string };
      if (!response.ok) throw new Error(data.message || data.error || "Não foi possível alterar o acesso.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível alterar o acesso.");
    } finally {
      setBusy("");
    }
  }

  if (loading) {
    return (
      <p className={styles.detailNote}>
        <LoaderCircle className={styles.spin} aria-hidden="true" /> Carregando os módulos de {memberName}…
      </p>
    );
  }
  if (!payload) {
    return <ErrorBanner message={error || "Não foi possível carregar os acessos."} />;
  }

  const approved = payload.modules.filter((item) => item.inDepartment && item.override === true).length;
  const departmentModules = payload.modules.filter((item) => item.inDepartment).length;

  return (
    <div className={styles.matrixArea}>
      <p className={styles.detailNote}>
        {payload.member.department ? <>
          <Building2 aria-hidden="true" /> O departamento <b>{payload.member.department.name}</b> dá {departmentModules} módulo(s) por
          padrão, e {approved} estão liberados para {memberName}.
        </> : <>
          O papel <b>{payload.member.role}</b> decide o acesso porque não há departamento principal cadastrado.
        </>}
        {" "}Aqui você abre exceção para esta pessoa, inclusive em módulo que o departamento dela não tem.
        {" "}A liberação concede a <b>leitura</b>; as ações de escrita continuam vindo do papel.
      </p>

      {error && <ErrorBanner message={error} />}

      <div className={styles.tableScroll}>
        <table className={styles.memberTable}>
          <caption className={styles.srOnly}>Acesso de {memberName} a cada módulo</caption>
          <thead>
            <tr>
              <th scope="col">Módulo</th>
              <th scope="col">Departamento</th>
              <th scope="col">Acesso efetivo</th>
              {canManage && <th scope="col">Liberação individual</th>}
            </tr>
          </thead>
          <tbody>
            {payload.modules.map((item) => (
              <tr key={item.key} data-denied={item.override === false ? "true" : undefined}>
                <th scope="row">
                  {item.name}
                  <small>{categoryLabels[item.category] ?? item.category} · {item.description}</small>
                </th>
                <td>
                  <span className={item.inDepartment ? undefined : styles.matrixDenied}>
                    {item.inDepartment ? "Incluído" : payload.member.departmentRequired ? "Departamento não definido" : "Fora do departamento"}
                  </span>
                  {item.inDepartment
                    ? <small>{item.allowedByRole ? "O papel também permite" : "Depende de liberação individual"}</small>
                    : item.override === true ? <small>Liberado por exceção para esta pessoa</small> : null}
                </td>
                <td>
                  <span className={item.allowed ? undefined : styles.matrixDenied}>
                    {item.allowed ? "Tem acesso" : "Sem acesso"}
                  </span>
                  {!item.allowed && item.message && <small>{item.message}</small>}
                </td>
                {canManage && (
                  <td className={styles.rowActions}>
                    {item.lockedByPlan ? (
                      // Fora do plano nem o administrador do grupo pode liberar: dizer
                      // isso é mais útil que esconder o botão.
                      <span className={styles.detailEmpty}>
                        <Lock aria-hidden="true" /> Fora do plano
                      </span>
                    ) : (
                      <>
                        {item.override !== true && (
                          <button type="button" className={styles.secondaryButton} disabled={busy === item.key}
                            onClick={() => void apply(item.key, true)}>
                            <PlusCircle aria-hidden="true" /> Liberar
                          </button>
                        )}
                        {item.override !== false && (
                          <button type="button" className={styles.secondaryButton} disabled={busy === item.key}
                            onClick={() => void apply(item.key, false)}>
                            <MinusCircle aria-hidden="true" /> Bloquear
                          </button>
                        )}
                        {/* Remover a exceção devolve a pessoa ao que o papel e o
                            departamento decidem. Antes o botão sumia para quem
                            tinha departamento, porque a rota recusava limpar —
                            então uma exceção aberta por engano não tinha volta. */}
                        {item.override !== null && (
                          <button type="button" className={styles.secondaryButton} disabled={busy === item.key}
                            onClick={() => void apply(item.key, null)}
                            title="Remove a exceção e devolve esta pessoa ao que o papel decide">
                            <RotateCcw aria-hidden="true" /> Seguir o papel
                          </button>
                        )}
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
