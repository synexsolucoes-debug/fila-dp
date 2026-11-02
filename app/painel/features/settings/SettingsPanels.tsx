"use client";

import { FormEvent, useEffect, useState } from "react";
import { ArrowRight, Building2, Cable, CheckCircle2, ChevronDown, CircleAlert, ClipboardList, ListChecks, Plus, Users } from "lucide-react";
import { plural } from "../overview/formatting";
import { roleLabels, type CatalogHandler, type ConfirmHandler, type SnapshotMutation } from "./settings.types";
import type { WorkspaceSnapshot } from "@/lib/fila-dp-types";
import { RULE_TRIGGERS, RULE_TRIGGER_LABELS } from "@/lib/automation-rules";
import { PRIORITY_LABELS } from "@/lib/work-items";
import { capabilitiesForRole, workspaceRoles } from "@/lib/authorization";
import { capabilityAreas, capabilitiesOfArea, capabilityCatalog, type CapabilityArea } from "@/lib/capability-catalog";
import { contagem } from "../shared/plural";

/*
 * Painéis de Configurações e de administração do grupo.
 *
 * Saíram de `WorkspaceApp.tsx`: cada um recebe o retrato e as ações por props
 * e não guarda estado do painel.
 */

export function MemberCompanyAccess({ member, companies, busy, onSave }: { member: WorkspaceSnapshot["members"][number]; companies: WorkspaceSnapshot["companies"]; busy: boolean; onSave: (userId: string, companyIds: string[]) => Promise<void> }) {
  const [selectedIds, setSelectedIds] = useState<string[]>(member.companyIds);
  if (member.role === "admin") return <span className="member-company-summary">Todas as empresas</span>;
  return <details className="member-company-access"><summary>{selectedIds.length ? `${contagem(selectedIds.length, "empresa liberada", "empresas liberadas")}` : "Nenhuma empresa liberada"}</summary><div>{companies.map((company) => <label key={company.id}><input type="checkbox" checked={selectedIds.includes(company.id)} disabled={busy} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, company.id] : current.filter((id) => id !== company.id))} />{company.tradeName || company.legalName}{company.isPrincipal && <em>Matriz</em>}</label>)}</div><button type="button" disabled={busy} onClick={() => void onSave(member.userId, selectedIds)}>Salvar empresas</button></details>;
}

/**
 * Portal do Gestor, passo 1 (§4.20): qual colaborador esta conta representa —
 * a ponte entre login e "de quem sou gestor" (`fdp_employees.manager_employee_id`,
 * já existente, mas sem ligação com nenhuma conta até este vínculo existir).
 * Busca por nome/matrícula em vez de uma lista só, porque o cadastro de
 * colaboradores pode ter milhares de linhas — o mesmo motivo por que a
 * própria ficha de colaboradores (RegistrationsView) pagina e busca, nunca
 * lista tudo de uma vez.
 */
export function MemberEmployeeLink({ member, busy, onSave }: { member: WorkspaceSnapshot["members"][number]; busy: boolean; onSave: (userId: string, employeeId: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; fullName: string; companyName: string; registrationNumber: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [linkedName, setLinkedName] = useState("");
  // O snapshot não junta `fdp_employees` (mantém essa consulta livre da
  // tabela de colaboradores — tests/registrations-phase3.test.mts); o nome
  // de quem já está vinculado é buscado à parte, só quando existe vínculo.
  useEffect(() => {
    let active = true;
    const frame = window.requestAnimationFrame(() => {
      if (!member.employeeId) { setLinkedName(""); return; }
      void fetch(`/api/employees/${member.employeeId}`)
        .then((response) => response.ok ? response.json() as Promise<{ employee?: Record<string, unknown> }> : null)
        .then((payload) => { if (active && payload?.employee) setLinkedName(String(payload.employee.fullName ?? payload.employee.full_name ?? "")); })
        .catch(() => { if (active) setLinkedName(""); });
    });
    return () => { active = false; window.cancelAnimationFrame(frame); };
  }, [member.employeeId]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const trimmed = query.trim();
      if (!open || trimmed.length < 2) { setResults([]); return; }
      setSearching(true);
      void fetch(`/api/employees?search=${encodeURIComponent(trimmed)}&status=active&limit=8`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() as Promise<{ employees?: Array<Record<string, unknown>> }> : { employees: [] })
        .then((payload) => setResults((payload.employees ?? []).map((row) => ({
          id: String(row.id), fullName: String(row.full_name ?? ""),
          companyName: String(row.company_name ?? ""), registrationNumber: String(row.registration_number ?? ""),
        }))))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, query]);
  return <details className="member-employee-link" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{member.employeeId ? `Colaborador: ${linkedName || "vinculado"}` : "Sem colaborador vinculado"}</summary>
    <div>
      <input type="search" placeholder="Buscar por nome ou matrícula" value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} />
      {searching && <small>Buscando…</small>}
      {!searching && query.trim().length >= 2 && results.length === 0 && <small>Nenhum colaborador encontrado.</small>}
      <ul>{results.map((result) => <li key={result.id}><button type="button" disabled={busy} onClick={() => { void onSave(member.userId, result.id); setQuery(""); setResults([]); }}>{result.fullName} · {result.registrationNumber || "sem matrícula"} · {result.companyName}</button></li>)}</ul>
      {member.employeeId && <button type="button" className="member-employee-unlink" disabled={busy} onClick={() => void onSave(member.userId, "")}>Remover vínculo</button>}
    </div>
  </details>;
}

export function CompanySettings({ companies, members, busy, onCreateCompany, onUpdateCompany, onDeleteCompany, onOpenAccess }: { companies: WorkspaceSnapshot["companies"]; members: WorkspaceSnapshot["members"]; busy: boolean; onCreateCompany: (payload: Record<string, unknown>) => Promise<WorkspaceSnapshot | null>; onUpdateCompany: (id: string, payload: Record<string, unknown>) => Promise<WorkspaceSnapshot | null>; onDeleteCompany: (id: string, name: string) => void; onOpenAccess: () => void }) {
  /* `null` = formulário fechado, `""` = cadastrando, um id = editando aquela
     empresa. Um estado só, porque cadastrar e editar são o mesmo formulário:
     manter dois formulários lado a lado é como o cadastro de campos acaba
     divergindo do de edição sem ninguém perceber. */
  const [editing, setEditing] = useState<string | null>(null);
  const companyName = new Map(companies.map((company) => [company.id, company.tradeName || company.legalName]));
  const principalCompanies = companies.filter((company) => company.isPrincipal);
  const orderedCompanies = [...companies].sort((a, b) => Number(b.isPrincipal) - Number(a.isPrincipal) || (companyName.get(a.parentCompanyId ?? "") ?? "").localeCompare(companyName.get(b.parentCompanyId ?? "") ?? "") || (a.tradeName || a.legalName).localeCompare(b.tradeName || b.legalName));
  const current = editing ? companies.find((company) => company.id === editing) ?? null : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const payload = {
      legalName: data.get("legalName"), tradeName: data.get("tradeName"), taxId: data.get("taxId"),
      externalCode: data.get("externalCode"), email: data.get("email"), phone: data.get("phone"),
      companyType: data.get("companyType"), parentCompanyId: data.get("parentCompanyId"),
    };
    const result = current
      // Ao editar, a situação também é editável: desativar um CNPJ é o caminho
      // de quem não pode excluí-lo por causa do histórico.
      ? await onUpdateCompany(current.id, { ...payload, status: data.get("status") })
      : await onCreateCompany(payload);
    if (result) { form.reset(); setEditing(null); }
  }

  return <div className="company-settings-view">
    <section className="company-settings-intro">
      <span><Building2 aria-hidden="true" /></span><div><strong>Empresas do grupo</strong><p>Cadastre a empresa principal e os CNPJs vinculados. Esses cadastros ficam disponíveis para demandas, folha, permissões e integrações.</p></div><b>{contagem(companies.length, "empresa", "empresas")}</b>
    </section>
    <section className="company-settings-access"><div><strong>Controle de acesso por empresa</strong><p>Após cadastrar um CNPJ, escolha quais usuários poderão consultar ou operar demandas daquela empresa.</p></div><button className="secondary-button" onClick={onOpenAccess}><Users aria-hidden="true" /> Gerenciar usuários e acessos</button></section>
    <section className="company-settings-catalog">
      <header><div><strong>Cadastros do grupo</strong><span>CNPJ, estrutura societária, contato e código externo para Sankhya.</span></div><button className="primary-button" disabled={busy} onClick={() => setEditing((value) => value === null ? "" : null)}><Plus aria-hidden="true" /> {editing === null ? "Cadastrar empresa" : "Fechar formulário"}</button></header>
      {editing !== null && <form className="company-settings-form" key={editing || "new"} onSubmit={submit}>
        <label>Tipo<select name="companyType" defaultValue={current ? (current.isPrincipal ? "principal" : "subsidiary") : companies.some((company) => company.isPrincipal) ? "subsidiary" : "principal"} disabled={busy}><option value="principal">Empresa principal do grupo</option><option value="subsidiary">Empresa / CNPJ do grupo</option></select></label>
        <label>Empresa principal<select name="parentCompanyId" defaultValue={current?.parentCompanyId ?? ""} disabled={busy}><option value="">Vincular à principal automaticamente</option>{principalCompanies.filter((company) => company.id !== current?.id).map((company) => <option key={company.id} value={company.id}>{company.tradeName || company.legalName}</option>)}</select></label>
        <label>Razão social<input name="legalName" defaultValue={current?.legalName ?? ""} placeholder="Empresa Exemplo Ltda." maxLength={160} required disabled={busy} /></label>
        <label>Nome fantasia<input name="tradeName" defaultValue={current?.tradeName ?? ""} placeholder="Empresa Exemplo" maxLength={160} disabled={busy} /></label>
        <label>CNPJ<input name="taxId" defaultValue={current?.taxId ?? ""} placeholder="00.000.000/0001-00" maxLength={30} disabled={busy} /></label>
        <label>Código Sankhya<input name="externalCode" defaultValue={current?.externalCode ?? ""} placeholder="COD_EMPRESA" maxLength={80} disabled={busy} /></label>
        <label>E-mail<input type="email" name="email" defaultValue={current?.email ?? ""} maxLength={160} disabled={busy} /></label>
        <label>Telefone<input name="phone" defaultValue={current?.phone ?? ""} maxLength={40} disabled={busy} /></label>
        {current && <label>Situação<select name="status" defaultValue={current.status} disabled={busy}><option value="active">Ativa</option><option value="inactive">Inativa</option></select></label>}
        <div className="company-settings-form-actions">
          {current && <button type="button" className="secondary-button" disabled={busy} onClick={() => setEditing(null)}>Cancelar</button>}
          <button className="primary-button" disabled={busy}>{current ? "Salvar alterações" : "Salvar empresa"}</button>
        </div>
      </form>}
      <div className="company-settings-list">
        {orderedCompanies.length === 0 && <div className="empty-view"><span><Building2 aria-hidden="true" /></span><strong>Nenhuma empresa cadastrada</strong><p>Cadastre a empresa principal para estruturar o grupo e liberar acessos.</p></div>}
        {orderedCompanies.map((company) => {
          const allowedMembers = members.filter((member) => member.role === "admin" || member.companyIds.includes(company.id)).length;
          return <article className={company.isPrincipal ? "principal" : "subsidiary"} key={company.id}><i>{company.isPrincipal ? "P" : "↳"}</i><div><strong>{company.tradeName || company.legalName}{company.isPrincipal && <em>Principal</em>}{company.status === "inactive" && <em className="inactive">Inativa</em>}</strong><small>{company.isPrincipal ? "Empresa raiz do grupo" : `Grupo: ${companyName.get(company.parentCompanyId ?? "") ?? "Principal"}`} · {company.taxId || "CNPJ não informado"}</small></div><span><small>Usuários com acesso</small><b>{allowedMembers}</b></span><span><small>Sankhya</small><b>{company.externalCode || "Não vinculado"}</b></span><button className="secondary-button" type="button" disabled={busy} onClick={() => setEditing(editing === company.id ? null : company.id)} aria-label={`Editar ${company.tradeName || company.legalName}`}>{editing === company.id ? "Editando" : "Editar"}</button><button className="danger-link" type="button" disabled={busy} onClick={() => onDeleteCompany(company.id, company.legalName)}>Excluir</button></article>;
        })}
      </div>
    </section>
  </div>;
}

/**
 * A faixa de indicadores da Administração (maquete 3).
 *
 * Os cinco números que dizem o tamanho do que está sendo administrado, antes
 * dos formulários que o alteram. Todos saem do snapshot que a modal já tem em
 * mãos — nenhuma consulta nova, e nenhum valor escrito no código.
 *
 * A maquete traz também "Plano e utilização" com barras de consumo. Ele não
 * entra: a tela de plano foi tirada do painel de propósito (§44), e há teste
 * guardando essa retirada. Ressuscitá-la de lado, como faixa de progresso sem
 * a tela por trás, seria mostrar consumo sem lugar nenhum para agir sobre ele.
 */
export function AdminIndicators({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const ativas = snapshot.companies.filter((company) => company.status === "active").length;
  const comErro = snapshot.integrations.filter((item) => item.status === "error").length;
  const conectadas = snapshot.integrations.filter((item) => item.status === "connected").length;
  const semAtivar = snapshot.members.filter((member) => !member.isActivated).length;
  const etapas = snapshot.boards.reduce((total, board) => total + board.stages.length, 0);

  const indicadores = [
    {
      key: "members", icon: Users, label: "Usuários com acesso",
      value: String(snapshot.members.length),
      support: semAtivar ? `${semAtivar} ainda sem ativar o acesso` : "Todos com acesso ativado",
      alert: semAtivar > 0,
    },
    {
      key: "companies", icon: Building2, label: "Empresas do grupo",
      value: String(snapshot.companies.length),
      support: `${ativas} em operação`,
      alert: false,
    },
    {
      key: "boards", icon: ClipboardList, label: "Quadros da operação",
      value: String(snapshot.boards.length),
      support: plural(etapas, "etapa configurada", "etapas configuradas"),
      alert: false,
    },
    {
      key: "integrations", icon: Cable, label: "Integrações com erro",
      value: String(comErro),
      support: `${contagem(conectadas, "conectada", "conectadas")} de ${contagem(snapshot.integrations.length, "configurada", "configuradas")}`,
      alert: comErro > 0,
    },
  ];

  return <section className="admin-indicators" aria-label={`Indicadores da administração — ${snapshot.workspace.name}`}>
    {indicadores.map((item) => {
      return <article key={item.key} className={`admin-indicator${item.alert ? " requires-attention" : ""}`}>
        <span className="admin-indicator-top"><span>{item.label}</span></span>
        <strong>{item.value}</strong>
        <small>{item.support}</small>
      </article>;
    })}
  </section>;
}

/**
 * A matriz de permissões (maquete 3).
 *
 * O modelo já existia inteiro e nunca chegou a uma tela: `capabilitiesForRole`
 * nasceu com o comentário "a tela de usuários precisa mostrar o que cada papel
 * concede — sem isso o administrador escolhe 'Membro' ou 'Observador' no
 * escuro", e nenhum componente jamais o chamou. O seletor de papel logo acima
 * desta matriz é exatamente essa escolha no escuro.
 *
 * As linhas são as capacidades reais, agrupadas pelas áreas do catálogo e
 * escritas na linguagem dele — `competences.transition` não diz nada a quem
 * administra; "Avançar a competência entre as etapas do fechamento" diz.
 *
 * A maquete desenha três estados por célula: concedido, parcial e negado. O
 * "parcial" não existe no modelo — uma capacidade é do papel ou não é — então
 * ele não é desenhado. Inventar um meio-termo numa matriz de permissão é o
 * tipo de enfeite que faz alguém conceder acesso achando que concedeu menos.
 */
export function PermissionMatrix() {
  const [aberta, setAberta] = useState<CapabilityArea | "">("");
  const papeis = workspaceRoles;
  const concedidas = new Map(papeis.map((papel) => [papel, new Set<string>(capabilitiesForRole(papel))]));

  return <section className="permission-matrix" aria-labelledby="permission-matrix-title">
    <header>
      <div>
        <strong id="permission-matrix-title">O que cada papel permite</strong>
        <span>Permissões de cada papel.</span>
      </div>
    </header>
    {capabilityAreas.map((area) => {
      const itens = capabilitiesOfArea(area.key);
      if (itens.length === 0) return null;
      const expandida = aberta === area.key;
      return <div className="permission-area" key={area.key}>
        <button type="button" aria-expanded={expandida}
          onClick={() => setAberta(expandida ? "" : area.key)}>
          <span>{area.label}</span>
          <b>{plural(itens.length, "permissão", "permissões")}</b>
          <ChevronDown aria-hidden="true" data-open={expandida ? "true" : "false"} />
        </button>
        {expandida && <div className="overview-table-scroll">
          <table className="overview-table permission-table">
            <thead><tr>
              <th scope="col">Permissão</th>
              {papeis.map((papel) => <th scope="col" key={papel}>{roleLabels[papel]}</th>)}
            </tr></thead>
            <tbody>
              {itens.map((capability) => <tr key={capability}>
                <th scope="row">{capabilityCatalog[capability].label}</th>
                {papeis.map((papel) => {
                  const tem = concedidas.get(papel)?.has(capability) ?? false;
                  /* O símbolo sozinho não basta: quem usa leitor de tela ouve
                     "check" sem saber de quê, e quem não distingue verde de
                     cinza vê duas marcas parecidas. O texto acessível diz o
                     par inteiro — papel e permissão. */
                  return <td key={papel} className={tem ? "concedida" : "negada"}>
                    <span aria-hidden="true">{tem ? "\u2713" : "\u2014"}</span>
                    <span className="sr-only">
                      {roleLabels[papel]}: {tem ? "permitido" : "não permitido"}
                    </span>
                  </td>;
                })}
              </tr>)}
            </tbody>
          </table>
        </div>}
      </div>;
    })}
  </section>;
}

export function ListsSettings({ snapshot, busy, isAdmin, onMutate, onConfirm }: { snapshot: WorkspaceSnapshot; busy: boolean; isAdmin: boolean; onMutate: SnapshotMutation; onConfirm: ConfirmHandler }) {
  const [deleteTargets, setDeleteTargets] = useState<Record<string, string>>({});
  const lists = [...snapshot.lists].sort((a, b) => a.position - b.position);
  const behaviorLabel: Record<string, string> = { running: "SLA em andamento", paused: "SLA pausado", completed: "SLA concluído" };

  async function createList(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const next = await onMutate("/api/lists", { method: "POST", body: JSON.stringify({ boardId: snapshot.board.id, name: data.get("name"), slaBehavior: data.get("slaBehavior") }) }, "Coluna criada no quadro.");
    if (next) form.reset();
  }

  async function saveList(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await onMutate(`/api/lists/${id}`, { method: "PATCH", body: JSON.stringify({ name: data.get("name"), slaBehavior: data.get("slaBehavior") }) }, "Coluna atualizada.");
  }

  async function reorder(listId: string, direction: -1 | 1) {
    const index = lists.findIndex((list) => list.id === listId);
    const neighbour = lists[index + direction];
    const current = lists[index];
    if (!current || !neighbour) return;
    const first = await onMutate(`/api/lists/${current.id}`, { method: "PATCH", body: JSON.stringify({ position: neighbour.position }) }, "Ordem da coluna atualizada.");
    if (first) await onMutate(`/api/lists/${neighbour.id}`, { method: "PATCH", body: JSON.stringify({ position: current.position }) });
  }

  function removeList(listId: string, listName: string, cards: number) {
    const moveToListId = deleteTargets[listId] ?? "";
    if (cards > 0 && !moveToListId) return;
    onConfirm({
      title: "Excluir coluna?",
      description: cards > 0 ? `${contagem(cards, "demanda será transferida", "demandas serão transferidas")} para a coluna selecionada antes da exclusão.` : `A coluna “${listName}” será removida do quadro.`,
      confirmLabel: "Excluir coluna",
      action: () => onMutate(`/api/lists/${listId}`, { method: "DELETE", body: cards > 0 ? JSON.stringify({ moveToListId }) : undefined }, "Coluna excluída com segurança."),
    });
  }

  return <div className="settings-stack"><section className="catalog-section list-manager"><header><div><strong>Colunas do quadro</strong><span>Renomeie, ordene, controle o SLA e mova demandas com segurança antes de excluir.</span></div><b>{lists.length}</b></header><div className="list-manager-items">{lists.map((list, index) => <form key={list.id} onSubmit={(event) => void saveList(event, list.id)}><div className="list-order-controls"><button type="button" disabled={!isAdmin || busy || index === 0} onClick={() => void reorder(list.id, -1)} aria-label={`Mover ${list.name} para a esquerda`}>↑</button><button type="button" disabled={!isAdmin || busy || index === lists.length - 1} onClick={() => void reorder(list.id, 1)} aria-label={`Mover ${list.name} para a direita`}>↓</button></div><label>Nome<input name="name" defaultValue={list.name} maxLength={80} disabled={!isAdmin || busy} required /></label><label>SLA<select name="slaBehavior" defaultValue={list.slaBehavior} disabled={!isAdmin || busy}><option value="running">Em andamento</option><option value="paused">Pausado</option><option value="completed">Concluído</option></select></label><small>{contagem(list.cards.length, "demanda", "demandas")} · {behaviorLabel[list.slaBehavior]}</small>{isAdmin && <><button className="secondary-button" disabled={busy}>Salvar</button>{list.cards.length > 0 && <label className="list-transfer">Mover para<select value={deleteTargets[list.id] ?? ""} disabled={busy} onChange={(event) => setDeleteTargets((current) => ({ ...current, [list.id]: event.target.value }))}><option value="">Escolha antes de excluir</option>{lists.filter((target) => target.id !== list.id).map((target) => <option value={target.id} key={target.id}>{target.name}</option>)}</select></label>}<button type="button" className="danger-link list-delete" disabled={busy || (list.cards.length > 0 && !deleteTargets[list.id])} onClick={() => removeList(list.id, list.name, list.cards.length)}>Excluir</button></>}</form>)}</div></section>{isAdmin && <section className="catalog-section"><header><div><strong>Nova coluna</strong><span>Use uma coluna com SLA pausado apenas quando houver uma justificativa operacional.</span></div></header><form className="catalog-form list-create-form" onSubmit={createList}><label>Nome da coluna<input name="name" placeholder="Ex.: Aguardando aprovação" maxLength={80} required /></label><label>Comportamento do SLA<select name="slaBehavior" defaultValue="running"><option value="running">Em andamento</option><option value="paused">Pausado</option><option value="completed">Concluído</option></select></label><button className="primary-button" disabled={busy}>Criar coluna</button></form></section>}<section className="catalog-section card-archive-settings"><header><div><strong>Arquivo automático</strong><span>Demanda concluída ou cancelada sai do quadro depois de alguns dias e fica no Arquivo, de onde pode ser restaurada.</span></div></header><form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void onMutate("/api/catalog", { method: "POST", body: JSON.stringify({ resource: "card-archive", completedArchiveDays: Number(data.get("completedArchiveDays")) }) }, "Regra de arquivo atualizada."); }}><label>Arquivar concluídas após<select name="completedArchiveDays" defaultValue={String(snapshot.settings.completedArchiveDays ?? 7)} disabled={!isAdmin || busy}><option value="1">1 dia</option><option value="3">3 dias</option><option value="7">7 dias</option><option value="15">15 dias</option><option value="30">30 dias</option><option value="0">Nunca</option></select></label>{isAdmin && <button className="primary-button" disabled={busy}>Salvar</button>}</form></section></div>;
}

export function FieldsSettings({ snapshot, busy, isAdmin, onCatalog, onConfirm }: { snapshot: WorkspaceSnapshot; busy: boolean; isAdmin: boolean; onCatalog: CatalogHandler; onConfirm: ConfirmHandler }) {
  async function createLabel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const next = await onCatalog({ resource: "label", name: data.get("name"), color: data.get("color") }, "Etiqueta criada.");
    if (next) form.reset();
  }
  async function createField(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const next = await onCatalog({ resource: "field", name: data.get("name"), fieldKey: data.get("fieldKey"), fieldType: data.get("fieldType"), required: data.get("required") === "on", options: String(data.get("options") ?? "").split(",").map((item) => item.trim()).filter(Boolean) }, "Campo personalizado criado.");
    if (next) form.reset();
  }
  return (
    <div className="settings-stack">
      <section className="catalog-section">
        <header><div><strong>Etiquetas operacionais</strong><span>Cores para urgência, área ou classificação complementar.</span></div><b>{snapshot.labels.length}</b></header>
        <div className="label-catalog">
          {snapshot.labels.map((label) => <article key={label.id}><i style={{ backgroundColor: label.color }} /><strong>{label.name}</strong>{isAdmin && <button disabled={busy} onClick={() => onConfirm({ title: "Excluir etiqueta?", description: `A etiqueta “${label.name}” será removida da operação.`, confirmLabel: "Excluir etiqueta", action: () => onCatalog({ resource: "label", operation: "delete", id: label.id }, "Etiqueta excluída.") })} aria-label={`Excluir ${label.name}`}>×</button>}</article>)}
        </div>
        {isAdmin && <form className="catalog-form compact" onSubmit={createLabel}><label>Nome<input name="name" maxLength={40} placeholder="Ex.: Urgente" required /></label><label>Cor<select name="color" defaultValue="#dc2626"><option value="#dc2626">Vermelho</option><option value="#ea580c">Laranja</option><option value="#d97706">Amarelo</option><option value="#16a34a">Verde</option><option value="#0891b2">Ciano</option><option value="#2563eb">Azul</option><option value="#7c3aed">Roxo</option><option value="#64748b">Cinza</option></select></label><button className="primary-button" disabled={busy}>Adicionar</button></form>}
      </section>
      <section className="catalog-section">
        <header><div><strong>Campos personalizados</strong><span>Dados estruturados visíveis nos cartões de DP.</span></div><b>{snapshot.customFields.length}</b></header>
        <div className="field-catalog">
          {snapshot.customFields.map((field) => <article key={field.id}><div><strong>{field.name}{field.required && <em>Obrigatório</em>}</strong><small>{field.fieldKey} • {field.fieldType}{field.options.length ? ` • ${field.options.join(", ")}` : ""}</small></div>{isAdmin && <button disabled={busy} onClick={() => onConfirm({ title: "Excluir campo?", description: `O campo “${field.name}” deixará de estar disponível nas demandas.`, confirmLabel: "Excluir campo", action: () => onCatalog({ resource: "field", operation: "delete", id: field.id }, "Campo excluído.") })} aria-label={`Excluir ${field.name}`}>×</button>}</article>)}
        </div>
        {isAdmin && <form className="catalog-form fields-form" onSubmit={createField}><label>Nome<input name="name" placeholder="Ex.: Matrícula" maxLength={60} required /></label><label>Identificador<input name="fieldKey" placeholder="matricula" pattern="[A-Za-z0-9_]+" required /></label><label>Tipo<select name="fieldType" defaultValue="text"><option value="text">Texto</option><option value="number">Número</option><option value="date">Data</option><option value="select">Lista</option></select></label><label className="wide">Opções da lista<input name="options" placeholder="Opção 1, Opção 2" /></label><label className="catalog-check"><input type="checkbox" name="required" /> Obrigatório</label><button className="primary-button" disabled={busy}>Criar campo</button></form>}
      </section>
    </div>
  );
}

export function TemplatesSettings({ snapshot, busy, isAdmin, onCatalog, onConfirm, onUseTemplate }: { snapshot: WorkspaceSnapshot; busy: boolean; isAdmin: boolean; onCatalog: CatalogHandler; onConfirm: ConfirmHandler; onUseTemplate: (id: string) => void }) {
  async function createTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const checklist = String(data.get("checklist") ?? "").split("\n").map((item) => item.trim()).filter(Boolean);
    const next = await onCatalog({ resource: "template", name: data.get("name"), processType: data.get("processType"), description: data.get("description"), checklist, defaultSlaDays: Number(data.get("defaultSlaDays")) }, "Template criado.");
    if (next) form.reset();
  }
  return (
    <div className="settings-stack">
      <section className="catalog-section">
        <header><div><strong>Templates de processos</strong><span>Checklists e SLA prontos para iniciar uma demanda sem esquecer etapas.</span></div><b>{snapshot.templates.length}</b></header>
        <div className="template-catalog">
          {snapshot.templates.map((template) => <article key={template.id}><div><span>{template.processType}</span><strong>{template.name}</strong><small>{contagem(template.checklist.length, "etapa", "etapas")} • SLA de {contagem(template.defaultSlaDays, "dia", "dias")} útil(eis)</small></div><button onClick={() => onUseTemplate(template.id)}>Usar</button>{isAdmin && <button className="danger" disabled={busy} onClick={() => onConfirm({ title: "Excluir template?", description: `O template “${template.name}” e seu checklist padrão serão removidos.`, confirmLabel: "Excluir template", action: () => onCatalog({ resource: "template", operation: "delete", id: template.id }, "Template excluído.") })}>Excluir</button>}</article>)}
        </div>
      </section>
      {isAdmin && <section className="catalog-section"><header><div><strong>Novo template</strong><span>Uma etapa por linha no checklist.</span></div></header><form className="catalog-form template-form" onSubmit={createTemplate}><label>Nome<input name="name" placeholder="Ex.: Conciliação cadastral" required /></label><label>Processo<select name="processType" defaultValue="CONCILIAÇÃO CADASTRAL"><option>Conciliação cadastral</option><option>Férias</option><option>Rescisão</option><option>Benefícios</option><option>Folha</option><option>Cadastro</option><option>Outros</option></select></label><label>SLA (dias úteis)<input type="number" min="1" max="60" name="defaultSlaDays" defaultValue="3" required /></label><label className="wide">Descrição<textarea name="description" rows={2} placeholder="Orientações para o processo" /></label><label className="wide">Etapas<textarea name="checklist" rows={7} placeholder={'Importar dados concluídos\nVincular registros\nTratar divergências'} required /></label><button className="primary-button" disabled={busy}>Salvar template</button></form></section>}
    </div>
  );
}

export function RulesSettings({ snapshot, busy, isAdmin, onCatalog, onConfirm }: { snapshot: WorkspaceSnapshot; busy: boolean; isAdmin: boolean; onCatalog: CatalogHandler; onConfirm: ConfirmHandler }) {
  type ConditionType = "always" | "processType" | "priority" | "toList";
  type ActionType = "moveTo" | "slaStatus" | "labelId" | "notify";
  /* Rótulos e gatilhos vêm de `lib/automation-rules` (§27): a tela que
     oferecesse um gatilho a mais entregaria uma regra que o servidor recusa, e
     um a menos esconderia automação que o motor executa. */
  const triggerLabels = RULE_TRIGGER_LABELS as Record<string, string>;
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("card.created");
  const [conditionType, setConditionType] = useState<ConditionType>("always");
  const [conditionValue, setConditionValue] = useState("");
  const [actionType, setActionType] = useState<ActionType>("moveTo");
  const [actionValue, setActionValue] = useState("");
  const [editorError, setEditorError] = useState("");

  const actionLabel = (action: Record<string, unknown>) => {
    if (typeof action.moveTo === "string") return `mover para ${snapshot.lists.find((list) => list.kind === action.moveTo)?.name ?? action.moveTo}`;
    if (typeof action.slaStatus === "string") return action.slaStatus === "overdue" ? "marcar SLA como atrasado" : action.slaStatus === "completed" ? "marcar como concluída" : action.slaStatus === "paused" ? "pausar o SLA" : "recalcular o SLA";
    if (typeof action.labelId === "string") return `aplicar etiqueta ${snapshot.labels.find((label) => label.id === action.labelId)?.name ?? "selecionada"}`;
    if (typeof action.notify === "string") return `notificar o responsável: “${action.notify}”`;
    return "executar ação configurada";
  };
  const conditionLabel = (condition: Record<string, unknown>) => {
    if (condition.processType) return `processo é ${condition.processType}`;
    if (condition.priority) return `prioridade é ${condition.priority}`;
    if (condition.listKind) return `coluna é ${snapshot.lists.find((list) => list.kind === condition.listKind)?.name ?? condition.listKind}`;
    if (condition.assignee === "present") return "há responsável atribuído";
    if (condition.allItems === true) return "checklist completo";
    if (condition.dueAt === "past") return "prazo vencido";
    return "sem condição adicional";
  };
  const defaultActionFor = (nextTrigger: string): { type: ActionType; value: string } => {
    if (nextTrigger === "sla.tick") return { type: "slaStatus", value: "overdue" };
    if (nextTrigger === "checklist.completed") return { type: "moveTo", value: snapshot.lists.find((list) => list.kind === "done")?.kind ?? "" };
    if (nextTrigger === "assignee.added") return { type: "moveTo", value: snapshot.lists.find((list) => list.kind === "analysis")?.kind ?? "" };
    return { type: "moveTo", value: snapshot.lists[0]?.kind ?? "" };
  };
  function changeTrigger(nextTrigger: string) {
    setTrigger(nextTrigger);
    setConditionType("always");
    setConditionValue("");
    const nextAction = defaultActionFor(nextTrigger);
    setActionType(nextAction.type);
    setActionValue(nextAction.value);
  }
  function edit(rule?: WorkspaceSnapshot["rules"][number]) {
    setEditorOpen(true);
    setEditingId(rule?.id ?? null);
    setName(rule?.name ?? "");
    const nextTrigger = rule?.trigger ?? "card.created";
    setTrigger(nextTrigger);
    const condition = rule?.condition ?? {};
    if (typeof condition.processType === "string") { setConditionType("processType"); setConditionValue(condition.processType); }
    else if (typeof condition.priority === "string") { setConditionType("priority"); setConditionValue(condition.priority); }
    else if (typeof condition.listKind === "string") { setConditionType("toList"); setConditionValue(condition.listKind); }
    else { setConditionType("always"); setConditionValue(""); }
    const action = rule?.action ?? {};
    if (typeof action.slaStatus === "string") { setActionType("slaStatus"); setActionValue(action.slaStatus); }
    else if (typeof action.labelId === "string") { setActionType("labelId"); setActionValue(action.labelId); }
    else if (typeof action.moveTo === "string") { setActionType("moveTo"); setActionValue(action.moveTo); }
    else if (typeof action.notify === "string") { setActionType("notify"); setActionValue(action.notify); }
    else { const nextAction = defaultActionFor(nextTrigger); setActionType(nextAction.type); setActionValue(nextAction.value); }
    setEditorError("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    if (!actionValue) { setEditorError("Escolha a ação que a automação deverá executar."); return; }
    const fixedCondition = trigger === "assignee.added" ? { assignee: "present" } : trigger === "checklist.completed" ? { allItems: true } : trigger === "sla.tick" ? { dueAt: "past" } : {};
    const condition = conditionType === "processType" ? { processType: conditionValue } : conditionType === "priority" ? { priority: conditionValue } : conditionType === "toList" ? { listKind: conditionValue } : fixedCondition;
    const action = actionType === "moveTo" ? { moveTo: actionValue } : actionType === "slaStatus" ? { slaStatus: actionValue } : actionType === "notify" ? { notify: actionValue } : { labelId: actionValue };
    const result = await onCatalog({ resource: "rule", operation: editingId ? "update" : "create", id: editingId ?? "", name, trigger, condition, action, enabled: true }, editingId ? "Automação atualizada." : "Automação criada.");
    if (result) setEditorOpen(false);
  }
  const showConditionSelector = trigger === "card.created" || trigger === "card.moved";
  const fixedConditionText = trigger === "assignee.added" ? "Só continua se houver um responsável atribuído." : trigger === "checklist.completed" ? "Só continua quando todas as etapas estiverem concluídas." : trigger === "sla.tick" ? "Só continua quando o prazo estiver vencido." : "Sem condição adicional.";

  return <div className="settings-stack"><section className="catalog-section rules-editor"><header><div><strong>Editor No-Code</strong><span>Regras ativas que executam tarefas automaticamente no fluxo do DP.</span></div>{isAdmin && <button className="secondary-button" onClick={() => edit()}><Plus aria-hidden="true" /> Nova regra</button>}</header><div className="rule-catalog no-code-rule-catalog">{snapshot.rules.length === 0 && <div className="empty-view"><span><ListChecks aria-hidden="true" /></span><strong>Nenhuma automação criada</strong><p>Crie uma regra para padronizar o fluxo da sua operação.</p></div>}{snapshot.rules.map((rule) => <article key={rule.id}><div><strong>{rule.name}</strong><div className="rule-flow"><span>Quando {triggerLabels[rule.trigger] ?? rule.trigger}</span><ArrowRight aria-hidden="true" /><span>Se {conditionLabel(rule.condition)}</span><ArrowRight aria-hidden="true" /><span>Então {actionLabel(rule.action)}</span></div></div>{isAdmin && <><button onClick={() => edit(rule)}>Editar</button><button className="danger" disabled={busy} onClick={() => onConfirm({ title: "Excluir automação?", description: `A regra “${rule.name}” deixará de ser executada na operação.`, confirmLabel: "Excluir automação", action: () => onCatalog({ resource: "rule", operation: "delete", id: rule.id }, "Automação excluída.") })}>Excluir</button></>}</article>)}</div></section>{isAdmin && editorOpen && <form className="catalog-section rule-editor-form no-code-editor" onSubmit={save}><header><div><strong>{editingId ? "Editar automação" : "Nova automação"}</strong><span>Escolha o evento, a condição e o resultado desejado. O sistema traduz isso para uma regra auditável.</span></div><button type="button" className="danger-link" onClick={() => setEditorOpen(false)}>Cancelar</button></header><div className="no-code-editor-body"><label className="wide">Nome da automação<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Ao concluir checklist, finalizar demanda" required /></label><section><span>1. Quando</span><label>Gatilho<select value={trigger} onChange={(event) => changeTrigger(event.target.value)}>{RULE_TRIGGERS.map((item) => <option key={item} value={item}>Quando {RULE_TRIGGER_LABELS[item]}</option>)}</select></label></section><ArrowRight className="flow-arrow" aria-hidden="true" /><section><span>2. Se</span>{showConditionSelector ? <><label>Condição<select value={conditionType} onChange={(event) => { setConditionType(event.target.value as ConditionType); setConditionValue(""); }}><option value="always">Sem condição adicional</option>{trigger === "card.created" && <><option value="processType">O processo for</option><option value="priority">A prioridade for</option></>}{trigger === "card.moved" && <option value="toList">A coluna de destino for</option>}</select></label>{conditionType === "processType" && <label>Processo<select value={conditionValue} onChange={(event) => setConditionValue(event.target.value)} required><option value="">Selecione</option>{["ADMISSÃO", "FÉRIAS", "RESCISÃO", "BENEFÍCIOS", "FOLHA", "CADASTRO", "OUTROS"].map((item) => <option key={item}>{item}</option>)}</select></label>}{conditionType === "priority" && <label>Prioridade<select value={conditionValue} onChange={(event) => setConditionValue(event.target.value)} required><option value="">Selecione</option>{["low", "normal", "high", "urgent"].map((nivel) => <option key={nivel} value={nivel}>{PRIORITY_LABELS[nivel]}</option>)}</select></label>}{conditionType === "toList" && <label>Coluna<select value={conditionValue} onChange={(event) => setConditionValue(event.target.value)} required><option value="">Selecione</option>{snapshot.lists.map((list) => <option value={list.kind} key={list.id}>{list.name}</option>)}</select></label>}</> : <div className="fixed-rule-condition"><CheckCircle2 aria-hidden="true" />{fixedConditionText}</div>}</section><ArrowRight className="flow-arrow" aria-hidden="true" /><section><span>3. Então</span><label>Ação<select value={actionType} onChange={(event) => { setActionType(event.target.value as ActionType); setActionValue(""); }}><option value="moveTo">Mover a demanda</option><option value="slaStatus">Atualizar o SLA</option><option value="labelId">Aplicar uma etiqueta</option><option value="notify">Notificar o responsável</option></select></label>{actionType === "moveTo" && <label>Coluna de destino<select value={actionValue} onChange={(event) => setActionValue(event.target.value)} required><option value="">Selecione</option>{snapshot.lists.map((list) => <option value={list.kind} key={list.id}>{list.name}</option>)}</select></label>}{actionType === "slaStatus" && <label>Novo status<select value={actionValue} onChange={(event) => setActionValue(event.target.value)} required><option value="">Selecione</option><option value="safe">Dentro do prazo</option><option value="overdue">Atrasado</option><option value="paused">Pausado</option><option value="completed">Concluído</option></select></label>}{actionType === "labelId" && <label>Etiqueta<select value={actionValue} onChange={(event) => setActionValue(event.target.value)} required><option value="">Selecione</option>{snapshot.labels.map((label) => <option value={label.id} key={label.id}>{label.name}</option>)}</select></label>}{actionType === "notify" && <label>Aviso<input value={actionValue} onChange={(event) => setActionValue(event.target.value)} maxLength={160} placeholder="Ex.: Documentação vencida — conferir a demanda" required /></label>}</section></div>{editorError && <p className="no-code-editor-error" role="alert"><CircleAlert aria-hidden="true" />{editorError}</p>}<footer><span>Prévia: Quando {triggerLabels[trigger] ?? trigger}, se {conditionType === "always" ? fixedConditionText.toLowerCase() : "a condição selecionada for atendida"}, então {actionType === "moveTo" ? "a demanda será movida" : actionType === "slaStatus" ? "o SLA será atualizado" : actionType === "notify" ? "quem responde pela demanda será avisado" : "uma etiqueta será aplicada"}.</span><button className="primary-button" disabled={busy}>Salvar automação</button></footer></form>}</div>;
}
