# Parte 3 — Central de Trabalho, Motor de Processos, Agentes e IA

Seções 8 a 11 do formato pedido. Inclui também a **Busca Global** e o
**Command Center** (itens 21 e 22 do pedido), porque são três faces da mesma
camada de leitura.

---

## 8. Central de Trabalho

### 8.1 Onde ela está hoje

`/painel/trabalho` já une 7 fontes (demanda, aprovação, movimentação, entrega
auxiliar, pendência operacional, triagem, falha de integração), com escopo,
filtros, ordenação e cursor decididos no servidor. É uma base excelente. O que
falta é ela deixar de ser **uma lista** e passar a ser **o lugar onde se
trabalha**.

### 8.2 As nove perguntas, e a fonte de cada resposta

| Pergunta | Filtro/visão | Fonte de dados | Existe? |
| --- | --- | --- | --- |
| O que preciso fazer? | **Minha fila** (padrão) | `WorkItem` com `assignee = eu` | Sim |
| O que está atrasado? | `due < agora` | prazo do item | Sim |
| O que está bloqueado? | **Bloqueados** | dependência não resolvida, checklist, evidência, aprovação | Parcial — o motivo do bloqueio existe na transição de etapa, mas não é um filtro |
| O que depende de outra pessoa? | **Aguardando terceiros** | item que eu criei/coordeno cujo responsável é outro; tarefa filha de jornada | Não |
| O que precisa de aprovação? | **Aprovar** | `approval` | Sim |
| O que chegou hoje? | **Novos** | `created_at >= hoje` + não visto | Parcial (falta "não visto") |
| O que vence hoje? | **Vence hoje** | prazo = hoje | Sim |
| O que pode gerar problema? | **Em risco** | score de risco (abaixo) | Não |
| O que está parado? | **Parados** | sem atividade há N dias úteis | Não |

### 8.3 Funcionalidades propostas

- **Seções fixas no topo** (contadores clicáveis): Atrasado · Vence hoje ·
  Aprovar · Bloqueado · Em risco · Parado · Aguardando terceiros.
- **Score de risco** por item, determinístico e explicável:
  `risco = f(consequência legal do tipo, dias até o prazo, dependências abertas, tempo parado, histórico de reabertura)`.
  O item mostra *por que* está em risco ("prazo legal em 2 dias úteis; exame
  ainda não agendado").
- **Ações rápidas na própria linha** (sem abrir a tela do módulo) para as ações
  de baixo risco: assumir, delegar, adiar com motivo, comentar, marcar
  checklist, aprovar/recusar quando a aprovação não exige conferência de
  documento. As ações de alto risco continuam levando à tela do módulo —
  coerente com a regra "a Central não tem porta de escrita própria": a ação
  rápida chama **a mesma rota do módulo**.
- **Delegação temporária** (férias do analista): "tudo que chegar para mim de
  10 a 24/10 vai para Ana", com trilha.
- **Reatribuição em lote** e **balanceamento** por carga (coordenador vê
  quantos itens e quantos pontos de risco cada analista tem).
- **Escalonamento automático**: item crítico parado há X horas sobe para o
  coordenador; depois para o gestor da área (regra configurável por tipo).
- **Filtros salvos e compartilháveis** ("Admissões da unidade Norte desta
  semana"), com URL (o endereço profundo já existe).
- **Modo foco**: um item por vez, com o próximo carregado; atalhos `J/K`,
  `E` concluir, `A` assumir, `D` delegar.
- **Visão por jornada**: o coordenador vê o caso-pai com as filhas por área,
  cada uma com semáforo.
- **Resumo diário** por e-mail/Teams às 8h: "Você tem 3 itens vencendo hoje,
  2 aprovações e 1 admissão de segunda sem exame".
- **"Não visto"**: marca de leitura por pessoa, para "chegou hoje" significar
  "chegou e eu ainda não olhei".

### 8.4 Crítica

A tentação é colocar tudo dentro da Central (edição completa, formulários,
aprovação com documento). **Não faça isso.** A Central é **roteador + ações
triviais**. Quando ela vira tela de edição de tudo, reaparece o componente de
5 mil linhas — agora dentro da Central.

### 8.5 Busca Global (item 21)

A busca `Ctrl+K` já cobre demandas, empresas, colaboradores, psicólogos, PJ,
competências e integrações, com CPF por HMAC. Evolução:

1. **Ficha 360 da pessoa como resultado principal.** Buscar "João Silva" abre
   um painel com abas: Resumo (cargo, unidade, gestor, situação, admissão),
   **Requisitos** (EPI, exames, treinamentos, documentos — semáforo),
   **Jornadas** em andamento e concluídas, Solicitações, Movimentações,
   Afastamentos/férias, Itens em posse, Documentos, **Linha do tempo**
   (auditoria filtrada pela pessoa).
2. **Comandos, não só registros**: "admitir", "desligar João", "entregar EPI
   para João", "abrir férias" → abre o formulário já preenchido.
3. **Busca por intenção** (IA): "quem está com ASO vencido na unidade Sul?" →
   roda a consulta nomeada correspondente (mesmo catálogo fechado do
   assistente).
4. **Recentes e fixados** no topo do palette.
5. **Escopo e privacidade**: o resultado obedece capability e escopo de
   empresa, e campos sensíveis continuam mascarados.

### 8.6 Command Center (item 22)

Destinado a coordenador de DP, gerente de RH, líder de SESMT e diretoria. Ele
**não é** a Central de Trabalho: responde "a operação está saudável?", não "o
que eu faço agora?". A base já existe em `lib/action-center.ts` e
`lib/operational-health.ts`.

**Layout proposto:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│ SAÚDE OPERACIONAL — Grupo X · hoje 23/09 · [Empresa ▾] [Unidade ▾]         │
│ Veredito: ATENÇÃO  (3 críticos, 1 prazo legal em 24 h)                    │
├──────────────┬──────────────┬──────────────┬──────────────┬───────────────┤
│ 38 processos │ 7 atrasados  │ 3 críticos   │ 12 aguardando│ 5 integrações │
│ em andamento │ ▲2 vs semana │ ● ver        │ aprovação    │ com falha     │
├──────────────┴──────────────┴──────────────┴──────────────┴───────────────┤
│ PRAZOS LEGAIS (próximos 7 dias)        │ JORNADAS                          │
│ • Rescisão Maria — vence em 2 dias     │ Admissões de segunda: 12          │
│ • CAT acidente 22/09 — vence hoje      │   4 sem exame · 2 sem acesso TI   │
│ • S-2240: 3 mudanças de função sem     │ Desligamentos abertos: 5          │
│   atualização                          │   2 com EPI não devolvido         │
├────────────────────────────────────────┼───────────────────────────────────┤
│ CONFORMIDADE (pessoas ativas)          │ GARGALOS                          │
│ ASO em dia  94% · 2 vencidos           │ Maior fila: TI (14 itens, 5 >SLA) │
│ Treinamentos NR 88% · 9 vencendo       │ Maior tempo parado: Aprovação de  │
│ EPI conforme 91% · CA vencendo: 2 SKUs │   promoção (média 6 dias)         │
│ Documentos obrigatórios 97%            │ Aprovador com mais pendências: ...│
├────────────────────────────────────────┴───────────────────────────────────┤
│ INTEGRAÇÕES & AGENTES: Sankhya ✓ · Tangerino ⚠ degradado desde 08:17 ·     │
│ Sólides ✓ · Teams ✓ · 3 itens em dead-letter                               │
└───────────────────────────────────────────────────────────────────────────┘
```

Regras de desenho:

- **Cada número é um link** para a lista filtrada (padrão que já existe na
  central de ação).
- **Veredito no topo** calculado com a mesma lógica de `worstSeverity` já
  usada na saúde operacional.
- **Tendência** (▲▼ contra a semana anterior) em vez de gráfico decorativo.
- **Indicadores zerados não aparecem** (regra atual, manter).
- **Por empresa/unidade**: o mesmo painel recortado, e uma visão
  "comparar unidades" (ranking de conformidade e atraso).
- **Snapshot semanal por e-mail** para diretoria.

---

## 9. Motor de Processos

### 9.1 O que já existe

Definição → versão imutável com BPMN → etapas com checklist, evidência,
responsável, aprovação → instância (= demanda) presa à versão → transição
validada em 9 passos → automações por etapa (`lib/process-automations.ts`)
→ regras de quadro (`lib/automation-rules.ts`) com 7 gatilhos.

### 9.2 O que falta para ele sustentar jornadas

| Capacidade | Hoje | Proposta |
| --- | --- | --- |
| **Gatilho por evento de domínio** | Regras escutam só evento de cartão/processo | Regras escutam **qualquer evento do catálogo** (`employee.admitted`, `termination.requested`, `time.inconsistency_detected`, `integration.failed`…) — a infraestrutura de outbox já existe |
| **Gatilho por prazo** | `sla.tick` genérico | `deadline.entered_window` (prazo entrou na janela de ação) com o tipo do prazo |
| **Condições** | `lib/process-conditions.ts` | Condições sobre atributos da pessoa (empresa, unidade, cargo, risco, tipo de contrato), do evento e do caso-pai |
| **Subprocesso** | Etapa pode criar demanda (`createDemand`) | **Subprocesso com vínculo pai-filho** e condição de retorno (o pai espera as filhas) |
| **Paralelismo** | Gateway de decisão | Gateway paralelo (fork/join): TI, SESMT e Benefícios ao mesmo tempo, junção no veredito |
| **Tarefas de serviço** | `serviceTask` no desenho | Ações de sistema: chamar agente (cadastrar no ponto), enviar webhook, gerar documento, enviar link assinado, criar prazo |
| **Formulários** | Campos personalizados | **Formulário por etapa**, com campos condicionais e validação, usado tanto pelo analista quanto pelo link externo |
| **Timer** | SLA | Evento de tempo no BPMN ("esperar até D−2", "se não responder em 48 h") |
| **Escalonamento** | Não | Por etapa: após X horas → notificar/reatribuir |
| **Simulação** | Não | "Rodar a v5 contra 20 casos reais da v4" antes de publicar — sugerido na auditoria de 11/08, ainda não feito |
| **Métricas por etapa** | Contadores de adoção | Tempo médio por etapa, taxa de retorno (retrabalho), gargalo |

### 9.3 Exemplo declarativo

```yaml
jornada: admissao-clt
versao: 3
gatilho: employee.admitted            # ou admission.approved
data_alvo: payload.startDate
condicoes:
  - contrato in [clt, aprendiz, estagio]
tarefas:
  - id: exame
    area: sesmt
    tipo: requisito                    # gerado pela Matriz de Requisitos
    filtro: { categoria: exame_ocupacional, momento: admissional }
    prazo: D-2
    critico: true
  - id: acessos
    area: ti
    acao: agente.entra_id.criar_usuario   # proposta, não execução direta
    prazo: D-3
  - id: epi
    area: almoxarifado
    tipo: requisito
    filtro: { categoria: epi }
    depende_de: [exame]                # só entrega a quem está apto
    prazo: D-1
  - id: ponto
    area: dp
    acao: agente.tangerino.cadastrar
    depende_de: [cadastro_erp]
veredito:
  nome: "Dia 1 pronto"
  exige: [exame, acessos, epi, contrato_assinado]
escalonamento:
  - se: veredito_pendente_em D-2
    notificar: [coordenador_dp, gestor, lider_sesmt]
    severidade: critico
```

### 9.4 Crítica

- **Não abra o editor BPMN completo para o cliente final.** O BPMN é ótimo
  como representação interna e para o administrador avançado. Para 90% dos
  clientes, a configuração deve ser por **template + parâmetros** ("quem faz o
  exame? com quantos dias de antecedência?"). Editor de fluxo livre gera
  processos quebrados e chamados de suporte.
- **Não crie um segundo motor para jornadas.** Jornada = processo com
  subprocessos paralelos e gatilho por evento. Se virar objeto separado, o
  produto passa a ter dois motores — exatamente o erro que a arquitetura
  operacional (§3 e §11) já apontou uma vez.

---

## 10. Agentes e integrações

### 10.1 Diferenciar os mecanismos

| Mecanismo | Quando usar | Exemplo no Vinculato | Custo/risco |
| --- | --- | --- | --- |
| **API** (pull/push oficial) | Sempre que o sistema oferecer | Sólides (admissões concluídas), Sankhya (consulta), Stripe | Menor custo de manutenção; depende do escopo da API |
| **Webhook de entrada** | O sistema de origem avisa quando algo acontece | Teams via Power Automate | Barato; exige assinatura e deduplicação (já existem) |
| **Webhook de saída** | Avisar sistemas do cliente | `fdp_webhook_endpoints` | Barato; o cliente integra no ITSM/ERP dele |
| **Importação/exportação** | Sistemas legados, lote mensal, arquivo oficial | Caju CSV, planilhas Sankhya, exportação de ponto | Barato e robusto; manual |
| **Worker** (processo em fila) | Tarefas longas e agendadas | Varredura de integrações, entregas de webhook | Infra já existe (lease, backoff, dead-letter) |
| **RPA / automação de navegador** | Sistema sem API, com tela estável | Tangerino (Playwright), Sankhya browser | **Caro**: quebra quando a tela muda; exige worker no cliente (Windows) e credencial de usuário. Usar só quando não há alternativa, e sempre **somente leitura** ou com escrita confirmada |
| **Agente inteligente** | Interpretar dado não estruturado ou decidir entre caminhos com incerteza | Proposta de agente → motor → triagem | Precisa de catálogo de ações, confiança calibrada e triagem (já existem) |

**Crítica ao estado atual:** uma parte grande do esforço recente foi em RPA
(Tangerino, Sólides por navegador, Sankhya browser). É justificável para o
primeiro cliente, mas **não escala como produto**: cada cliente tem outro
sistema de ponto, outro ERP, outra versão de tela. A regra de produto deveria
ser: **RPA é serviço de implantação, não funcionalidade do plano**. O produto
vende API, webhook, importação e um SDK de conectores; RPA entra como
"conector assistido" com contrato próprio.

### 10.2 Agentes propostos

| Agente | Lê | Propõe/escreve | Mecanismo preferido |
| --- | --- | --- | --- |
| **Ponto** (Tangerino, Pontotel, Secullum, Ahgora…) | Colaboradores, marcações, inconsistências | Cadastrar/atualizar colaborador, escala | API > RPA |
| **ERP/Folha** (Sankhya, Senior, TOTVS, Domínio, Questor) | Cadastro, cargos, CCT, verbas | Cadastro de admitido; movimentações aprovadas (em arquivo ou API) | Importação/API |
| **Admissão digital** (Sólides, Gupy, Kenoby) | Candidatos aprovados, documentos | Abrir jornada de admissão | API/webhook |
| **Identidade** (Entra ID, Google Workspace) | Contas ativas, grupos | Criar/bloquear conta **mediante aprovação da tarefa** | API |
| **Clínica/SST** (SOC, sistemas de clínica) | ASOs emitidos, agendamentos | Atualizar exame e restrição | API/importação/portal da clínica |
| **CAEPI** (base pública de CAs) | Validade dos CAs | Atualizar validade; alertar | Download periódico |
| **Assinatura** (Clicksign, D4Sign, ZapSign, Docusign) | Status da assinatura | Enviar documento para assinar | API + webhook |
| **Comunicação** (e-mail, Teams, WhatsApp) | Mensagens recebidas | Enviar avisos, links, resumos | API oficial |
| **Benefícios** (Caju, Flash, VR, Alelo, operadora de saúde) | Faturas, beneficiários | Arquivo de inclusão/exclusão | Arquivo oficial/API |
| **ITSM** (Jira SM, GLPI, ServiceNow) | Status do chamado | Abrir chamado de TI da jornada | Webhook de saída + API |
| **eSocial (leitura)** | Retorno de eventos via sistema de folha | Conferir se S-2220/S-2240/S-2210 foram transmitidos dentro do prazo | Via ERP/SST — **o Vinculato não transmite** |

### 10.3 Marketplace (item 25)

**Opinião: ainda não.** Um marketplace exige volume de clientes e parceiros
que publiquem. Antes disso, é custo de curadoria sem receita. A sequência
certa:

1. **Agora:** biblioteca **interna** de templates de processo, modelos de
   documento e conectores mantidos pelo Vinculato (catálogo versionado,
   como já é feito com processos publicados).
2. **Em 12–18 meses:** **parceiros de implantação** (escritórios contábeis,
   consultorias de SST) publicam templates para os próprios clientes —
   é o canal de distribuição mais provável no Brasil.
3. **Depois de ~100 workspaces pagantes:** marketplace aberto com conectores
   de terceiros sobre a API pública e os webhooks, com revisão de segurança.

O que o marketplace deve conter quando existir: templates de processo/jornada,
modelos de documento com variáveis, pacotes de requisitos por segmento
(construção civil, frigorífico, hospital, logística), conectores e pacotes de
indicadores.

---

## 11. IA do Vinculato

Princípio que o produto já pratica e deve manter: **a IA propõe; o motor
determinístico decide; a pessoa confirma o que for sensível; tudo fica na
auditoria.** Cada funcionalidade abaixo diz em que ponto do fluxo ela entra e
qual é a saída — que é sempre uma proposta, uma sugestão ou um relatório,
nunca uma escrita direta no domínio.

### 11.1 IA de entrada (triagem de linguagem natural)

- **Entrada:** "João vai sair de férias dia 15" no Teams, WhatsApp, e-mail ou
  na caixa de texto do Vinculato.
- **Processamento:** extração de entidades (pessoa, empresa, datas, tipo de
  processo) → resolução contra o cadastro (nomes parecidos, homônimos) →
  checagem de regra (férias: período aquisitivo, antecedência de 30 dias) →
  proposta.
- **Saída:** proposta com confiança; acima do limiar e não sensível →
  rascunho de solicitação para o solicitante confirmar; abaixo → triagem com
  o motivo ("há dois João na empresa X").
- **Diferencial:** ela **responde de volta** no mesmo canal pedindo o que
  falta ("Qual João? João Silva (Logística) ou João Souza (Loja 3)?").

### 11.2 IA documental

- Classificar tipo (RG, CPF, CNH, CTPS, comprovante de residência, certidão,
  atestado, ASO, nota fiscal, certificado de treinamento).
- Extrair campos e **comparar com o cadastro** (nome divergente, CPF que não
  confere, validade vencida).
- Detectar ausências ("falta verso do RG", "comprovante com mais de 90 dias").
- **Já existe a base**: OCR de fotos como "sugestão, nunca origem" e a ficha
  com origem de cada campo. A evolução é generalizar para todo anexo que
  chega, e ligar ao **Requisito de documento** (a pendência se resolve sozinha
  quando o documento certo chega e é confirmado).
- **Atestado:** extrair **datas e nome do médico/CRM**, e **descartar CID** —
  coerente com a regra de Psicologia.

### 11.3 IA operacional (briefing)

- **Briefing diário** por papel: "Existem 12 admissões para segunda e 4 ainda
  não têm exame admissional. A clínica X tem 2 atrasos esta semana."
- Construído **sobre consultas nomeadas** (o catálogo fechado atual), com o
  texto gerado a partir de agregados — nada de SQL gerado pelo modelo.

### 11.4 IA de risco (preditiva, mas explicável)

- Prever **atraso de jornada** a partir do histórico (etapas que costumam
  travar, clínica lenta, aprovador lento).
- Detectar **dependência bloqueada** que ninguém está olhando.
- Sempre com **explicação** ("em 8 das últimas 10 admissões da unidade Sul o
  exame ficou pronto depois de D−2"). Nada de score opaco.

### 11.5 IA de auditoria e conferência

- **Conferência de folha por variação**: comparar a competência atual com a
  anterior e com os eventos do mês (movimentações aprovadas, afastamentos,
  férias, ponto conferido, benefícios) e apontar o que **não tem explicação**
  ("salário do José mudou 12% e não há movimentação aprovada").
- **Benefícios × ativos**: desligado ainda na fatura do plano de saúde.
- **Ponto × afastamento**: marcação em dia de atestado (já é inconsistência
  bloqueante na conferência de ponto — a IA só prioriza).
- **EPI × cargo**: pessoa em cargo de risco sem entrega do EPI exigido.
- A IA **não calcula folha**; ela aponta divergências entre fontes.

### 11.6 IA de processos (mineração)

- Observar sequências repetidas ("toda vez que uma admissão da unidade X é
  aberta, alguém cria à mão uma demanda para Facilities") e **sugerir a
  automação** pronta para aprovação.
- Detectar etapas que só fazem o trabalho andar (sempre aprovadas em
  segundos) e sugerir remover.
- Detectar retrabalho (etapa que volta muito) e mostrar a causa mais comum.

### 11.7 Outras aplicações que valem a pena

| Aplicação | Descrição | Salvaguarda |
| --- | --- | --- |
| **Leitor de CCT** | Lê o PDF da convenção coletiva e propõe parâmetros: data-base, piso por função, reajuste, adicionais, regras de escala, contribuições, estabilidades, prazos | Tudo entra como proposta para o DP validar cláusula por cláusula, com a página citada |
| **Redator de comunicações** | Rascunha aviso de férias, carta de promoção, convocação para exame, notificação de devolução de EPI | Modelo com variáveis; a pessoa envia |
| **Assistente de formulário** | Enquanto o gestor preenche, aponta o que falta e explica o porquê | Não preenche dado pessoal por conta própria |
| **Respostas a perguntas frequentes** do colaborador/gestor ("quando cai meu VT?") | Baseado em base de conhecimento do cliente, com citação | Sem acesso a dado individual além do próprio solicitante |
| **Resumo de caso** | Para quem assume uma demanda longa: "o que aconteceu até aqui" | Gerado da linha do tempo auditada |
| **Classificador de solicitações** | Categoria, área, urgência | Proposta; correções humanas retroalimentam |
| **Detector de PJ com cara de CLT** | Sinais de subordinação no uso do sistema (aprovação de ausência, horário fixo) | Alerta para Jurídico, nunca bloqueio |

### 11.8 Crítica

- **Chatbot genérico de RH não diferencia.** Leena AI, Moveworks (hoje parte da
  ServiceNow) e os agentes Joule (SAP) e Illuminate (Workday) já ocupam esse
  espaço no mundo corporativo ([Leena AI](https://leena.ai/),
  [Moveworks](https://www.moveworks.com/),
  [Gloat — vendor landscape](https://gloat.com/academy/vendor-landscape-joule-sana-copilot/)).
  O Vinculato ganha na **IA encaixada no processo**, que esses produtos
  fazem de forma genérica e cara para o mercado médio brasileiro.
- **Custo e privacidade:** toda chamada de modelo com dado pessoal deve passar
  por minimização (enviar só o necessário), registro sem texto livre (regra
  atual do assistente) e opção de desligar por workspace.
- **Medir valor:** cada recurso de IA precisa de um contador de "proposta
  aceita sem edição / editada / rejeitada". Sem isso, repete-se a estatística
  do Gartner.

> Continua na [Parte 4 — Documentos, indicadores, alertas, auditoria, UX e mobile](04-documentos-indicadores-alertas-auditoria-ux-mobile.md).
