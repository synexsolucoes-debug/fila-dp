import type { Metadata } from "next";
import { chatGPTSignOutPath, requireChatGPTUser } from "../chatgpt-auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Painel | Fila DP",
  description: "Acompanhe a fila de demandas do Departamento Pessoal.",
};

const columns = [
  {
    title: "Novas demandas",
    tone: "new",
    cards: [
      { label: "ADMISSÃO", labelTone: "blue", title: "Admissão — Maria Oliveira", company: "Synex Soluções • Ago/26", sla: "Vence hoje", slaTone: "warning", progress: "2/7" },
      { label: "FÉRIAS", labelTone: "purple", title: "Aviso de férias — João Lima", company: "Unidade São Paulo", sla: "3 dias", slaTone: "safe", progress: "2/5" },
    ],
  },
  {
    title: "Em análise",
    tone: "doing",
    cards: [
      { label: "BENEFÍCIOS", labelTone: "green", title: "Inclusão no plano de saúde", company: "Matrícula 0482", sla: "2 dias", slaTone: "safe", progress: "4/6" },
      { label: "RESCISÃO", labelTone: "orange", title: "Conferência de cálculo rescisório", company: "Empresa Sul", sla: "Atenção", slaTone: "warning", progress: "3/8" },
    ],
  },
  {
    title: "Aguardando documentos",
    tone: "waiting",
    cards: [
      { label: "ADMISSÃO", labelTone: "blue", title: "Documentos pendentes — Ana Reis", company: "Aguardando solicitante", sla: "SLA pausado", slaTone: "paused", progress: "5/7" },
      { label: "CADASTRO", labelTone: "gray", title: "Atualização de dados bancários", company: "Matrícula 0329", sla: "SLA pausado", slaTone: "paused", progress: "1/3" },
    ],
  },
  {
    title: "Concluído",
    tone: "done",
    cards: [
      { label: "FÉRIAS", labelTone: "purple", title: "Programação de férias — Carla Dias", company: "Finalizado hoje", sla: "No prazo", slaTone: "safe", progress: "5/5" },
    ],
  },
];

export default async function DashboardPage() {
  const user = await requireChatGPTUser("/painel");
  const initials = user.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "DP";

  return (
    <main className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <a className="brand dashboard-brand" href="/painel" aria-label="Fila DP — painel">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Fila <strong>DP</strong></span>
        </a>
        <nav aria-label="Navegação do painel">
          <a className="active" href="/painel"><span aria-hidden="true">▦</span> Quadro</a>
          <a href="#inbox"><span aria-hidden="true">▣</span> Caixa de entrada <b>4</b></a>
          <a href="#planner"><span aria-hidden="true">□</span> Meu planner</a>
          <a href="#relatorios"><span aria-hidden="true">⌁</span> Indicadores</a>
        </nav>
        <div className="sidebar-workspace">
          <span>WORKSPACE</span>
          <button><i>SD</i><strong>Synex DP</strong><span>⌄</span></button>
        </div>
        <div className="sidebar-account">
          <span className="user-avatar">{initials}</span>
          <span><strong>{user.displayName}</strong><small>{user.email}</small></span>
          <a href={chatGPTSignOutPath("/")} aria-label="Sair do Fila DP">↗</a>
        </div>
      </aside>

      <section className="dashboard-main">
        <header className="dashboard-header">
          <div><span>Departamento Pessoal /</span><strong> Fila geral</strong></div>
          <div className="dashboard-header-actions">
            <button aria-label="Pesquisar">⌕</button>
            <button aria-label="Notificações">♢<i /></button>
            <button className="new-demand">＋ Nova demanda</button>
          </div>
        </header>

        <div className="dashboard-content">
          <div className="dashboard-heading">
            <div><span className="dashboard-eyebrow">VISÃO OPERACIONAL</span><h1>Bom dia, {user.fullName?.split(" ")[0] ?? user.displayName.split("@")[0]}.</h1><p>Estas são as prioridades da sua fila hoje.</p></div>
            <div className="dashboard-date"><span>Segunda-feira</span><strong>20 jul. 2026</strong></div>
          </div>

          <div className="dashboard-stats">
            <article><span>Demandas ativas</span><strong>17</strong><small>＋3 desde ontem</small></article>
            <article><span>Vencem hoje</span><strong>4</strong><small className="warning-text">Requer atenção</small></article>
            <article><span>Aguardando terceiros</span><strong>5</strong><small>SLA pausado</small></article>
            <article><span>Concluídas no prazo</span><strong>94%</strong><small className="safe-text">Últimos 30 dias</small></article>
          </div>

          <div className="dashboard-board-head">
            <div className="dashboard-tabs"><button className="active">Quadro</button><button>Tabela</button><button>Calendário</button></div>
            <div className="dashboard-filters"><button>Responsável: Todos ⌄</button><button>SLA: Todos ⌄</button><button>☷ Filtros</button></div>
          </div>

          <div className="dashboard-kanban">
            {columns.map((column) => (
              <section className="dashboard-column" key={column.title}>
                <header><span><i className={column.tone} />{column.title}</span><b>{column.cards.length}</b><button aria-label={`Opções de ${column.title}`}>•••</button></header>
                <div className="dashboard-card-list">
                  {column.cards.map((card) => (
                    <article className="dashboard-task" key={card.title}>
                      <div className="dashboard-task-labels"><span className={card.labelTone}>{card.label}</span></div>
                      <h2>{card.title}</h2>
                      <p>{card.company}</p>
                      <div className="dashboard-task-bottom"><span className={`dashboard-sla ${card.slaTone}`}>◷ {card.sla}</span><span className="dashboard-check">✓ {card.progress}</span><span className="dashboard-mini-avatar">{initials}</span></div>
                    </article>
                  ))}
                  <button className="dashboard-add-card">＋ Adicionar demanda</button>
                </div>
              </section>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
