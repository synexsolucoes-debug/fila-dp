# Parte 5 — Benchmark, lacunas, o que não fazer e ideias novas

Seções 18 a 20 do formato pedido, mais o item 28 ("o que não devemos fazer").

---

## 18. Benchmark

Formato: **o que fazem · problema que resolvem · o que aprender · como adaptar
ao Vinculato.**

### ServiceNow HR Service Delivery
- **Faz:** portal único de serviços, casos de RH, e *Lifecycle Events*
  (onboarding, offboarding, transferência) que agrupam atividades de vários
  departamentos num caso central
  ([ServiceNow Community](https://www.servicenow.com/community/hrsd-forum/understanding-lifecycle-events-in-servicenow-hr-service-delivery/m-p/3502745),
  [docs](https://www.servicenow.com/docs/r/employee-service-management/lifecycle-events/configure-hr-lifecycle-event-activity.html)).
  Após comprar a Moveworks (dez/2025), colocou um "front door" conversacional
  na frente disso tudo ([Leena AI vs Moveworks](https://leena.ai/leenaAI-vs-Moveworks)).
- **Resolve:** o trabalho entre departamentos em grandes empresas.
- **Aprender:** o **caso-pai com conjuntos de atividades** é o modelo certo para
  Jornadas; o "front door" único (portal + chat) é o modelo certo para a
  entrada.
- **Adaptar:** o mesmo conceito, com implantação em dias em vez de meses, preço
  de mercado médio brasileiro e regras de CLT/NR embutidas.

### Rippling
- **Faz:** o *employee graph* — pessoa como nó com atributos e relações
  (cargo, gestor, local, dispositivos, apps) — e o Workflow Automator com
  gatilhos em qualquer atributo, agindo em sistemas de terceiros sobre a mesma
  identidade ([Rippling Platform](https://www.rippling.com/blog/introducing-rippling-platform),
  [Workflow Automator](https://www.rippling.com/blog/go-beyond-basic-automation-with-workflow-automator)).
- **Resolve:** "mudou o departamento → as permissões mudam sozinhas".
- **Aprender:** automação como **propriedade do modelo de dados**. É a
  justificativa da Matriz de Requisitos.
- **Adaptar:** o Vinculato não é dono da identidade nem da folha; ele usa o
  mesmo raciocínio sobre **requisitos** (EPI, exame, treinamento, acesso) e
  **propõe** ações nos sistemas conectados.

### Pipefy
- **Faz:** processos em pipes, formulários públicos com lógica condicional,
  portal de solicitações, automações e agentes de IA; solução de RH com portal
  único ([Pipefy RH](https://www.pipefy.com/pt-br/press-release/nova-solucao-da-pipefy-para-rh-junta-ia-e-automacao-para-melhorar-experiencia-de-colaboradores/),
  [formulários públicos](https://community.pipefy.com/permissoes-e-usuarios-178/como-criar-um-formulario-publico-para-receber-dados-de-fora-da-plataforma-5200)).
- **Resolve:** tirar processos do e-mail sem TI.
- **Aprender:** **formulário público + portal + template** é o que faz o
  cliente ver valor na primeira semana.
- **Adaptar:** o Pipefy é genérico — não sabe o que é ASO, CA, experiência,
  CCT ou estabilidade. O Vinculato deve **ser o Pipefy que entende DP/SST**:
  templates com regra legal, prazos calculados, requisitos por cargo.

### Monday.com / ClickUp
- **Faz:** quadros flexíveis, automações "quando status mudar → notificar",
  templates de onboarding ([monday.com](https://monday.com/blog/service/employee-onboarding-automation/),
  [ClickUp](https://clickup.com/templates/employee-onboarding-t-48349788)).
- **Resolve:** coordenação de tarefas em qualquer time.
- **Aprender:** UX leve, templates prontos, adoção viral.
- **Adaptar:** a crítica que se faz a eles — sem ligação com o sistema de RH,
  folha e TI, "digitalizam sem automatizar" e deixam lacunas de conformidade
  ([Vetty](https://www.vetty.co/blog/the-complete-guide-to-employee-onboarding-in-2026)) —
  é exatamente o espaço do Vinculato. **Não competir em flexibilidade;
  competir em garantia.**

### Jira Service Management
- **Faz:** portal único para TI, RH, Facilities, Jurídico, Financeiro; tipos de
  solicitação; SLA; base de conhecimento que sugere artigos antes do chamado
  ([Atlassian HR](https://www.atlassian.com/software/jira/service-management/product-guide/tips-and-tricks/hr-service-management)).
- **Resolve:** atendimento interno com SLA.
- **Aprender:** **deflexão** — sugerir a resposta antes de abrir o chamado;
  catálogo de solicitações agrupado por linguagem do usuário.
- **Adaptar:** portal do gestor/colaborador com perguntas frequentes do
  cliente e respostas antes de abrir solicitação.

### Deel / BambooHR / Workday
- **Fazem:** onboarding/offboarding com checklists, provisionamento de TI por
  regra de cargo, devolução de equipamento sem ticket separado
  ([Deel](https://www.deel.com/resources/strategic-it-onboarding-offboarding-guide/),
  [BambooHR](https://www.bamboohr.com/platform/onboarding/),
  [comparativo](https://worldmetrics.org/best/automated-employee-onboarding-software/)).
- **Resolve:** a mesma jornada de ponta a ponta dentro de uma suíte.
- **Aprender:** o Workday liga onboarding a mudanças e offboarding como um
  ciclo de vida só, não como checklist isolado.
- **Adaptar:** o Vinculato faz isso **sem ser a suíte** — sobre os sistemas que
  o cliente já tem (Sólides, Sankhya, Tangerino…). Essa é a vantagem para o
  mercado brasileiro, onde a empresa raramente troca a folha.

### Factorial
- **Faz:** RH e DP para PMEs com portal do colaborador, documentos, assinatura
  digital, fluxos ([Factorial Brasil](https://factorialhr.com.br/funcionalidades-do-software-factorial),
  [assinatura](https://factorialhr.com.br/assinatura-digital)).
- **Aprender:** simplicidade e preço para PME.
- **Adaptar:** não competir no portal de RH tradicional; integrar-se a ele.

### SAP SuccessFactors (Joule) e Workday (Illuminate)
- **Fazem:** agentes de IA que atravessam módulos (serviço de RH, folha,
  performance, casos) e começam a iniciar e concluir transações
  ([Applexus](https://www.applexus.com/blogs/sap-successfactors-agentic-ai),
  [Darwinbox](https://darwinbox.com/blog/10-best-ai-agent-platforms-hr-teams)).
- **Aprender:** a direção do mercado é **agente dentro do fluxo**, com dados
  unificados.
- **Adaptar:** o Vinculato já tem a arquitetura de proposta → motor → execução.
  Isso é mais seguro do que o "agente autônomo" e é argumento de venda para
  DP, onde erro custa processo trabalhista.

### SOC e softwares de SST brasileiros
- **Fazem:** ASO, PCMSO, PGR, LTCAT, exames, treinamentos, EPI e eSocial SST,
  com alertas de vencimento e integração com folha
  ([SOC](https://www.soc.com.br/gestao-de-sst/),
  [Metra — comparativo](https://www.sistemametra.com.br/blog/melhores-softwares-de-sst/)).
- **Aprender:** o que a fiscalização exige de prova.
- **Adaptar:** **não competir** na emissão de documento técnico nem na
  transmissão do eSocial SST. Integrar e **orquestrar a ponte com DP, gestor e
  colaborador** — onde esses sistemas são fracos, porque são usados só pelo
  SESMT e pela clínica.

### Sólides/Tangerino, Convenia, Senior, Pontotel, Qulture.Rocks
- **Fazem:** admissão digital, ponto, DP, desempenho, com integrações entre si
  ([Ken Research](https://www.kenresearch.com/brazil-cloud-based-hrtech-and-payroll-market)).
  A Sólides comprou a Tangerino e recebeu US$ 100 mi da Warburg Pincus — o
  mercado brasileiro caminha para suítes.
- **Aprender:** quanto mais as suítes crescem, mais o cliente médio fica com
  **duas ou três suítes que não conversam** (ponto de uma, folha de outra, SST
  de uma terceira).
- **Adaptar:** o Vinculato é a **camada entre suítes**. Esse é o
  posicionamento defensável.

### Leena AI / Moveworks
- **Fazem:** assistente conversacional que responde e executa pedidos de RH e
  TI em Teams/Slack ([Leena AI](https://leena.ai/), [Moveworks](https://www.moveworks.com/)).
- **Aprender:** o canal é o chat onde a pessoa já está.
- **Adaptar:** IA de entrada no Teams/WhatsApp que cria proposta, não um
  chatbot de perguntas genéricas.

---

## 19. Lacunas do produto ("buracos")

Crítica direta, em ordem de gravidade.

1. **Não existe o objeto que conecta os departamentos (Jornada).** Os eventos
   estão modelados, mas nenhum deles abre trabalho em várias áreas. Enquanto
   isso não existir, a promessa "o trabalho circula sozinho" não é verdade.
2. **SESMT sem exames, treinamentos e restrições.** Área com maior risco de
   multa e processo; o produto só tem o painel de acidentes.
3. **Sem motor de prazos unificado.** Cada módulo tem seu aviso, e ninguém vê
   "tudo que vence esta semana".
4. **Sem canal de saída real.** Notificação interna não alcança gestor nem
   colaborador. O canal WhatsApp está declarado e não implementado.
5. **Sem porta para gestor e colaborador.** Todo trabalho entra pelo analista.
6. **Cargo pobre.** Cargo é catálogo (vindo do Sankhya), sem risco, sem
   requisitos, sem CBO rico — e é ele que deveria dirigir EPI, exames e
   treinamentos.
7. **Documento sem ciclo de vida.** Não há como responder "o que está faltando
   ou vencido para esta pessoa".
8. **Poucos templates.** Três templates de processo; o cliente começa em
   branco.
9. **Dependência de RPA** para as integrações centrais, o que torna a
   implantação cara e frágil.
10. **Onboarding do cliente.** Já apontado em 11/08 (etapas autodeclaradas);
    sem pacotes de segmento, a configuração inicial é longa.
11. **Interface grande demais para o que entrega**: 29 visões e um componente
    de 5.160 linhas. O risco de regressão já é visível no histórico de
    correções.
12. **Sem indicadores de decisão** para SESMT, EPI e gestão de jornadas.
13. **Dossiê/defesa trabalhista inexistente**, apesar de o produto guardar
    quase tudo o que um dossiê precisa.
14. **Sem modelo de "unidade" como cidadão de primeira classe.** O pedido fala
    em Workspace → Empresas → Unidades → Áreas; no schema há empresas,
    departamentos, áreas e locais de estoque, mas não um conceito explícito de
    **unidade/estabelecimento operacional** com endereço, riscos, CCT e
    feriados locais. Isso impacta SST (PGR por estabelecimento), EPI (estoque
    por unidade) e prazos (feriados locais).

---

## 28. O que NÃO devemos fazer

| Tentação | Por que prejudica | Onde colocar o limite |
| --- | --- | --- |
| **Folha de pagamento própria** | Custo regulatório infinito (tabelas, eSocial, CCT, retificações); concorre com o sistema que o cliente não vai trocar | Conferir e preparar input; **nunca** calcular verba nem transmitir eSocial. A regra já está no código (ponto não calcula dinheiro) — mantê-la |
| **ERP/financeiro completo** | Contas a pagar, conciliação, fiscal são outro produto | Acompanhar o **processo** até o pagamento; confirmação vem por integração |
| **Contabilidade** | Nenhuma relação com o núcleo | Exportar dados para o escritório contábil |
| **ATS completo** | Mercado saturado (Gupy, Sólides, Kenoby); não ajuda a operação | Requisição de vaga + integração; a jornada começa no "aprovado" |
| **Sistema de SST técnico** (emitir ASO, PGR, LTCAT; transmitir S-2220/S-2240) | Exige responsável técnico, laudos, integração com clínica; concorrentes estabelecidos | Controlar prazos, requisitos, evidências e a ponte com DP |
| **Ponto eletrônico** | Portaria 671, REP, homologação | Conferência (já existe) + agentes |
| **Desempenho, clima, PDI completos** | Produtos dedicados e baratos | No máximo, prazos de ciclo e evidência |
| **Assinatura eletrônica própria** | Validade jurídica, carimbo de tempo, suporte | Integrar provedores; fazer só "ciência simples" |
| **LMS (plataforma de cursos)** | Outro produto | Controlar a validade do treinamento obrigatório |
| **Editor de processos livre para todo cliente** | Gera processos quebrados e suporte caro | Templates parametrizáveis; BPMN para administradores avançados |
| **Módulo para cada departamento** (Compras, Facilities, Jurídico, TI) | Transforma o produto em ERP horizontal raso | **Templates** sobre o motor de processos + primitivas (itens em posse, prazos, documentos) |
| **Marketplace agora** | Sem massa crítica | Biblioteca interna primeiro (Parte 3 §10.3) |
| **Chatbot genérico de RH** | Não diferencia; caro | IA embutida no fluxo |
| **Mais módulos sob medida de um cliente** (novos "Psicologia" e "Caju") | Cada um é vertical e pouco reaproveitável | Antes de construir, perguntar: "isso é template, requisito, prazo ou item em posse?" Se for, não é módulo |
| **Controlar PJ como CLT** | Produz prova de vínculo (Tema 1389) | Jornada PJ própria, sem ponto/férias/avaliação de empregado; alerta quando alguém tentar |
| **Guardar dado clínico** | LGPD (dado sensível), risco | Datas, tipo, apto/inapto, restrição funcional — nunca CID ou laudo fora do cofre do SESMT |

**Sinal de alerta sobre amplitude:** a lista de áreas do pedido (DP, RH, SESMT,
EPI, gestores, colaboradores, Financeiro, Jurídico, TI, Compras, Facilities)
é o escopo de uma plataforma do tamanho do ServiceNow. Para um produto do
tamanho atual do Vinculato, o caminho viável é **profundidade em DP + SST +
EPI** (onde há regra legal e o produto já é forte) e **largura via motor de
processos e templates** para o resto. Construir módulos para as outras seis
áreas diluiria o produto antes de ele ganhar mercado no núcleo.

---

## 20. Ideias que o Vinculato ainda não possui

Ideias novas, que não repetem as funcionalidades já descritas nas partes
anteriores.

### 20.1 Vinte pequenas melhorias

1. **"Por que isso está comigo?"** — em todo item da Central, uma linha dizendo
   qual regra o atribuiu.
2. **Botão "Não é comigo"** que devolve à triagem com motivo, alimentando a
   calibração do roteamento.
3. **Contagem regressiva em dias úteis** nos prazos legais, não em dias
   corridos.
4. **Aviso de feriado local** ao escolher datas (férias, início, exame).
5. **Copiar link seguro** de qualquer registro já com prazo de expiração para
   quem não tem acesso.
6. **Modelos de resposta** do analista com variáveis ("Olá {{nome}}, falta
   {{documento}}").
7. **Máscara de CPF com revelação auditada** ("mostrar" registra quem viu).
8. **Status "aguardando terceiro externo"** (clínica, sindicato, fornecedor),
   que pausa o SLA interno com motivo.
9. **Atalho "duplicar solicitação"** para casos em lote.
10. **Aviso de aniversário de admissão/tempo de casa** para o gestor.
11. **Selo "fonte"** em cada campo da ficha (digitado, Sólides, Sankhya, OCR)
    — generalizar o que já existe na ficha de admissão.
12. **Visualização "linha do tempo" em toda demanda** (não só EPI).
13. **Horário de corte**: solicitações recebidas após X horas contam SLA a
    partir do próximo dia útil, com aviso ao solicitante.
14. **Anexar pelo e-mail**: endereço único por demanda
    (`demanda-1043@...`) que anexa o que chegar.
15. **Lembrete de "você mencionou fulano e ele não respondeu"** em 24 h.
16. **Indicador de completude** do cadastro da pessoa (%), clicável.
17. **Etiqueta automática de canal de origem** (WhatsApp, Teams, portal,
    e-mail, agente) em toda solicitação.
18. **Exportar filtro atual** da Central para CSV (com auditoria).
19. **Modo escuro** consistente e densidade compacta para analistas.
20. **Página de status das integrações** para o cliente (o que está degradado
    e desde quando), em vez de descobrir pela falha.

### 20.2 Vinte funcionalidades médias

1. **Calendário de datas-base e dissídios** por sindicato, com tarefa de
   aplicação do reajuste.
2. **Controle de estabilidades** (gestante, acidentária, CIPA, sindical,
   pré-aposentadoria da CCT) com bloqueio de desligamento.
3. **Escalas e cobertura de ausências** para o gestor (quem cobre as férias e
   afastamentos), sem virar sistema de ponto.
4. **Requisição de vaga com headcount orçado** por centro de custo.
5. **Cadastro de clínicas e laboratórios** com agenda, SLA e avaliação.
6. **Portal da clínica** para devolver ASO e resultado de exames.
7. **Controle de CIPA/designado** (mandato, eleição, treinamento).
8. **Controle de brigada de incêndio** (composição por unidade e turno,
   treinamento válido).
9. **Ordem de serviço de SST (NR-1)** por cargo, gerada do modelo e com
   ciência do colaborador.
10. **Controle de terceiros** (prestadores de serviço de empresas
    contratadas): documentos de SST exigidos para entrar na unidade (ASO,
    NR-35, ficha de EPI) — dor enorme de indústria e construção.
11. **Gestão de uniformes** como item em posse com grade de tamanhos.
12. **Veículos e multas** (indicação de condutor, ciência, análise de
    desconto).
13. **Reembolsos** com comprovante lido pela IA e política de alçada.
14. **Pesquisa de pulso de riscos psicossociais** mínima, só para gerar
    evidência e plano de ação NR-1 (com anonimato garantido), ou integração
    com ferramenta dedicada.
15. **Ciência em lote de política** com lembrete e relatório de pendentes.
16. **Planos de ação reutilizáveis** com 5W2H e evidência.
17. **Base de conhecimento do cliente** (perguntas frequentes do DP) usada pelo
    portal e pela IA.
18. **Agenda de treinamentos obrigatórios** (turmas, vagas, presença, validade).
19. **Controle de banco de horas** por pessoa com prazo de compensação (lê o
    saldo do ponto; não calcula).
20. **Aprovação por alçada configurável** (valor, cargo, empresa) reaproveitável
    por qualquer processo.

### 20.3 Dez funcionalidades grandes

1. **Motor de Jornadas** (P1) com os seis tipos principais.
2. **Matriz de Requisitos** (P2) cobrindo EPI, exames, treinamentos,
   documentos, acessos e itens em posse.
3. **Motor de Prazos** (P3) como fonte da Central de Trabalho.
4. **Portas externas** (P4): Portal do Gestor, Caixa do Colaborador, portal de
   parceiro, com notificação multicanal.
5. **SST operacional**: exames, treinamentos, restrições, acidentes com CAT e
   plano de ação, inspeções.
6. **Gestão documental com ciclo de vida** e assinatura integrada.
7. **Dossiê trabalhista** do colaborador e da empresa.
8. **SDK de conectores** + catálogo de conectores por API (ponto, ERP,
   identidade, benefícios), reduzindo a dependência de RPA.
9. **Command Center** multiempresa/multiunidade com comparação.
10. **Modo parceiro (multi-cliente)** para escritórios contábeis e
    consultorias de SST operarem vários workspaces com um painel consolidado —
    canal de distribuição mais provável no Brasil.

### 20.4 Dez ideias com IA

1. **Leitor de CCT** que gera parâmetros e prazos propostos, com página citada.
2. **IA de entrada multicanal** que pergunta de volta o que falta.
3. **Conferência de folha por variação** com explicação por fonte.
4. **Classificador de atestado** que extrai datas e descarta CID.
5. **Previsão de atraso de jornada** com explicação histórica.
6. **Mineração de processos** que sugere automações e remove etapas inúteis.
7. **Resumo de caso** para quem assume demanda longa.
8. **Sugestão de requisitos para cargo novo** a partir de CBO e riscos
   parecidos já cadastrados (o SESMT confirma).
9. **Detector de PJ com padrão de CLT** (sinais de subordinação no uso).
10. **Montador de dossiê** que organiza a linha do tempo por pedido da
    petição inicial (horas extras, insalubridade, verbas) — o jurídico
    recebe as provas agrupadas por tese.

### 20.5 Dez automações

1. Admissão → gerar entregas de EPI pendentes no local da unidade.
2. Mudança de cargo com novo risco → tarefa de exame + atualização de
   treinamento + devolução de EPI dispensável.
3. Atestado de 15 dias acumulados em 60 → tarefa de encaminhamento ao INSS.
4. Fim de afastamento em 5 dias → agendar ASO de retorno e avisar gestor.
5. Desligamento comunicado → bloqueio de acesso no mesmo minuto (via tarefa de
   TI ou agente de identidade) e lista de devolução para o colaborador.
6. CA vencido → bloquear SKU, listar portadores, propor substituto e compra.
7. Experiência vence em 15 dias → formulário do gestor; sem resposta em 5 dias
   → escalonar.
8. Acidente registrado → prazo da CAT, investigação e plano de ação criados.
9. Contrato PJ vence em 30 dias → tarefa de renovação com checklist jurídico.
10. Documento recebido e conferido → requisito da pessoa atualizado e
    pendência encerrada sozinha.

### 20.6 Dez integrações

1. **WhatsApp Business API** (oficial) para avisos, links e IA de entrada.
2. **Microsoft Graph** (Teams nativo, sem depender de Power Automate) e
   **Entra ID** (contas).
3. **Google Workspace** (contas e calendário).
4. **Clicksign / D4Sign / ZapSign** (assinatura).
5. **SOC** e sistemas de clínica (ASO, exames).
6. **CAEPI** (validade de CA).
7. **Gupy/Sólides admissão** (candidato aprovado → jornada).
8. **Folhas brasileiras** por arquivo/API: Domínio, Senior, TOTVS, Questor.
9. **Operadoras de benefício** (Caju já; Flash, VR, Alelo, Swile, operadoras de
   plano de saúde) por arquivo oficial.
10. **ITSM** (Jira SM, GLPI) para tarefas de TI das jornadas.

### 20.7 Dez indicadores novos

1. **% de "Dia 1 pronto"** por unidade e mês.
2. **Tempo até conformidade total** de um admitido (todos os requisitos
   verdes).
3. **Índice de exposição legal**: soma ponderada de prazos legais vencidos ou
   em risco.
4. **Taxa de solicitações fora do portal** (WhatsApp/e-mail) por gestor.
5. **Tempo de montagem de dossiê** (antes × depois).
6. **Acessos ativos de desligados** (meta: zero) e tempo médio de revogação.
7. **Custo de não conformidade evitado** (estimativa por multa de referência ×
   ocorrências evitadas) — número para o comprador justificar a renovação.
8. **Carga por área** em pontos de risco, não em quantidade de itens.
9. **Taxa de aceitação das propostas de IA/agentes** por tipo.
10. **Idade média dos itens parados** por aprovador.

### 20.8 Dez melhorias de UX

1. **Ficha 360 da pessoa** como centro de navegação.
2. **Palette de comandos** com ações, não só busca.
3. **Prévia de consequência** antes de confirmar toda ação com efeito em
   cadeia.
4. **Formulário conversacional** para gestor (uma pergunta por vez no celular).
5. **Semáforo único de conformidade** usado em todas as telas (mesmas cores,
   mesmo significado).
6. **Menu adaptado à área principal** do usuário.
7. **Empty states que ensinam** ("Nenhum requisito para Soldador. Usar pacote
   Construção Civil?").
8. **Undo de 10 segundos** para ações reversíveis.
9. **Tour contextual por perfil** no primeiro acesso, medido por evidência.
10. **Visão de jornada estilo metrô** (estações por área, com o trem parado
    onde está o bloqueio).

> Continua na [Parte 6 — Matriz, prioridades, templates, roadmap e visão](06-matriz-prioridades-templates-roadmap-visao.md).
