# Parte 4 — Documentos, indicadores, alertas, auditoria, UX e mobile

Seções 12 a 17 do formato pedido. A seção 16 (UX) inclui também as
**jornadas por perfil**, a **arquitetura funcional** e a **nova navegação**
(itens 33, 34 e 35 do pedido).

---

## 12. Gestão documental

### 12.1 Diagnóstico

Hoje documento é **anexo** (de demanda, de EPI, de comentário) e **PDF gerado**
(ficha de admissão, extratos PJ, relatórios). Falta o documento como **objeto
com ciclo de vida**: tipo, dono, validade, versão, status de assinatura,
obrigatoriedade.

### 12.2 Modelo proposto

```
Tipo de documento (catálogo)
  ├─ categoria (pessoal, contratual, SST, EPI, PJ, empresa)
  ├─ obrigatório para (Requisito: cargo/contrato/unidade)
  ├─ validade padrão (ex.: ASO periódico 12 meses; certificado NR-35 24 meses)
  ├─ retenção (ex.: ficha de EPI e ASO: 20 anos; LGPD: descarte após prazo)
  └─ quem vê (capability + restrição sensível: médico, jurídico)

Documento (instância)
  ├─ pessoa / empresa / processo de origem
  ├─ arquivo(s) + hash + versão
  ├─ status: solicitado → recebido → em conferência → válido | recusado → vencido
  ├─ campos extraídos (IA) com origem de cada campo
  ├─ assinatura: não exige | pendente | assinado (provedor, trilha)
  └─ validade (vira Prazo)
```

### 12.3 Funcionalidades

- **Modelos com variáveis** (`{{colaborador.nome}}`, `{{cargo.nome}}`,
  `{{jornada.data_alvo}}`, `{{empresa.cnpj}}`) em DOCX/HTML → PDF. Casos:
  contrato de trabalho, acordo de prorrogação, termo de VT, ficha de EPI,
  carta de promoção, aviso de férias, convocação para exame, termo de
  responsabilidade de equipamento.
- **Geração automática** pela etapa do processo (serviceTask "gerar
  documento").
- **Assinatura eletrônica por integração** (Clicksign, D4Sign, ZapSign,
  Docusign). ⚠️ **Não construir assinatura própria**: o custo de validade
  jurídica, carimbo de tempo e suporte é alto e já é commodity. Exceção:
  "ciência simples" (clique + registro de IP/HMAC + hora) para comunicados
  internos, que o Vinculato pode fazer sozinho.
- **Documentos obrigatórios por pessoa** (Requisito) com semáforo.
- **Versão**: nova versão não apaga a anterior; o processo aponta a versão
  usada (mesma filosofia das versões de processo).
- **Busca full-text** sobre o texto extraído (respeitando permissão).
- **Classificação automática** na chegada (IA documental).
- **Pasta virtual da pessoa** e **dossiê exportável** (Parte 1 §4.8).
- **Retenção e descarte** com política por tipo e relatório de descarte
  (LGPD), sem apagar o registro de auditoria de que existiu.

---

## 13. Indicadores

Critério de inclusão: **o indicador precisa mudar uma decisão**. Para cada um,
indico a decisão que ele apoia.

### 13.1 DP

| Indicador | Decisão que apoia |
| --- | --- |
| Tempo médio de admissão (aprovação → D0) e % de "Dia 1 pronto" | Onde investir: clínica, TI, documentos |
| Admissões iniciadas sem requisito crítico (ASO, contrato) | Risco legal; cobrar área responsável |
| Desligamentos pagos fora do prazo legal (nº e %) | Exposição à multa do art. 477 |
| Férias com período concessivo vencendo em 60/30 dias | Programar antes do pagamento em dobro |
| Experiências vencendo sem decisão do gestor | Cobrar gestores específicos |
| Solicitações por tipo, canal e área solicitante | Onde criar template/automação; quais gestores usam WhatsApp |
| SLA cumprido por tipo e por analista | Redistribuir carga |
| Taxa de retrabalho (solicitação devolvida por falta de informação) | Melhorar formulário e orientar gestores |
| Movimentações aplicadas sem aprovação registrada | Controle interno |
| Pendências cadastrais por empresa | Mutirão de cadastro antes do eSocial |
| Tempo de fechamento de competência e itens bloqueantes no fechamento | Antecipar conferências |
| Divergências de conferência de folha por competência | Qualidade do input para a folha |

### 13.2 RH

| Indicador | Decisão |
| --- | --- |
| Turnover em 90 dias (desligamento durante experiência) por gestor/unidade | Onde o onboarding falha |
| Tempo de aprovação de requisição de vaga | Gargalo de headcount |
| Promoções/mudanças de função sem os requisitos novos cumpridos | Risco SST |
| Absenteísmo (dias de afastamento por 100 colaboradores) por unidade | Ações de saúde |
| Ciência de políticas pendente | Comunicação interna |

### 13.3 SESMT

| Indicador | Decisão |
| --- | --- |
| % de ASO em dia (periódico) por unidade; vencidos | Mutirão de exames |
| Exames de mudança de função pendentes | Atualizar S-2240 |
| Retornos sem ASO de retorno | Risco imediato |
| Treinamentos NR vencidos por NR e unidade | Programação de turmas |
| Acidentes, dias perdidos, acidentes por tipo e setor (já existe) | Prioridade de prevenção |
| Planos de ação atrasados (acidente, inspeção, NR-1) | Cobrança |
| Incidentes e quase-acidentes registrados (mais registros = cultura melhor) | Engajamento de prevenção |
| Prazo de CAT cumprido | Conformidade eSocial |
| Cargos sem riscos mapeados / cargos novos sem revisão de PGR | Atualização do PGR |

### 13.4 EPI

| Indicador | Decisão |
| --- | --- |
| Conformidade de EPI por pessoa (exigido × em posse válido) | Entregas pendentes |
| Consumo por SKU, cargo, unidade e centro de custo | Orçamento e compra |
| Custo de EPI por colaborador/mês | Negociação com fornecedor; troca de modelo |
| Perdas (extravio + não devolução) e taxa de dano por uso inadequado | Treinamento; análise de desconto |
| Taxa de devolução no desligamento | Processo de saída |
| Dias de cobertura do estoque por local | Reposição |
| SKUs com CA vencendo e pessoas usando esse CA | Substituição |
| Entregas sem assinatura | Risco de prova |

### 13.5 Gestão / operação do Vinculato

| Indicador | Decisão |
| --- | --- |
| Itens parados > N dias por área | Escalonamento |
| Tempo médio em aprovação por aprovador | Delegação/alçada |
| Automação: % de propostas aceitas sem edição, editadas, rejeitadas | Calibrar limiares e IA |
| Integrações: disponibilidade, itens em dead-letter, tempo de recuperação | Suporte/implantação |
| Adoção: gestores ativos, % de solicitações pelo portal vs. WhatsApp | Sucesso do cliente |

### 13.6 Financeiro/Jurídico/TI

- Custo de benefícios × ativos (divergências na fatura).
- Reembolsos por centro de custo e tempo de aprovação.
- Dossiês gerados por processo trabalhista e tempo de montagem.
- Acessos ativos após desligamento (deve ser zero) e tempo médio de revogação.

---

## 14. Alertas

### 14.1 Motor de vencimentos

Todo prazo nasce de uma **regra de prazo**:

```
tipo            origem                         data-base                    antecedência      severidade no prazo
experiencia     colaborador.admissao           admissão + 45 / + 90         15, 5, 1          urgente → crítico
ferias_concess. período aquisitivo             fim do concessivo            90, 60, 30        atenção → urgente → crítico
aso_periodico   exame.validade                 validade                     45, 15, 5         atenção → urgente → crítico
treinamento     treinamento.validade           validade                     60, 30, 7         atenção → urgente
epi_troca       entrega + replacement_days     data calculada               15, 3             informativo → atenção
ca_epi          produto.ca_validade            validade do CA               60, 30            atenção → urgente
documento       documento.validade             validade                     30, 7             atenção → urgente
contrato_pj     contrato.fim                   fim                          60, 30, 7         atenção → urgente
banco_horas     saldo por período              vencimento do período        30, 7             atenção → urgente
obrigacao       calendário legal               data legal                   5, 2, 0           urgente → crítico
cat             acidente.data                  1º dia útil seguinte         0                 crítico
rescisao        desligamento.data              + 10 dias                    5, 2, 0           urgente → crítico
processo_parado atividade                      última atividade + N         —                 atenção
sla             etapa                          prazo da etapa               configurável      conforme política
```

### 14.2 Classificação

| Nível | Significado | Canal | Exemplo |
| --- | --- | --- | --- |
| **Informativo** | Sabe-se, sem ação agora | Só na plataforma (resumo diário) | Troca de EPI em 15 dias |
| **Atenção** | Ação necessária nos próximos dias | Plataforma + resumo diário | ASO periódico vence em 30 dias |
| **Urgente** | Ação necessária hoje ou amanhã; ainda sem consequência legal | Plataforma + notificação imediata ao responsável | Experiência vence em 5 dias sem decisão |
| **Crítico** | Consequência legal, financeira ou de segurança iminente ou já ocorrida | Todos os canais + responsável + coordenador (+ gestor quando for dele) | Rescisão vence amanhã; retorno sem ASO; CAT vence hoje |

### 14.3 Regras anti-ruído

- **Agrupamento**: 30 ASOs vencendo viram **um** alerta com a lista, não 30.
- **Deduplicação** pelo `event_key` (mecanismo já existente em
  `fdp_notifications`).
- **Um responsável por alerta** (nunca "todo mundo").
- **Silenciar com motivo e prazo** (auditado).
- **Alerta → tarefa**: ao entrar em "urgente", o alerta vira item na Central de
  Trabalho do responsável; não fica só no sininho.

---

## 15. Auditoria

### 15.1 O que já existe

`fdp_audit_events` append-only (trigger), com antes/depois em JSONB,
`request_id`, ator, workspace; auditoria de plataforma separada; eventos de
domínio com `correlationId`/`causationId`; razão append-only de EPI;
exportações registradas.

### 15.2 O que falta

| Pergunta | Campo/recurso | Situação |
| --- | --- | --- |
| Quem fez | ator (usuário, agente, integração, link externo) | Usuário sim; **tipo de ator** precisa ser explícito para agente/portal |
| Quando | `occurred_at` | Sim |
| Antes / depois | JSONB | Sim |
| **Motivo** | `reason` obrigatório para ações sensíveis | Parcial (reabertura exige; generalizar) |
| **Processo relacionado** | `correlation_id` → jornada/demanda | Existe nos eventos de domínio; **levar para a auditoria** |
| **Integração** | origem, `externalId`, execução | Existe em `fdp_integration_*`; ligar |
| **Documento** | referência ao documento/versão/hash | Não |
| **Leitura sensível** | quem **viu** dado sensível (CPF completo, atestado, salário) | Não — importante para LGPD |
| **Linha do tempo por entidade** | visão cronológica de pessoa, empresa, processo | Parcial (EPI tem; generalizar) |
| **Investigação** | filtro por ator, período, ação, entidade; exportação assinada | Pedido na auditoria de 11/08; confirmar e completar |
| **Integridade verificável** | encadeamento por hash (cada evento carrega o hash do anterior) | Não — diferencial barato para disputa judicial |

### 15.3 Linha do tempo (exemplo)

```
João Silva — Linha do tempo
12/03 09:14  Admissão aprovada por Ana (RH) — Jornada #A-1043
12/03 09:15  [automação] 9 tarefas criadas (DP 3, SESMT 2, TI 2, Almox. 1, Facilities 1)
13/03 16:40  [clínica via portal] ASO admissional: APTO — doc v1 (hash 7c2e…)
14/03 10:02  [agente Sankhya] cadastro proposto → confirmado por Carla (DP)
15/03 08:30  EPI entregue: Botina CA 12345, Luva CA 67890 — assinatura biométrica
15/03 08:31  Veredito "Dia 1 pronto" atingido
…
02/09 11:20  Mudança de função solicitada por Marcos (gestor) — motivo: …
02/09 11:21  [motor] novos requisitos: exame mudança de função, NR-35, cinto paraquedista
```

---

## 16. UX

### 16.1 Problemas típicos de sistemas corporativos (e onde o Vinculato está)

| Problema | Vinculato hoje |
| --- | --- |
| Menus demais | 29 visões no painel; 8 só de PJ |
| Campos demais | Formulários de cadastro e movimentação completos para todos os casos |
| Cliques demais | Resolver um item exige sair da Central para a tela do módulo |
| Difícil achar funções | Busca global existe; comandos ainda não |
| Informação duplicada | Pessoa aparece em cadastro, EPI, ponto, PJ, com fichas diferentes |
| Configuração escondida | Modal de configurações com 9 seções |

### 16.2 Princípios propostos

1. **Trabalho primeiro, módulo depois.** A tela inicial é a Central de Trabalho
   (para quem executa) ou o Command Center (para quem coordena).
2. **Pessoa como contexto.** Tudo que é de alguém aparece na ficha 360 dessa
   pessoa. Módulos são "lentes".
3. **Comando antes de menu.** `Ctrl+K` faz tudo que o menu faz, mais ações.
4. **Formulário progressivo.** Pede só o que o tipo exige; o resto vem da
   pessoa/cargo; a IA sugere.
5. **Consequência antes de confirmar.** Padrão já usado no EPI (a tela mostra o
   destino antes de gravar) — generalizar para toda ação com efeito em cadeia
   ("isso vai criar 6 tarefas em 4 áreas").
6. **Explicar o bloqueio** (já é regra do motor) em linguagem de negócio.
7. **Densidade para analista, simplicidade para gestor.** Duas camadas de
   interface sobre a mesma API.

### 16.3 Jornadas por perfil (item 33)

**Funcionário**
1. Recebe convite por WhatsApp/e-mail antes do D0 → envia documentos pela
   câmera (IA confere na hora e diz o que falta) → assina contrato e termos.
2. No D0, recebe EPI (assina no tablet do almoxarife), faz integração (ciência
   registrada).
3. Ao longo do tempo, recebe só **pendências pessoais** (exame periódico
   agendado, reciclagem NR-35, troca de EPI, atualizar comprovante) — cada uma
   com um toque para resolver.
4. Pede algo (reembolso, segunda via, EPI danificado) e acompanha sem
   perguntar no WhatsApp.
5. No desligamento, vê a lista do que devolver e o status da rescisão.

**Gestor**
1. Abre "Contratar" no portal → formulário curto → aprovação sobe sozinha.
2. Acompanha a admissão pela linha do tempo; recebe alerta se o Dia 1 está em
   risco.
3. Recebe no Teams/WhatsApp: "avaliar experiência da Maria (vence em 15
   dias)" → responde com um toque.
4. Aprova férias, horas extras, mudanças — com resumo de impacto.
5. Vê "Minha equipe": requisitos vencendo, afastados, férias programadas.

**Analista DP**
1. Começa o dia pelo resumo e pela Central: vence hoje, aprovar, bloqueados.
2. Solicitações chegam **estruturadas** (portal ou IA de entrada); a triagem só
   recebe o que é realmente ambíguo.
3. Confere documentos com os campos já extraídos e as divergências marcadas.
4. Agentes cadastram no ERP e no ponto; ele confirma.
5. No fechamento, a conferência por variação lista só o que não tem explicação.

**RH**
1. Aprova requisições de vaga e acompanha jornadas de admissão em lote.
2. Monitora turnover em 90 dias, experiência sem decisão, ciência de políticas.
3. Configura templates (carta de promoção, política) e os ciclos (avaliação de
   experiência).

**SESMT**
1. Vê no Command Center: ASO vencidos, mudanças de função sem exame, retornos
   sem ASO, treinamentos vencendo, CA vencendo.
2. Recebe automaticamente a tarefa de exame de cada admissão/mudança/retorno
   — não depende mais de o DP lembrar.
3. Registra acidente pelo celular; o prazo da CAT e o plano de ação já nascem.
4. Mantém a Matriz de Requisitos (riscos → exames, EPI, treinamentos).
5. Gera o dossiê de SST de uma pessoa em um clique para perícia.

**Administrador do sistema**
1. Onboarding guiado: importar empresas/cargos/colaboradores (planilha ou
   agente), escolher templates, definir áreas e responsáveis.
2. Configura requisitos por **pacote de segmento** em vez de do zero.
3. Gerencia usuários, permissões, integrações e agentes com saúde visível.
4. Recebe relatório mensal de adoção e de automações sugeridas.

### 16.4 Arquitetura funcional (item 34)

A estrutura sugerida no pedido (Trabalho / Pessoas / Processos / Operação DP /
RH / SESMT / EPI / Documentos / Integrações / Indicadores / Administração)
repete o erro de hoje: **organiza por departamento**, e o produto quer
justamente quebrar a fronteira entre departamentos. Proposta alternativa,
organizada por **tipo de trabalho**:

```
Vinculato
├── 1. TRABALHO          o que fazer agora
│     Central de Trabalho · Triagem · Aprovações · Calendário/Prazos
├── 2. PESSOAS           de quem é
│     Colaboradores (ficha 360) · Prestadores PJ · Equipes/Organograma
│     Requisitos (matriz e conformidade) · Itens em posse
├── 3. JORNADAS E PROCESSOS   como o trabalho anda
│     Jornadas em andamento · Solicitações · Biblioteca de processos/templates
├── 4. OPERAÇÕES          as rotinas com regra legal própria (lentes)
│     DP: Competências, Movimentações, Ponto, Benefícios, Adiantamentos
│     SST: Exames, Treinamentos, Acidentes, Planos de ação
│     EPI: Estoque, Entregas, Devoluções, Descarte
│     Pagamentos: PJ, Psicologia, Caju
├── 5. DOCUMENTOS        modelos, documentos, assinaturas, dossiês
├── 6. VISÃO             Command Center · Indicadores · Relatórios · Auditoria
└── 7. CONFIGURAR        Empresas/unidades/áreas · Usuários e permissões
                         Integrações e agentes · Automações · Prazos · API
```

Diferenças importantes em relação à proposta original:

- **"Operação DP", "RH", "SESMT" e "EPI" deixam de ser áreas de topo** e viram
  lentes dentro de Operações. Quem é do SESMT fixa a lente SST; quem é do DP
  fixa a de DP. O menu se adapta à área principal do usuário (a tabela de
  área principal já existe).
- **"Integrações" sai do topo e vai para Configurar**: é assunto de
  administrador. O que o analista precisa ver (falha de integração) já chega
  como item na Central.
- **Pessoas é de primeiro nível**, porque a pessoa é o contexto de quase tudo.
- **PJ deixa de ter 8 visões de primeiro nível** e vira uma lente com abas.

### 16.5 Nova navegação (item 35)

- **Barra lateral com 6 itens fixos**: Trabalho · Pessoas · Jornadas ·
  Operações · Documentos · Visão (Configurar no rodapé, só para quem pode).
- **Operações abre as lentes da área do usuário**; as outras ficam em "mais".
- **`Ctrl+K`** como navegação principal para usuários frequentes: pessoas,
  registros, comandos e perguntas.
- **Recentes e fixados** (demandas, pessoas, filtros).
- **Contexto persistente**: o seletor de empresa/unidade fica no topo e vale
  para todas as telas (já existe filtro de empresa no endereço).
- **Breadcrumb de jornada**: dentro de uma tarefa filha, sempre um link para o
  caso-pai.
- **Atalhos de teclado** documentados (`?` abre a lista).
- **Portal do Gestor e Caixa do Colaborador são outras interfaces**, não
  seções escondidas do painel.

---

## 17. Mobile

**Não replicar o sistema.** O mobile resolve cinco momentos em que a pessoa
não está na mesa:

| Prioridade | Uso | Quem | Por que no celular |
| --- | --- | --- | --- |
| 1 | **Aprovar** (férias, horas, movimentação, compra, desligamento) com resumo de impacto | Gestor, diretoria | O gargalo de aprovação é gente fora da mesa |
| 2 | **Pendências pessoais**: enviar documento pela câmera, assinar, dar ciência, ver exame agendado | Colaborador | O colaborador operacional não tem computador |
| 3 | **Entrega/devolução de EPI** com leitura de código de barras/QR, foto e assinatura na tela | Almoxarife, técnico SST | Acontece no almoxarifado ou na frente de obra |
| 4 | **Registro de ocorrência**: acidente, incidente, inspeção com foto e localização | SESMT, gestor, colaborador | Acontece no chão de fábrica |
| 5 | **Notificações acionáveis** e a Minha fila em modo leitura | Todos | Saber o que é urgente sem abrir o notebook |

**Tecnologia sugerida:** começar como **PWA** (instalável, câmera, offline
leve para inspeção/entrega de EPI) sobre o mesmo Next.js; app nativo só se
biometria de entrega ou offline pesado se provarem necessários. Boa parte do
"mobile" do colaborador pode ser **link assinado aberto no navegador a partir
do WhatsApp**, sem instalar nada — o que aumenta muito a adesão em operação
de chão de fábrica.

> Continua na [Parte 5 — Benchmark, lacunas, o que não fazer e ideias novas](05-benchmark-lacunas-e-ideias.md).
