"use client";

import { useState } from "react";
import { ArrowRight, Cable, CalendarClock, CheckCircle2, ClipboardList, Clock3, GitBranch, Timer, type LucideIcon } from "lucide-react";
import { activityDetails, activityLabel, compactSlaLabel, formatDate, formatMoment, plural } from "./formatting";
import type { ActivityEvent, Card, WorkspaceSnapshot } from "@/lib/fila-dp-types";
import type { ActionTarget } from "@/lib/action-center";
import { connectionStatusLabel, connectionTone, lastSyncLabel } from "../shared";
import { contagem } from "../shared/plural";

/*
 * Visão geral do painel.
 *
 * Saiu de `WorkspaceApp.tsx`, que passava de 5.500 linhas: a Visão geral é a
 * maior tela que morava ali dentro, e só recebe dados prontos por props.
 */

export type OverviewFocusTarget = "board" | "processManagement" | "processes" | "integrations" | "history";

/**
 * A mesma obrigação, uma linha só, com a contagem de empresas.
 *
 * A consulta devolve **uma linha por empresa**: doze filiais com o mesmo
 * eSocial S-1299 ocupavam as seis vagas do painel com o mesmo prazo repetido,
 * e a sétima obrigação — de outro tipo, talvez mais urgente — não aparecia. A
 * especificação pede o formato agregado ("Empresas: 12"), e ele é o que deixa a
 * lista responder "o que vence", em vez de "onde vence".
 *
 * Agrupa por obrigação + competência + vencimento: mesma obrigação com prazos
 * diferentes são dois compromissos distintos, e juntá-los esconderia o mais
 * apertado atrás do mais folgado. Mantém o menor `daysRemaining` do grupo pelo
 * mesmo motivo.
 *
 * Sem consulta nova — é agregação do que o snapshot já traz.
 */
export function groupObligations(items: readonly WorkspaceSnapshot["upcomingObligations"][number][]) {
  const grupos = new Map<string, WorkspaceSnapshot["upcomingObligations"][number]
    & { companies: number }>();
  for (const item of items) {
    const chave = `${item.title}|${item.competence}|${item.dueDate}`;
    const atual = grupos.get(chave);
    if (!atual) { grupos.set(chave, { ...item, companies: 1 }); continue; }
    atual.companies += 1;
    if (item.daysRemaining < atual.daysRemaining) atual.daysRemaining = item.daysRemaining;
  }
  return [...grupos.values()];
}

/**
 * O fluxo da competência (Modelo 2, "Flow").
 *
 * No lugar da faixa marinho que dizia "N demanda(s) em andamento" — texto que
 * o indicador logo abaixo repetia, e cuja concordância "(s)" era ruído de
 * gerador. O fechamento é o fato mais estruturante do DP: a operação é cíclica
 * e fecha todo mês, e a interface não dizia isso em lugar nenhum.
 *
 * As cinco etapas são os estados que o servidor aceita (`cycleStatuses` em
 * lib/operations.ts), não uma sequência decorativa: avançar entre elas passa
 * pelos bloqueios de `describeClosingBlockers`.
 *
 * O estado é marcado por forma além de cor — ícone de concluído, anel na
 * etapa atual, contorno vazio no que falta — para funcionar também para quem
 * não distingue verde de azul.
 */
export function ConnectionMap({ integrations, onNavigate }: {
  integrations: WorkspaceSnapshot["integrations"];
  onNavigate: (target: ActionTarget) => void;
}) {
  // The overview summarizes connection state; configuration stays in Integrations.
  if (!integrations.length) {
    return <section className="connection-summary connection-summary-empty" aria-label="Conexões">
      <h3>Conexões</h3>
      <p>Nenhum conector configurado neste grupo. As integrações disponíveis aparecem em Estado das integrações.</p>
      <button type="button" className="secondary-button" onClick={() => onNavigate("integrations")}>Ver integrações</button>
    </section>;
  }

  /* O título é o total — o mesmo número de linhas da lista abaixo — e a
     situação vem quebrada por estado. Antes o título dizia "1 sistema
     conectado" em cima de uma lista com quatro sistemas e de um texto "de 5
     configurados": três números que pareciam se contradizer. */
  const porEstado = new Map<string, number>();
  for (const item of integrations) porEstado.set(item.status, (porEstado.get(item.status) ?? 0) + 1);
  const ordem = ["error", "needs_credentials", "connected", "paused"];
  const posicao = (status: string) => (ordem.includes(status) ? ordem.indexOf(status) : ordem.length);
  // Só "Conectada" e "Pausada" flexionam; "com erro" e "sem credencial" não.
  const rotulo = (status: string, total: number) => {
    const texto = connectionStatusLabel(status).toLowerCase();
    return total > 1 && texto.endsWith("a") ? `${texto}s` : texto;
  };
  const situacao = [...porEstado.entries()]
    .sort(([a], [b]) => posicao(a) - posicao(b))
    .map(([status, total]) => `${total} ${rotulo(status, total)}`)
    .join(" · ");

  return <section className="connection-summary" aria-label="Conexões">
    <header>
      <div>
        <span>Conexões</span>
        <strong>{plural(integrations.length, "conector neste grupo", "conectores neste grupo")}</strong>
        <p>{situacao}</p>
      </div>
      <button type="button" className="secondary-button" onClick={() => onNavigate("integrations")}>Ver integrações</button>
    </header>

    <div className="connection-summary-list">
      <ul>
        {integrations.map((item) => {
          const tom = connectionTone(item.status);
          return <li key={item.id} data-tone={tom}>
            {/* Os dois lados desta linha resolveram problemas diferentes no
                mesmo elemento, e os dois ficam:

                - o item virou botão, para que o conector leve ao próprio
                  detalhe em vez de só se anunciar;
                - a última sincronização passa a ser dita em QUALQUER estado, e
                  não só no conectado. Era justamente no conector com erro que
                  ela faltava — e é ali que ela responde a pergunta que importa:
                  há quanto tempo este sistema parou de trazer dado. Ausência
                  não vira data inventada: `lastSyncLabel(null)` diz "nunca
                  sincronizou". */}
            <button type="button" onClick={() => onNavigate("integrations")}
              aria-label={`Ver integração ${item.displayName}`}>
              <span>
                <strong>{item.displayName}</strong>
                <small>{connectionStatusLabel(item.status)} · {lastSyncLabel(item.lastSyncAt)}
                  {item.status === "error" ? " · Abra para consultar o diagnóstico" : ""}</small>
              </span>
            </button>
          </li>;
        })}
      </ul>
    </div>
  </section>;
}

export function OverviewView({ onNavigate, cards, lists, activities, stats, onOpen, onOpenBoard, scopeLabel, integrations, flows, obligations, periodLabel, onOpenCard, onFocus }: {
  onNavigate: (target: ActionTarget) => void;
  /** Demandas em execução, já sob os filtros do topo (§15). */
  flows: WorkspaceSnapshot["processFlows"];
  /** Obrigações em aberto, já sob os filtros do topo (§16). */
  obligations: WorkspaceSnapshot["upcomingObligations"];
  /** Rótulo do período escolhido, para os estados vazios dizerem o porquê. */
  periodLabel: string;
  onOpenCard: (cardId: string) => void;
  /**
   * Navega para o módulo já com o recorte de SLA aplicado (§14).
   *
   * Tipo próprio em vez de `ActionTarget`: aquele é a lista de destinos que
   * *resolvem uma pendência* da central de ação, e alargá-lo para caber um
   * indicador apagaria a razão de ele existir.
   */
  onFocus: (target: OverviewFocusTarget, sla: "all" | Card["slaStatus"]) => void;
  cards: Card[];
  lists: WorkspaceSnapshot["lists"];
  activities: ActivityEvent[];
  integrations: WorkspaceSnapshot["integrations"];
  stats: { active: number; attention: number; waiting: number; onTime: number | null; completed: number; documentsPending: number; activeCompanies: number };
  onOpen: (card: Card) => void;
  onOpenBoard: () => void;
  scopeLabel: string;
}) {
  /* Demanda por id, para a linha do histórico dizer a que ela se refere.
     `activities` e `cards` já vêm do mesmo snapshot e do mesmo recorte, então
     não há consulta nova; o evento cuja demanda o recorte não alcança fica sem
     a coluna, e não com o título de outra. */
  const cardById = new Map(cards.map((card) => [card.id, card]));

  /* A aba escolhida do bloco de status. Vazia = ainda não escolheram, e aí o
     padrão é a primeira coluna com demanda: abrir numa aba vazia faria a tela
     parecer sem dados quando há. */
  const [statusTab, setStatusTab] = useState("");
  const statusList = lists.find((list) => list.id === statusTab)
    ?? lists.find((list) => list.cards.length > 0)
    ?? lists[0]
    ?? null;
  const integrationsFailing = integrations.filter((item) => item.status === "error").length;

  /* Os números dos três contextos (§7.2).
     Todos derivam das mesmas demandas, fluxos e integrações que o snapshot já
     traz — nenhuma consulta nova, nenhum valor fixo. Onde não há dado, o texto
     diz que não há, em vez de mostrar zero como se fosse medição. */
  /* "Vence hoje" é `slaStatus === "warning"`, e não uma comparação de data
     feita aqui. A primeira versão deste bloco calculava pelo calendário e
     mostrava "Vencendo hoje: 0" logo acima de uma lista com três demandas
     etiquetadas "Vence hoje" — dois cálculos para a mesma pergunta, discordando
     na mesma tela. Quem decide o que é hoje é o SLA, que conhece expediente e
     feriado; o calendário do navegador não. `compactSlaLabel` já traduz esse
     status com estas mesmas palavras no cartão. */
  const venceHoje = cards.filter((card) => card.slaStatus === "warning").length;
  const atrasadas = cards.filter((card) => card.slaStatus === "overdue").length;
  const hojeExigeAcao = venceHoje + atrasadas > 0;
  /* Duas contagens diferentes, e o indicador usa as duas:

     - `flows.length` é a ocorrência real — cada linha é uma demanda em execução
       vinculada à versão que a instanciou. É o que "Fluxos em andamento" conta,
       e é o que o valor do indicador mostra.
     - `processosEmExecucao` são os modelos DISTINTOS por trás dessas
       ocorrências. Doze admissões correndo são um processo com doze demandas, e
       chamá-las de doze processos diria que a operação roda doze fluxos
       diferentes — a confusão entre modelo e execução que o §4 separa.

     Por isso a frase de apoio do indicador diz "N processos distintos": ela
     qualifica o número de cima em vez de repeti-lo. */
  const processosEmExecucao = new Set(flows.map((flow) => flow.definitionId)).size;
  const integracoesConectadas = integrations.filter((item) => item.status === "connected").length;
  const obrigacoesVencidas = obligations.filter((item) => item.daysRemaining < 0).length;
  const ultimaSincronizacao = (() => {
    const marcas = integrations.map((item) => item.lastSyncAt).filter((value): value is string => Boolean(value));
    if (marcas.length === 0) return null;
    const recente = marcas.reduce((maior, atual) => (atual > maior ? atual : maior));
    return new Date(recente).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  })();

  /* Os cinco indicadores da maquete.
     Cada um traz um número e a frase que o qualifica. A maquete desenha uma
     variação percentual ao lado do número — "+12% vs. mês anterior" — e ela
     não entra: o snapshot não carrega nenhuma série histórica, então o
     percentual teria de ser inventado, que é o que a §13 proíbe em primeiro
     lugar. No lugar dele vai um segundo fato medido: o número que explica o
     primeiro. É a mesma linha de texto e diz algo verdadeiro.

     Nada foi perdido dos três contextos que estavam aqui: os sete valores que
     eles mostravam continuam na tela, seis deles como a frase de apoio de um
     indicador. */
  const kpis: Array<{
    key: string;
    icon: LucideIcon;
    label: string;
    value: string;
    support: string;
    target: OverviewFocusTarget;
    sla: "all" | "overdue";
    /** Pinta o cartão de alerta — sempre derivado de um número, nunca fixo. */
    alert: boolean;
    /** Só o SLA tem barra: é o único indicador que é uma proporção. */
    bar?: number | null;
  }> = [
    {
      key: "demands-open", icon: ClipboardList, label: "Demandas em aberto",
      value: String(stats.active),
      support: `${contagem(stats.completed, "concluída", "concluídas")} no período · ${stats.waiting} aguardando terceiros`,
      target: "board", sla: "all", alert: false,
    },
    {
      key: "flows-running", icon: GitBranch, label: "Fluxos em andamento",
      value: String(flows.length),
      /* Processos DISTINTOS, não fluxos: doze admissões correndo são um
         processo com doze demandas, e contá-las como doze processos diria que
         a operação roda doze fluxos diferentes (§4). */
      support: `${plural(processosEmExecucao, "processo distinto", "processos distintos")} · ${contagem(stats.documentsPending, "tarefa pendente", "tarefas pendentes")}`,
      target: "processManagement", sla: "all", alert: false,
    },
    {
      key: "obligations-due", icon: CalendarClock, label: "Obrigações próximas",
      value: String(obligations.length),
      support: obrigacoesVencidas
        ? `${obrigacoesVencidas} já vencida(s)`
        : "Nenhuma vencida até agora",
      target: "processes", sla: "all", alert: obrigacoesVencidas > 0,
    },
    {
      key: "integrations-failing", icon: Cable, label: "Integrações com erro",
      value: String(integrationsFailing),
      /* Sem sincronização registrada o certo é dizer isso, e não uma data de
         mentira nem um traço que parece dado que faltou carregar. */
      support: `${contagem(integracoesConectadas, "conectada", "conectadas")} · última sincronização ${ultimaSincronizacao ?? "Nunca"}`,
      target: "integrations", sla: "all", alert: integrationsFailing > 0,
    },
    {
      key: "sla-on-time", icon: Timer, label: "SLA no prazo",
      /* Sem demanda no recorte não há percentual: o número mais tranquilizador
         da tela não pode aparecer justamente quando não há evidência nenhuma
         para tranquilizar ninguém. */
      value: stats.onTime === null ? "—" : `${stats.onTime}%`,
      /* O percentual mede as demandas EM ABERTO que não estouraram o prazo, e
         não as concluídas — populações diferentes. A frase de apoio abre o
         número em atraso e vencimento de hoje, que é o que faz alguém agir. */
      support: stats.onTime === null
        ? "Sem demandas em aberto neste recorte"
        : `das demandas em aberto · ${contagem(atrasadas, "atrasada", "atrasadas")} · ${venceHoje} vencendo hoje`,
      target: "board", sla: "overdue", alert: hojeExigeAcao,
      bar: stats.onTime,
    },
  ];

  return <div className="overview-layout">

    {/* A ordem desta tela é a §93: “a Visão Geral deve parecer uma central de
       operação; evitar dashboard genérico de cards”.

       Medido antes de mexer, com 15 demandas reais no banco: a página tinha
       2738px e o indicador "Demandas em aberto" ficava em y=1610 — quase duas
       telas abaixo do topo. Para saber quantas demandas estavam abertas era
       preciso rolar duas vezes. Os 1610px anteriores eram a competência, três
       blocos que quase sempre estão vazios e 480px de cartões de módulo que
       repetem, um a um, o menu que já está na barra lateral.

       A correção é de ordem, não de estética. Uma sala de controle abre com o
       estado da operação; o menu não é o estado da operação. A sequência agora
       responde, de cima para baixo: quanto há, o que está travado, em que mês
       estamos, o que está correndo e o que vence, como andam os sistemas, e só
       então consulta e navegação. */}

    {/* Faixa de indicadores (§14).
        Cada número que tem onde ser resolvido virou botão: ler "3 integrações
        com erro" e não ter caminho para elas é o indicador cobrando uma ação
        que ele mesmo não deixa tomar. Os que não têm destino próprio seguem
        como texto — link que leva ao lugar errado é pior que nenhum.

        "SLA no prazo" não entra aqui: ele tem a faixa logo abaixo, inteira,
        com barra e contagem. Repeti-lo como sexto cartão seria o mesmo número
        duas vezes na mesma dobra. */}
    {/* Cinco indicadores, como a maquete pede.
        O recorte vigente fica escrito ao lado do título: um número sem o
        conjunto que ele mede é um número sobre nada, e a Visão geral tem dois
        filtros no topo que mudam os cinco de uma vez.

        `data-metric` é o ponto de ancoragem do ensaio de navegador. Ele mirava
        `.overview-metrics article strong` e `.first()`; quando os indicadores
        viraram botão, `.first()` passou a devolver "Documentos pendentes" — que
        é 0 tanto no grupo quanto numa filial vazia, então a conferência do
        recorte por empresa comparava 0 com 0 e reprovava. Ancorar no que o
        indicador *é* faz a mudança de elemento, de grupo ou de ordem não
        quebrar o ensaio — foi o que permitiu esta reorganização.

        Cada indicador é botão porque cada um tem onde ser resolvido: ler "3
        integrações com erro" e não ter caminho para elas é o indicador cobrando
        uma ação que ele mesmo não deixa tomar. */}
    <section className="overview-kpis" aria-label={`Indicadores da operação — ${scopeLabel}`}>
      {kpis.map((kpi) => {
        return <button type="button" key={kpi.key} data-metric={kpi.key}
          className={`overview-kpi${kpi.alert ? " requires-attention" : ""}`}
          onClick={() => onFocus(kpi.target, kpi.sla)}>
          <span className="overview-kpi-top">
            <span className="overview-kpi-label">{kpi.label}</span>
          </span>
          <strong className="overview-kpi-value">{kpi.value}</strong>
          {/* Barra sem número para representar não deve ser desenhada. */}
          {typeof kpi.bar === "number" && <span className="overview-kpi-bar" aria-hidden="true">
            <i style={{ width: `${Math.max(0, Math.min(100, kpi.bar))}%` }} />
          </span>}
          <small className="overview-kpi-support">{kpi.support}</small>
        </button>;
      })}
    </section>


    {/* Fluxos em andamento (§15) e próximos vencimentos (§16).
        As duas perguntas que o quadro não responde: ele mostra demandas soltas
        por coluna, não o processo que as gerou nem a data legal que não espera
        ninguém.

        Os dois viraram tabela, como a maquete pede. Cartão e tabela servem a
        leituras diferentes: o cartão é bom para ler um, a tabela é boa para
        comparar seis. Quem abre a Visão geral está escolhendo o que abrir, e
        para isso compara — a coluna alinhada deixa "etapa" embaixo de "etapa" e
        "responsável" embaixo de "responsável", que é o que o cartão não fazia.

        Lado a lado, como a maquete põe. Eles já estiveram assim, viraram
        largura inteira quando cinco colunas num painel de meia largura cortavam
        a última — "SITU…" no lugar de "SITUAÇÃO" —, e voltam agora com a
        largura das colunas resolvida no lugar certo: as células apertam o recuo
        e o título da demanda cede espaço, porque ele já tem reticências
        previstas e a etiqueta de prazo não tem. */}
    <div className="overview-pair">
        <section className="overview-panel flows-panel" aria-labelledby="overview-flows-title">
        <header>
          <div><h2 id="overview-flows-title">Fluxos em andamento</h2></div>
          <button type="button" onClick={() => onFocus("processManagement", "all")}>Ver processos <ArrowRight aria-hidden="true" /></button>
        </header>
        <div className="overview-flow-list">
          {flows.length === 0 && <div className="overview-empty">
            <GitBranch aria-hidden="true" />
            <strong>Nenhum processo em execução.</strong>
            {/* O vazio diz qual dos dois casos é: não há demanda instanciada, ou
                o recorte escolhido é que não alcança nenhuma. */}
            <p>{periodLabel === "Todo o período"
              ? "Demandas criadas a partir de um processo publicado aparecem aqui com a etapa atual."
              : `Nenhuma demanda de processo com prazo em ${periodLabel.toLowerCase()}.`}</p>
          </div>}
          {flows.length > 0 && <div className="overview-table-scroll">
            <table className="overview-table overview-flow-table">
              <thead><tr>
                <th scope="col">Processo</th>
                <th scope="col">Etapa atual</th>
                <th scope="col">Progresso</th>
                <th scope="col">Responsável</th>
                <th scope="col">Situação</th>
              </tr></thead>
              <tbody>
                {flows.slice(0, 6).map((flow) => <tr key={flow.cardId} className={`sla-${flow.slaStatus}`}>
                  <td>
                    {/* A linha inteira não vira clicável: `<tr onClick>` não
                        recebe foco nem é anunciado como destino. O caminho para
                        a demanda é este botão, que é um elemento de verdade. */}
                    <button type="button" className="overview-table-link" onClick={() => onOpenCard(flow.cardId)}>
                      <strong>{flow.definitionName}</strong>
                      <small>{flow.cardTitle}</small>
                    </button>
                    {flow.versionNumber && <em className="overview-version-tag"
                      title={`Versão instanciada nesta demanda: ${flow.versionNumber}`}>v{flow.versionNumber}</em>}
                  </td>
                  <td>{flow.stepLabel || "Não iniciada"}</td>
                  {/* A barra e o "7 de 18" dizem a mesma coisa de duas formas
                      porque percentual sozinho não diz o tamanho do processo:
                      50% de duas tarefas e 50% de quarenta pedem decisões
                      diferentes. */}
                  <td className="overview-progress-cell">
                    {/* Barra sem número para representar não é desenhada: com
                        `tasksTotal` em zero ela ficava vazia na tela, e barra
                        vazia se lê como "0% concluído" — que é afirmar um
                        progresso onde não há nem denominador. */}
                    {flow.tasksTotal > 0 && <span className="overview-flow-progress" role="img"
                      aria-label={`${flow.progress}% concluído, ${flow.tasksDone} de ${flow.tasksTotal} tarefas`}>
                      <i style={{ width: `${Math.max(0, Math.min(100, flow.progress))}%` }} />
                    </span>}
                    <small>{flow.tasksTotal ? `${flow.tasksDone} de ${flow.tasksTotal} tarefas · ${flow.progress}%` : "Sem tarefas instanciadas"}</small>
                  </td>
                  <td>{flow.responsibleName || "Sem responsável"}</td>
                  {/* Cor sozinha não carrega o dado: o estado do prazo continua
                      escrito, com as mesmas palavras do cartão do quadro. */}
                  <td><span className={`overview-sla-tag sla-${flow.slaStatus}`}>{compactSlaLabel(flow.slaStatus, flow.dueAt)}</span></td>
                </tr>)}
              </tbody>
            </table>
          </div>}
        </div>
      </section>

      <section className="overview-panel obligations-panel" aria-labelledby="overview-obligations-title">
        <header>
          <div><h2 id="overview-obligations-title">Próximos vencimentos</h2></div>
          <button type="button" onClick={() => onFocus("processes", "all")}>Ver calendário <ArrowRight aria-hidden="true" /></button>
        </header>
        <div className="overview-obligation-list">
          {obligations.length === 0 && <div className="overview-empty">
            <CheckCircle2 aria-hidden="true" />
            <strong>Nenhuma obrigação em aberto.</strong>
            <p>{periodLabel === "Todo o período"
              ? "eSocial, FGTS Digital, DCTFWeb e demais obrigações aparecem aqui conforme o vencimento."
              : `Nenhum vencimento em ${periodLabel.toLowerCase()}.`}</p>
          </div>}
          {obligations.length > 0 && <div className="overview-table-scroll">
            <table className="overview-table overview-obligation-table">
              <thead><tr>
                <th scope="col">Obrigação</th>
                <th scope="col">Empresa</th>
                <th scope="col">Competência</th>
                <th scope="col">Vencimento</th>
                <th scope="col">Situação</th>
              </tr></thead>
              <tbody>
                {groupObligations(obligations).slice(0, 6).map((item) => <tr key={item.id}
                  className={`overview-obligation ${item.daysRemaining < 0 ? "overdue" : item.daysRemaining <= 3 ? "warning" : "safe"}`}>
                  <td><strong>{item.title}</strong></td>
                  {/* A consulta devolve uma linha por empresa; doze filiais com o
                      mesmo eSocial ocupariam as seis vagas com o mesmo prazo. */}
                  <td>{item.companies > 1 ? `${item.companies} empresas` : item.company || "Sem empresa"}</td>
                  <td>{item.competence || "—"}</td>
                  <td>{formatDate(item.dueDate)}</td>
                  {/* "Vence em -2 dias" é o tipo de frase que só um sistema
                      escreve. O atraso é dito como atraso. */}
                  <td><span className="overview-obligation-due">{item.daysRemaining < 0
                    ? `${contagem(Math.abs(item.daysRemaining), "dia", "dias")} em atraso`
                    : item.daysRemaining === 0 ? "Vence hoje" : `Em ${contagem(item.daysRemaining, "dia", "dias")}`}</span></td>
                </tr>)}
              </tbody>
            </table>
          </div>}
        </div>
      </section>
    </div>

    {/* Demandas por status e saúde das integrações lado a lado, como a
        maquete põe. "Atenção hoje" saiu daqui: ele repetia, em cartões, as
        mesmas demandas que a tabela de status mostra em linha — e a maquete
        não o tem. Quem precisa do recorte de atraso chega por ele pelo
        indicador de SLA, que leva ao quadro já filtrado. */}
    <div className="overview-grid">
      {/* Demandas por status: uma aba por coluna, tabela embaixo.
          O bloco era um gráfico de barras — respondia "quantas em cada coluna" e
          parava aí. A pergunta seguinte, "quais são", exigia sair da tela. As
          abas guardam a primeira resposta (a contagem está no próprio rótulo) e
          destravam a segunda sem trocar de página.

          As colunas são as do quadro deste grupo, não uma lista escrita aqui:
          quem renomeia "Em execução" para "Na fila" lê "Na fila" nesta aba. */}
      <section className="overview-panel status-panel" aria-labelledby="overview-status-title">
        <header>
          <div><h2 id="overview-status-title">Demandas na operação</h2></div>
          <button onClick={onOpenBoard}>Abrir demandas <ArrowRight aria-hidden="true" /></button>
        </header>
        {lists.length === 0
          ? <div className="overview-empty">
              <ClipboardList aria-hidden="true" />
              <strong>Nenhuma coluna configurada.</strong>
              <p>As colunas do quadro definem os status que aparecem aqui.</p>
            </div>
          : <>
              <div className="overview-status-tabs" role="tablist" aria-label="Status das demandas">
                {lists.map((list) => <button type="button" key={list.id} role="tab"
                  id={`overview-status-tab-${list.id}`}
                  aria-selected={statusList?.id === list.id}
                  aria-controls={statusList?.id === list.id ? `overview-status-panel-${list.id}` : undefined}
                  onClick={() => setStatusTab(list.id)}>
                  {list.name}<b>{list.cards.length}</b>
                </button>)}
              </div>
              {statusList && <div className="overview-status-body" role="tabpanel"
                id={`overview-status-panel-${statusList.id}`}
                aria-labelledby={`overview-status-tab-${statusList.id}`}>
                {statusList.cards.length === 0
                  ? <p className="overview-status-vazio">Nenhuma demanda em {statusList.name} neste recorte.</p>
                  : <div className="overview-table-scroll">
                      <table className="overview-table overview-status-table">
                        <thead><tr>
                          <th scope="col">Demanda</th>
                          <th scope="col">Empresa</th>
                          <th scope="col">Responsável</th>
                          <th scope="col">Prazo</th>
                        </tr></thead>
                        <tbody>
                          {statusList.cards.slice(0, 6).map((card) => <tr key={card.id} className={`sla-${card.slaStatus}`}>
                            <td>
                              <button type="button" className="overview-table-link" onClick={() => onOpen(card)}>
                                <strong>{card.title}</strong>
                                <small>{card.processType}</small>
                              </button>
                            </td>
                            <td>{card.company || "Sem empresa"}</td>
                            <td>{card.assigneeName || "Sem responsável"}</td>
                            <td><span className={`overview-sla-tag sla-${card.slaStatus}`}>{compactSlaLabel(card.slaStatus, card.dueAt)}</span></td>
                          </tr>)}
                        </tbody>
                      </table>
                    </div>}
                {/* A tabela mostra seis. Dizer o total impede que a aba pareça a
                    lista inteira — uma janela sem aviso vira "o sistema perdeu
                    minhas demandas". */}
                {statusList.cards.length > 6 && <p className="overview-status-vazio">
                  Mostrando 6 de {statusList.cards.length} em {statusList.name}.
                </p>}
              </div>}
            </>}
      </section>

      <ConnectionMap integrations={integrations} onNavigate={onNavigate} />
    </div>

    {/* Últimas movimentações (§19), em largura inteira.
        O botão entrou junto com a tela de histórico. Ele tinha ficado de fora
        de propósito enquanto não havia destino: link que leva ao lugar errado é
        pior que nenhum, e o teste que guardava isso cobrava as duas metades —
        que o botão não existisse sem a tela, e que entrasse quando ela entrasse.

        A lista de avatares virou tabela, como a maquete pede. O que ela ganha é
        a coluna "Relacionado a": antes o evento dizia "moveu a demanda de
        coluna" sem dizer QUAL demanda, e descobrir exigia abrir o histórico
        inteiro. Cinco colunas não cabem na coluna estreita da grade, então o
        bloco passa a ocupar a largura toda. */}
    <section className="overview-panel activity-panel"><header><div><h2>Histórico da operação</h2></div><button type="button" onClick={() => onFocus("history", "all")}>Ver histórico completo <ArrowRight aria-hidden="true" /></button></header><div className="recent-activity-list">
      {activities.length === 0 && <div className="overview-empty"><Clock3 aria-hidden="true" /><strong>O histórico aparecerá aqui.</strong><p>As movimentações de demandas e documentos serão registradas automaticamente.</p></div>}
      {activities.length > 0 && <div className="overview-table-scroll">
        <table className="overview-table overview-activity-table">
          <thead><tr>
            <th scope="col">Data e hora</th>
            <th scope="col">Evento</th>
            <th scope="col">Relacionado a</th>
            <th scope="col">Responsável</th>
            <th scope="col">Empresa</th>
          </tr></thead>
          <tbody>
            {activities.slice(0, 6).map((activity) => {
              const demanda = activity.cardId ? cardById.get(activity.cardId) : undefined;
              const detalhe = activityDetails(activity)[0];
              return <tr key={activity.id}>
                <td className="overview-quando">{formatMoment(activity.createdAt)}</td>
                <td>
                  <strong>{activityLabel(activity)}</strong>
                  {detalhe && <small>{detalhe}</small>}
                </td>
                {/* Sem a demanda carregada no recorte, a célula diz que não
                    sabe — o título de outra demanda seria pior que o traço. */}
                <td>{demanda
                  ? <button type="button" className="overview-table-link" onClick={() => onOpen(demanda)}>
                      <strong>{demanda.title}</strong>
                    </button>
                  : <span className="overview-ausente">—</span>}</td>
                <td>{activity.actorName || "Equipe DP"}</td>
                <td>{demanda?.company || <span className="overview-ausente">—</span>}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>}
    </div></section>
  </div>;
}
