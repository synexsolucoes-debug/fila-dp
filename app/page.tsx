import { ArrowRight, ArrowUp, Check, Clock3, MoreHorizontal, Paperclip, Plus, Search, SlidersHorizontal } from "lucide-react";

const Chevron = () => <ArrowRight className="inline-icon" aria-hidden="true" />;
const ClockIcon = () => <Clock3 className="mini-icon" aria-hidden="true" />;
const CheckIcon = () => <Check className="mini-icon" aria-hidden="true" />;
const PaperclipIcon = () => <Paperclip className="mini-icon" aria-hidden="true" />;

const featureItems = [
  {
    number: "01",
    title: "Quadro visual de demandas",
    text: "Organize o trabalho em colunas personalizadas e enxergue o andamento da operação sem abrir planilhas paralelas.",
  },
  {
    number: "02",
    title: "Caixa de entrada multicanal",
    text: "Centralize pedidos recebidos por e-mail, Teams, WhatsApp ou registro manual e transforme cada solicitação em uma demanda rastreável.",
  },
  {
    number: "03",
    title: "SLA visível no cartão",
    text: "Identifique o que está no prazo, próximo do vencimento ou atrasado por meio de alertas objetivos.",
  },
  {
    number: "04",
    title: "Checklists por processo",
    text: "Padronize férias, rescisões, conciliações cadastrais e outras rotinas com etapas obrigatórias que ninguém precisa decorar.",
  },
  {
    number: "05",
    title: "Automações sem código",
    text: "Movimente cartões, aplique etiquetas e avise responsáveis automaticamente, sem depender da equipe técnica.",
  },
  {
    number: "06",
    title: "Visão para cada necessidade",
    text: "Alterne entre Quadro, Tabela, Calendário, Linha do Tempo e Dashboard conforme a decisão que precisa tomar.",
  },
];

const comparisons = [
  ["Visão do andamento", "Fragmentada", "Visual", "Visual e adaptada ao DP"],
  ["Gestão de SLA", "Manual", "Exige configuração", "Integrada ao fluxo"],
  ["Entrada multicanal", "Pedidos espalhados", "Depende de integrações", "Inbox preparada para triagem"],
  ["Processos de DP", "Montagem manual", "Precisam ser modelados", "Campos e fluxos do setor"],
  ["Rastreabilidade", "Histórico disperso", "Histórico por cartão", "Demanda, SLA e responsáveis"],
];

const faqs = [
  [
    "O Vinculato substitui meu sistema de folha?",
    "Não. O Vinculato organiza demandas, tarefas, prazos e processos operacionais. Ele complementa sistemas de folha, ERPs e outras ferramentas utilizadas pela empresa.",
  ],
  [
    "Como o Vinculato trabalha com admissões feitas na Sólides?",
    "A admissão digital continua integralmente na Sólides. O Vinculato prepara a integração dos dados concluídos, a vinculação com o ERP e a conciliação cadastral, quando houver um meio oficial disponível.",
  ],
  [
    "Como o sistema controla os prazos?",
    "Cada demanda pode receber um prazo ou uma política de SLA. O cartão sinaliza quando o vencimento se aproxima, está pausado ou foi ultrapassado.",
  ],
  [
    "Posso convidar gestores e auditores?",
    "Sim. Perfis de observador e convidado podem receber permissões específicas para consulta ou interação limitada.",
  ],
];

function ProductBoard() {
  return (
    <div className="board-shell" aria-label="Exemplo de quadro de demandas do Departamento Pessoal">
      <div className="board-topbar">
        <div>
          <span className="board-breadcrumb">Departamento Pessoal /</span>
          <strong> Fila geral</strong>
        </div>
        <div className="board-actions" aria-hidden="true">
          <span><Search /></span><span><SlidersHorizontal /></span><span><MoreHorizontal /></span>
        </div>
      </div>
      <div className="board-filters">
        <span className="filter-active">Quadro</span>
        <span>Tabela</span>
        <span>Calendário</span>
        <span className="board-spacer" />
        <span>Filtrar</span>
      </div>
      <div className="kanban" role="list">
        <div className="kanban-column" role="listitem">
          <div className="column-title"><span>Novas demandas</span><b>3</b></div>
          <article className="task-card">
            <div className="labels"><span className="label label-blue">CONCILIAÇÃO</span><span className="label label-red">URGENTE</span></div>
            <h3>Vincular colaborador ao ERP</h3>
            <p className="company">Synex Soluções • Ago/26</p>
            <div className="task-meta"><span className="sla sla-warning"><ClockIcon /> vence hoje</span><span className="avatar avatar-a">AM</span></div>
          </article>
          <article className="task-card">
            <div className="labels"><span className="label label-purple">FÉRIAS</span></div>
            <h3>Aviso de férias — João Lima</h3>
            <p className="company">Unidade São Paulo</p>
            <div className="task-meta"><span><CheckIcon /> 2/5</span><span className="avatar avatar-b">RC</span></div>
          </article>
          <button className="add-card"><Plus /> Adicionar demanda</button>
        </div>

        <div className="kanban-column" role="listitem">
          <div className="column-title"><span>Em análise</span><b>2</b></div>
          <article className="task-card task-highlight">
            <div className="labels"><span className="label label-green">BENEFÍCIOS</span></div>
            <h3>Inclusão no plano de saúde</h3>
            <p className="company">Matrícula 0482</p>
            <div className="progress"><span style={{ width: "68%" }} /></div>
            <div className="task-meta"><span><CheckIcon /> 4/6</span><span><PaperclipIcon /> 2</span><span className="avatar avatar-c">LS</span></div>
          </article>
          <article className="task-card">
            <div className="labels"><span className="label label-orange">RESCISÃO</span></div>
            <h3>Conferência de cálculo rescisório</h3>
            <div className="task-meta"><span className="sla sla-safe"><ClockIcon /> 2 dias</span><span className="avatar avatar-a">AM</span></div>
          </article>
        </div>

        <div className="kanban-column" role="listitem">
          <div className="column-title"><span>Em execução</span><b>2</b></div>
          <article className="task-card">
            <div className="labels"><span className="label label-blue">CONCILIAÇÃO</span></div>
            <h3>Conferir vínculo Sólides × ERP</h3>
            <p className="company">Dados concluídos na origem</p>
            <div className="task-meta"><span className="sla sla-safe"><ClockIcon /> 1 dia</span><span className="avatar avatar-b">RC</span></div>
          </article>
          <article className="task-card">
            <div className="labels"><span className="label label-gray">CADASTRO</span></div>
            <h3>Atualização de dados bancários</h3>
            <div className="task-meta"><span><PaperclipIcon /> 1</span><span className="avatar avatar-c">LS</span></div>
          </article>
        </div>
      </div>
      <div className="board-status"><span><i className="status-dot" /> 7 demandas ativas</span><span>Atualizado agora</span></div>
    </div>
  );
}

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#inicio" aria-label="Vinculato — início">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Vinculato</span>
        </a>
        <nav aria-label="Navegação principal">
          <a href="/solucao">Solução</a>
          <a href="/funcionalidades">Funcionalidades</a>
          <a href="/integracoes">Integrações</a>
          <a href="/planos">Planos</a>
          <a href="/faq">FAQ</a>
        </nav>
        <div className="header-actions">
          <a className="login-link" href="/login">Entrar</a>
          <a className="button button-small" href="/contato?assunto=demonstracao">Falar com a equipe</a>
        </div>
      </header>

      <section className="hero" id="inicio">
        <div className="hero-glow" aria-hidden="true" />
        <div className="hero-copy">
          <div className="eyebrow"><i className="eyebrow-dot" /> Gestão visual criada para DP e RH</div>
          <h1>Toda demanda do DP na fila certa.</h1>
          <p className="hero-lead">Com responsável, prazo e próximo passo.</p>
          <p className="hero-description">
            Centralize solicitações, acompanhe SLAs e organize férias, rescisões, conciliações e outras rotinas em um quadro visual simples de usar.
          </p>
          <div className="hero-actions">
            <a className="button" href="/contato?assunto=demonstracao">Agendar demonstração <Chevron /></a>
            <a className="button button-secondary" href="/solucao">Conhecer a solução</a>
          </div>
          <div className="hero-notes">
            <span><CheckIcon /> A admissão digital permanece na Sólides</span>
            <span><CheckIcon /> A folha oficial permanece no seu ERP</span>
          </div>
        </div>
        <div className="hero-product"><ProductBoard /></div>
      </section>

      <section className="proof-bar" aria-label="Benefícios principais">
        <p>Menos cobrança por status.</p>
        <p>Menos prazo escondido.</p>
        <p>Mais previsibilidade.</p>
      </section>

      <section className="section problem-section" id="produto">
        <div className="section-kicker">O problema que ninguém deveria normalizar</div>
        <div className="split-heading">
          <h2>Seu DP não precisa trabalhar no escuro.</h2>
          <p>Quando os pedidos chegam por todos os lados, a equipe perde tempo procurando contexto — e a gestão perde visibilidade sobre a operação.</p>
        </div>
        <div className="pain-grid">
          <article><span className="pain-icon">01</span><h3>Demandas espalhadas</h3><p>E-mail, WhatsApp, Teams, planilhas e conversas formam uma fila invisível.</p></article>
          <article><span className="pain-icon">02</span><h3>Prazos difíceis de acompanhar</h3><p>Sem alertas claros, uma pendência simples pode virar urgência.</p></article>
          <article><span className="pain-icon">03</span><h3>Processos sem padrão</h3><p>Etapas importantes dependem da memória e da experiência de cada analista.</p></article>
          <article className="solution-card"><span className="solution-label">A resposta</span><h3>Uma fila clara, rastreável e fácil de priorizar.</h3><p>O Vinculato reúne cada solicitação com contexto, responsável e SLA.</p><a href="#como-funciona">Conheça o fluxo <Chevron /></a></article>
        </div>
      </section>

      <section className="section workflow-section" id="como-funciona">
        <div className="workflow-intro">
          <div className="section-kicker light">Como funciona</div>
          <h2>Do pedido recebido à demanda concluída.</h2>
          <p>Um fluxo simples o bastante para o dia a dia e estruturado o bastante para a gestão.</p>
        </div>
        <ol className="workflow-list">
          <li><span>01</span><div><h3>Centralize</h3><p>As solicitações chegam à Inbox do Vinculato.</p></div></li>
          <li><span>02</span><div><h3>Faça a triagem</h3><p>Defina processo, responsável, prioridade e prazo.</p></div></li>
          <li><span>03</span><div><h3>Execute com clareza</h3><p>Movimente o cartão, conclua etapas e anexe documentos.</p></div></li>
          <li><span>04</span><div><h3>Acompanhe e melhore</h3><p>Enxergue atrasos, volume e gargalos da operação.</p></div></li>
        </ol>
      </section>

      <section className="section features-section" id="recursos">
        <div className="section-kicker">Recursos essenciais</div>
        <div className="split-heading">
          <h2>Tudo o que o DP precisa. Sem complicar a rotina.</h2>
          <p>Alta densidade de informação, controles específicos e uma interface que a equipe entende rapidamente.</p>
        </div>
        <div className="feature-grid">
          {featureItems.map((item) => (
            <article key={item.number}>
              <span>{item.number}</span>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section comparison-section">
        <div className="section-kicker">Feito para o trabalho real do DP</div>
        <div className="split-heading">
          <h2>Visual como um Kanban. Especializado como sua operação exige.</h2>
          <p>O Vinculato reduz a configuração necessária para transformar um quadro genérico em um processo seguro para o setor.</p>
        </div>
        <div className="comparison-wrap">
          <table>
            <thead><tr><th>Necessidade</th><th>Planilhas e mensagens</th><th>Kanban genérico</th><th className="highlight-col">Vinculato</th></tr></thead>
            <tbody>
              {comparisons.map((row) => <tr key={row[0]}>{row.map((cell, index) => <td className={index === 3 ? "highlight-col" : ""} key={cell}>{index === 3 && <CheckIcon />}{cell}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section plans-section" id="planos">
        <div className="center-heading">
          <div className="section-kicker">Cresce com a sua operação</div>
          <h2>Condições combinadas com a sua realidade.</h2>
          <p>As condições comerciais publicadas ficam na página de planos, junto com o que está incluído em qualquer contrato.</p>
        </div>
        <div className="plans-grid">
          <article><span className="plan-name">Planos</span><h3>Ver condições publicadas</h3><p>Limites de usuários, empresas, integrações e armazenamento de cada plano ativo no catálogo.</p><a href="/planos">Ver planos <Chevron /></a></article>
          <article><span className="plan-name">Demonstração</span><h3>Ver o produto na sua operação</h3><p>Uma conversa sobre os seus processos, com o produto aberto e sem usar dados reais do seu DP.</p><a href="/demonstracao">Agendar <Chevron /></a></article>
          <article><span className="plan-name">Integrações</span><h3>Conferir o que já existe</h3><p>O estado real de cada integração: disponível, parcial ou apenas preparada.</p><a href="/integracoes">Ver integrações <Chevron /></a></article>
          <article><span className="plan-name">Contato</span><h3>Falar com a equipe</h3><p>Dúvidas sobre escopo, segurança, LGPD ou implantação antes de contratar.</p><a href="/contato">Enviar contato <Chevron /></a></article>
        </div>
        <p className="plans-note">Nenhuma condição comercial é anunciada aqui antes de estar publicada e cobrável no produto.</p>
      </section>

      <section className="section faq-section">
        <div>
          <div className="section-kicker">Perguntas frequentes</div>
          <h2>Antes de colocar sua fila em ordem.</h2>
        </div>
        <div className="faq-list">
          {faqs.map(([question, answer], index) => (
            <details key={question} open={index === 0}>
              <summary>{question}<Plus className="faq-toggle-icon" aria-hidden="true" /></summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="final-cta" id="contato">
        <div>
          <span className="cta-kicker">Sua operação pode ser mais previsível.</span>
          <h2>Seu DP já tem demandas demais. Organizar a fila não precisa ser mais uma delas.</h2>
        </div>
        <div className="final-cta-actions">
          <a className="button button-light" href="/contato?assunto=demonstracao">Agendar demonstração <Chevron /></a>
          <a className="demo-link" href="/login">Acessar minha conta</a>
          <p>Combinamos a condição comercial depois de entender a sua operação.</p>
        </div>
      </section>

      <footer>
        <a className="brand footer-brand" href="#inicio" aria-label="Vinculato — voltar ao início">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Vinculato</span>
        </a>
        <p>Gestão visual de demandas para Departamento Pessoal e RH.</p>
        <div>
          <a href="/solucao">Solução</a><a href="/funcionalidades">Funcionalidades</a><a href="/integracoes">Integrações</a>
          <a href="/planos">Planos</a><a href="/faq">FAQ</a><a href="/contato">Contato</a>
          <a href="/termos">Termos</a><a href="/privacidade">Privacidade</a><a href="/subprocessadores">Subprocessadores</a>
          <a href="#inicio">Voltar ao topo <ArrowUp className="inline-icon" aria-hidden="true" /></a>
        </div>
        <p className="site-boundary-note">
          O Vinculato não executa admissão digital, não guarda prontuário psicológico e não faz cálculo tributário nem emite nota fiscal.
        </p>
      </footer>
    </main>
  );
}
