"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Building2, Check, RefreshCw, UsersRound } from "lucide-react";
import { EmptyState, LoadingState, StatusPill } from "../shared";
import styles from "./registrations.module.css";

type Row = Record<string, unknown>;
type Area = {
  id: string; name: string; code: string; description: string; status: string; managerUserId: string;
  color: string; icon: string; defaultSlaDays: number; membersCount: number; moduleKeys: string[];
};
type Member = { userId: string; name: string; email: string; role: string };
type AreaMember = { userId: string; role: string; isPrimary: boolean };

const text = (value: unknown) => value == null ? "" : String(value);
const bool = (value: unknown) => value === true || value === 1 || value === "1";
async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "Não foi possível concluir a operação.");
  return payload;
}
function normalizeArea(row: Row): Area {
  const rawModuleKeys = row.module_keys ?? row.moduleKeys;
  return {
    id: text(row.id), name: text(row.name), code: text(row.code), description: text(row.description), status: text(row.status),
    managerUserId: text(row.manager_user_id ?? row.managerUserId), color: text(row.color) || "#475569",
    icon: text(row.icon) || "building-2", defaultSlaDays: Number(row.default_sla_days ?? row.defaultSlaDays ?? 3),
    membersCount: Number(row.members_count ?? row.membersCount ?? 0),
    moduleKeys: Array.isArray(rawModuleKeys) ? rawModuleKeys.map(String) : [],
  };
}

export function AreasPanel({ canManage, createSignal }: { canManage: boolean; createSignal: number }) {
  const [areas, setAreas] = useState<Area[]>([]);
  const [workspaceMembers, setWorkspaceMembers] = useState<Member[]>([]);
  const [selected, setSelected] = useState<Area | "new" | null>(null);
  const [areaMembers, setAreaMembers] = useState<AreaMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const load = useCallback(async (preferredId?: string) => {
    setLoading(true);
    try {
      const [areaPayload, snapshot] = await Promise.all([
        requestJson<{ areas?: Row[] }>("/api/areas"),
        requestJson<{ members?: Array<{ userId: string; name: string; email: string; role: string }> }>("/api/workspace"),
      ]);
      const next = (areaPayload.areas ?? []).map(normalizeArea);
      setAreas(next); setWorkspaceMembers(snapshot.members ?? []);
      setSelected((current) => next.find((item) => item.id === (preferredId || (current === "new" ? "" : current?.id))) ?? next[0] ?? null);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Erro ao carregar áreas."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { const frame = requestAnimationFrame(() => void load()); return () => cancelAnimationFrame(frame); }, [load]);
  useEffect(() => {
    if (createSignal <= 0) return;
    const frame = requestAnimationFrame(() => { setSelected("new"); setAreaMembers([]); });
    return () => cancelAnimationFrame(frame);
  }, [createSignal]);

  const active = selected === "new" ? null : selected;
  const memberById = useMemo(() => new Map(areaMembers.map((item) => [item.userId, item])), [areaMembers]);
  useEffect(() => {
    if (!active?.id) return;
    let canceled = false;
    void requestJson<{ members?: Row[]; moduleKeys?: string[] }>(`/api/areas/${active.id}`).then((detail) => {
      if (canceled) return;
      setAreaMembers((detail.members ?? []).map((item) => ({
        userId: text(item.user_id ?? item.userId), role: text(item.role) || "member", isPrimary: bool(item.is_primary ?? item.isPrimary),
      })));
      setSelected((current) => current && current !== "new" && current.id === active.id
        ? { ...current, moduleKeys: detail.moduleKeys ?? current.moduleKeys } : current);
    }).catch((cause) => { if (!canceled) setError(cause instanceof Error ? cause.message : "Erro ao abrir a área."); });
    return () => { canceled = true; };
  }, [active?.id]);
  const select = useCallback((area: Area) => { setSelected(area); setAreaMembers([]); setError(""); }, []);

  function toggleMember(userId: string, checked: boolean) {
    setAreaMembers((current) => checked
      ? [...current, { userId, role: "member", isPrimary: false }]
      : current.filter((item) => item.userId !== userId));
  }
  function changeMember(userId: string, patch: Partial<AreaMember>) {
    setAreaMembers((current) => current.map((item) => item.userId === userId
      ? { ...item, ...patch } : patch.isPrimary ? { ...item, isPrimary: false } : item));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!canManage) return;
    const data = new FormData(event.currentTarget);
    const payload = {
      name: text(data.get("name")), code: text(data.get("code")), description: text(data.get("description")),
      managerUserId: text(data.get("managerUserId")) || null, color: text(data.get("color")),
      defaultSlaDays: Number(data.get("defaultSlaDays") || 3),
      moduleKeys: [data.get("epiOwner") ? "epi.owner" : "", data.get("discountAnalysis") ? "epi.discount_analysis" : ""].filter(Boolean),
    };
    setBusy(true); setError("");
    try {
      const result = active
        ? await requestJson<{ area: { id: string } }>(`/api/areas/${active.id}`, { method: "PATCH", body: JSON.stringify(payload) })
        : await requestJson<{ area: { id: string } }>("/api/areas", { method: "POST", body: JSON.stringify(payload) });
      await requestJson(`/api/areas/${result.area.id}/members`, { method: "PUT", body: JSON.stringify({ members: areaMembers }) });
      setSaved("Área e integrantes salvos."); await load(result.area.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar a área."); }
    finally { setBusy(false); }
  }
  async function archive() {
    if (!active || !window.confirm(`Arquivar a área ${active.name}? O histórico será preservado.`)) return;
    setBusy(true);
    try { await requestJson(`/api/areas/${active.id}`, { method: "DELETE" }); setSaved("Área arquivada."); setSelected(null); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível arquivar a área."); }
    finally { setBusy(false); }
  }

  if (loading) return <LoadingState title="Carregando áreas operacionais" />;
  if (!areas.length && selected !== "new") return <EmptyState icon={Building2} title="Nenhuma área operacional"
    text="Crie áreas do Workspace como SESMT e Departamento Pessoal. Elas atravessam empresas e roteiam as demandas."
    action={canManage && <button className={styles.secondaryButton} onClick={() => setSelected("new")}>Criar primeira área</button>} />;
  return <div className={styles.areasLayout}>
    <aside className={styles.areaList}>
      <header><div><span>ÁREAS DO WORKSPACE</span><strong>{areas.filter((item) => item.status === "active").length} ativas</strong></div>
        <button aria-label="Atualizar áreas" onClick={() => void load()}><RefreshCw /></button></header>
      {areas.map((area) => <button key={area.id} data-selected={active?.id === area.id} onClick={() => void select(area)}>
        <span style={{ background: area.color }} /><div><strong>{area.name}</strong><small>{area.code} · {area.membersCount} integrante(s)</small></div>
        <StatusPill status={area.status} label={area.status === "active" ? "Ativa" : area.status === "archived" ? "Arquivada" : "Inativa"} />
      </button>)}
    </aside>
    <form key={active?.id ?? "new"} className={styles.areaEditor} onSubmit={(event) => void submit(event)}>
      <header><div><span>{active ? active.code : "NOVA ÁREA"}</span><h2>{active?.name ?? "Criar área operacional"}</h2>
        <p>Área transversal ao Workspace, independente de empresa ou CNPJ.</p></div></header>
      {error && <p className={styles.inlineError}>{error}</p>}{saved && <p className={styles.inlineSuccess}><Check />{saved}</p>}
      <div className={styles.formGrid}>
        <label><span>NOME *</span><input name="name" required defaultValue={active?.name ?? ""} /></label>
        <label><span>CÓDIGO *</span><input name="code" required defaultValue={active?.code ?? ""} /></label>
        <label><span>RESPONSÁVEL</span><select name="managerUserId" defaultValue={active?.managerUserId ?? ""}><option value="">Não definido</option>
          {workspaceMembers.map((item) => <option key={item.userId} value={item.userId}>{item.name}</option>)}</select></label>
        <label><span>SLA PADRÃO (DIAS)</span><input name="defaultSlaDays" type="number" min="0" max="365" defaultValue={active?.defaultSlaDays ?? 3} /></label>
        <label><span>COR</span><input name="color" type="color" defaultValue={active?.color ?? "#475569"} /></label>
        <label className={styles.formWide}><span>DESCRIÇÃO</span><textarea name="description" defaultValue={active?.description ?? ""} /></label>
      </div>
      <section className={styles.areaSection}><h3>Roteamento do Controle de EPI</h3>
        <label><input type="checkbox" name="epiOwner" defaultChecked={active?.moduleKeys.includes("epi.owner")} /> Área solicitante / SESMT</label>
        <label><input type="checkbox" name="discountAnalysis" defaultChecked={active?.moduleKeys.includes("epi.discount_analysis")} /> Área responsável pela análise / DP</label>
      </section>
      <section className={styles.areaSection}><h3><UsersRound /> Integrantes</h3>
        <div className={styles.areaMembers}>{workspaceMembers.map((member) => {
          const assignment = memberById.get(member.userId); return <div key={member.userId}>
            <label><input type="checkbox" checked={Boolean(assignment)} onChange={(event) => toggleMember(member.userId, event.target.checked)} />
              <span><strong>{member.name}</strong><small>{member.email || member.role}</small></span></label>
            {assignment && <><select value={assignment.role} onChange={(event) => changeMember(member.userId, { role: event.target.value })}>
              <option value="manager">Gestor</option><option value="member">Integrante</option><option value="observer">Observador</option></select>
              <label><input type="radio" name="primaryArea" checked={assignment.isPrimary} onChange={() => changeMember(member.userId, { isPrimary: true })} /> Principal</label></>}
          </div>;
        })}</div>
      </section>
      {canManage && <footer><button type="submit" className={styles.primaryButton} disabled={busy}>{busy ? "Salvando…" : "Salvar área"}</button>
        {active && active.status !== "archived" && <button type="button" className={styles.secondaryButton} onClick={() => void archive()} disabled={busy}><Archive /> Arquivar</button>}</footer>}
    </form>
  </div>;
}
