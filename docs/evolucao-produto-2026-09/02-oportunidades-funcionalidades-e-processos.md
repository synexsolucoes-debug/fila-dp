# Parte 2 — Oportunidades, funcionalidades e processos interdepartamentais

Seções 5 a 7 do formato pedido.

---

## 5. Oportunidades

As oportunidades se agrupam em **cinco primitivas**. Quase toda ideia deste
documento é uma combinação delas, e é por isso que elas vêm antes da lista de
funcionalidades: construir as primitivas certas evita construir quarenta telas.

| # | Primitiva | O que é | Já existe? | Por que é central |
| --- | --- | --- | --- | --- |
| P1 | **Jornada** | Um evento de pessoa (admitir, desligar, transferir, afastar, promover, retornar) abre um *caso-pai* que gera tarefas filhas em várias áreas, com dependências e um veredito ("pronto para o dia 1", "desligamento concluído") | Os eventos existem (`employee.admitted`, `termination.requested`…); o caso-pai com filhas por área não | É o que faz o trabalho circular sozinho. O modelo é o *Lifecycle Event* do ServiceNow HRSD, que agrupa atividades de vários departamentos num caso central ([ServiceNow Community](https://www.servicenow.com/community/hrsd-blog/hr-lifecycle-events-101-what-are-they-and-how-do-you-configure/ba-p/2279110)) |
| P2 | **Requisito** | Regra "quem tem cargo/risco/unidade X precisa de Y, renovado a cada N dias": EPI, exame, treinamento, documento, acesso, uniforme | Só para EPI (`fdp_epi_requirements`) | Transforma "saber de cabeça o que um soldador precisa" em dado. É o que a Rippling chama de *employee graph*: a automação vira propriedade do modelo de dados ([Rippling](https://www.rippling.com/blog/introducing-rippling-platform)) |
| P3 | **Prazo** | Qualquer coisa que vence: experiência, férias, ASO, treinamento, CA, contrato PJ, documento, obrigação, SLA, banco de horas | Fragmentado (SLA, obrigações, CA) | Remove a dependência de memória. Vira fonte da Central de Trabalho |
| P4 | **Porta externa** | Link assinado, com prazo e escopo, para quem não tem assento: gestor, colaborador, clínica, prestador, fornecedor | Só para nota fiscal PJ | Alcança quem hoje é alcançado pelo WhatsApp |
| P5 | **Proposta** | Tudo que vem de fora ou de IA entra como proposta → motor → triagem ou execução | Sim (agentes, Teams, OCR) | É a base segura para IA e automação. Já existe; o trabalho é estender a novos canais |

### 5.1 Oportunidades por valor (resumo)

1. **Jornadas de pessoa** (admissão, desligamento, transferência, mudança de
   função, afastamento, retorno) — maior redução de retrabalho entre áreas.
2. **Matriz de Requisitos** — resolve de uma vez EPI, exames, treinamentos,
   documentos e acessos por cargo/risco.
3. **Motor de Prazos** — mata o maior grupo de planilhas do DP e do SESMT.
4. **Portal do Gestor sem assento** — alivia o DP e aumenta a adesão.
5. **SESMT operacional mínimo** (exames, treinamentos, restrições, planos de
   ação) — abre um comprador novo (SESMT) dentro do mesmo cliente.
6. **Dossiê do colaborador** — venda para o jurídico e defesa em ação
   trabalhista.
7. **IA de entrada** (WhatsApp/Teams/e-mail → solicitação estruturada).
8. **Itens em posse** (generalização do EPI para crachá, chave, notebook,
   uniforme, veículo).
9. **Biblioteca de templates** (Parte 6 §23) — reduz o tempo até o primeiro
   valor.
10. **Command Center** — dá ao diretor uma razão para abrir o produto.

---

## 6. Funcionalidades sugeridas

Organizadas por primitiva. Itens marcados com ⚠️ têm ressalva crítica.

### 6.1 Jornadas (P1)

- Catálogo de **tipos de jornada** com gatilho (evento), tarefas por área,
  dependências (tarefa B só começa quando A termina) e **veredito** (condição
  de conclusão).
- **Caso-pai** visível como uma única linha na Central de Trabalho de quem
  coordena, com barra de progresso por área.
- **Tarefas filhas** entram na fila de cada área como `WorkItem` (nova fonte em
  `lib/work-items.ts`, respeitando a regra §11 da arquitetura).
- **Data-alvo** da jornada (data de início, data do desligamento) que calcula
  os prazos de cada tarefa em D−N/D+N, com dias úteis e feriados (a tabela
  `fdp_business_holidays` já existe).
- **Relógio legal** exibido em destaque quando há prazo de lei (10 dias da
  rescisão, 1 dia útil da CAT, 15 dias para INSS).
- **Replanejamento**: mudou a data de início → todas as tarefas recalculam e os
  responsáveis são avisados.
- **Cancelamento com cascata**: candidato desistiu → tarefas filhas canceladas
  com motivo, EPI reservado volta, acesso não criado.
- ⚠️ **Não** permitir que uma jornada avance etapa de processo sozinha — a
  regra já existente de ator humano identificado continua valendo.

### 6.2 Requisitos (P2)

- **Cargo como entidade rica**: CBO, descrição, riscos (físico, químico,
  biológico, ergonômico, acidente, psicossocial), atividades especiais
  (altura, eletricidade, espaço confinado, máquinas).
- **Regras de requisito** por escopo (empresa → unidade → departamento → cargo
  → risco → atividade) com herança e exceção individual justificada.
- Tipos de requisito: EPI, exame ocupacional, treinamento, documento, acesso a
  sistema, item em posse, integração/ciência de política.
- **Situação de conformidade por pessoa**: em dia / vencendo / vencido /
  pendente / dispensado (com justificativa e aprovador).
- **Simulador**: "se eu mudar o Pedro para Eletricista, o que muda?" (novos
  exames, NR-10, EPIs, devoluções).
- **Bloqueio configurável**: não liberar início de atividade/escala sem
  requisitos críticos (NR-35 para trabalho em altura, por exemplo). ⚠️ O
  bloqueio é um alerta forte no Vinculato; a liberação física é da empresa.

### 6.3 Prazos (P3)

- Registro único de prazos com origem, pessoa/empresa, data, severidade,
  responsável e **ação sugerida**.
- **Regras de antecedência** por tipo (ex.: ASO periódico avisa 45/15/5 dias
  antes; experiência 15/5 dias; CA 60/30 dias).
- **Classificação**: informativo, atenção, urgente, crítico (Parte 4 §14).
- Prazo que chega à janela de ação **vira tarefa** na Central de Trabalho — não
  só um alerta.
- **Calendário** (já existe planner) com camada de prazos.

### 6.4 Portas externas (P4)

- **Link assinado genérico** (reaproveitar o mecanismo do portal de nota PJ)
  para: aprovar, responder formulário, enviar documento, assinar, dar ciência.
- **Portal do Gestor** leve: minha equipe, minhas pendências, minhas
  solicitações, abrir solicitação.
- **Caixa do Colaborador**: pendências pessoais e acompanhamento.
- **Portal de parceiro**: clínica ocupacional devolve ASO; escritório contábil
  consulta pendências; fornecedor de EPI confirma entrega.
- **Canais de notificação**: e-mail (Resend já está no projeto), Teams
  (Power Automate ou Graph), WhatsApp (API oficial do Meta, com modelos
  aprovados), com preferência por pessoa e **resumo diário**.

### 6.5 Propostas e IA (P5)

- IA de entrada por texto livre em qualquer canal (Parte 3 §11).
- IA documental na chegada do anexo.
- Sugestões de automação a partir de padrões repetidos.

### 6.6 Funcionalidades transversais

- **Dossiê do colaborador** (PDF/ZIP assinado com hash, auditado).
- **Itens em posse** (generalização do EPI).
- **Plano de ação** reutilizável (acidente, inspeção, NR-1, auditoria interna).
- **Ciência de documentos/políticas** com prova.
- **Requisição de vaga** com aprovação de headcount.
- **Solicitações favoritas** e **modelos de resposta** para o analista.
- **Exportação do workspace** (portabilidade — pendência já apontada em 11/08).

---

## 7. Processos interdepartamentais

Cada processo segue o formato: **Evento inicial → tarefas automáticas →
responsáveis → aprovações → documentos → dependências → SLA → alertas →
conclusão.** D0 é a data-alvo da jornada.

### 7.1 Admissão CLT

- **Evento inicial:** candidato aprovado (ATS/Sólides) ou requisição de vaga
  aprovada + candidato definido → `admission.created`.
- **Tarefas automáticas:**
  | Área | Tarefa | Prazo |
  | --- | --- | --- |
  | DP | Coletar e conferir documentos (IA documental) | D−5 |
  | SESMT | Agendar e registrar exame admissional; registrar apto/inapto/restrição | agendar D−7, resultado D−2 |
  | DP | Cadastrar no ERP/folha (agente Sankhya) e no ponto (agente Tangerino) | D−1 |
  | Benefícios | Incluir VT, VA/VR, plano de saúde conforme elegibilidade | D−1 (VT antes do 1º dia) |
  | TI | Criar usuário, e-mail, acessos pelo perfil do cargo; separar equipamento | D−3 |
  | Almoxarifado/SESMT | Separar EPIs e uniforme pela Matriz de Requisitos | D−1 |
  | Facilities | Crachá, armário, mesa, chave, vaga | D−1 |
  | SESMT/RH | Agendar integração e treinamentos obrigatórios do cargo | D0 a D+5 |
  | Gestor | Confirmar data, escala, primeira semana | D−5 |
  | Colaborador | Enviar documentos, assinar contrato e termos, dar ciência das políticas | D−5 a D0 |
- **Aprovações:** requisição de vaga (gestor → diretoria/RH, por alçada); salário
  fora da faixa exige aprovação adicional.
- **Documentos:** documentos pessoais, contrato de trabalho, acordo de
  compensação/prorrogação, termo de VT, ficha de EPI, ciência de regulamento,
  termo LGPD, ASO.
- **Dependências:** cadastro no ponto depende do cadastro no ERP (matrícula);
  entrega de EPI depende do ASO apto; início depende de ASO + contrato
  assinado.
- **SLA:** jornada completa até D0; cada tarefa com seu D−N.
- **Alertas:** D−2 sem ASO → **crítico** para DP, SESMT e gestor; D−1 sem
  acesso → urgente para TI; candidato sem documento em D−3 → mensagem ao
  candidato.
- **Conclusão:** veredito **"Dia 1 pronto"** quando todos os itens críticos
  estão verdes; ao fim do D+5, jornada fechada com os treinamentos agendados.

### 7.2 Desligamento

- **Evento inicial:** `termination.requested` (gestor, DP ou pedido de demissão).
- **Aprovações:** gestor → RH/diretoria (desligamento sem justa causa por
  alçada); justa causa exige Jurídico.
- **Tarefas:**
  | Área | Tarefa | Prazo |
  | --- | --- | --- |
  | DP | Definir tipo, aviso prévio, data de saída; calcular prazo de pagamento (10 dias) | D0 |
  | SESMT | Exame demissional (ou dispensa, se ASO recente dentro do prazo do PCMSO) | até D+10 |
  | Jurídico | Revisar se há estabilidade (acidentária, gestante, CIPA, sindical) | antes da comunicação |
  | TI | Bloquear acessos, recolher equipamento, transferir dados | D0 (bloqueio no horário da comunicação) |
  | Almoxarifado | Devolução de EPI e uniforme (condição decide destino) | D0 |
  | Facilities | Crachá, chaves, veículo, armário, vaga | D0 |
  | Benefícios | Exclusão de VT/VA/VR; comunicação sobre plano de saúde (art. 30/31 da Lei 9.656) | D+1 |
  | Financeiro | Pagamento da rescisão | até D+10 |
  | DP | Termo de rescisão, guias, eSocial S-2299 | até D+10 |
  | Gestor | Passagem de pendências do desligado; entrevista de desligamento (opcional) | D−1 a D+2 |
- **Dependências:** a análise de estabilidade bloqueia a comunicação; o bloqueio
  de acessos é **sincronizado com o horário da comunicação** (não antes, para
  não vazar; não depois, para não deixar janela).
- **Alertas:** D+7 sem pagamento confirmado → **crítico** (multa do art. 477);
  EPI não devolvido → abre análise de desconto (regra atual, nunca
  automática); acesso ativo após D0 → crítico para TI.
- **Conclusão:** "Desligamento concluído" só com zero acesso ativo, zero item
  em posse, rescisão paga e demissional registrado.

### 7.3 Transferência (unidade/empresa/centro de custo)

- **Evento:** movimentação `transfer` aprovada.
- **Tarefas:** DP (alteração cadastral, eSocial se muda de estabelecimento/CNPJ
  — transferência entre CNPJs pode exigir desligamento/admissão ou evento
  próprio), SESMT (riscos do novo ambiente, exame se mudar risco), EPI
  (requisitos do novo local: entregar novos, recolher dispensáveis), TI
  (acessos da nova unidade, revogar os antigos), Benefícios (VT com novo
  trajeto), Facilities (crachá/acesso físico), gestor antigo e novo (passagem).
- **Dependência:** a revogação dos acessos antigos só acontece após o gestor
  novo confirmar o início.
- **Conclusão:** requisitos do novo cargo/local 100% conformes.

### 7.4 Promoção e mudança de função

- **Evento:** `role.change_requested` / `salary.change_requested`.
- **Aprovações:** gestor → RH (faixa) → diretoria se fora da política.
- **Tarefas:** DP (alteração salarial/cargo com competência de efeito), SESMT
  (**exame de mudança de função quando muda o risco**, atualização do S-2240),
  EPI e treinamentos novos pela Matriz de Requisitos, TI (perfil de acesso),
  comunicação ao colaborador (carta de promoção para assinar).
- **Alerta-chave:** mudança de cargo **com** novo risco e **sem** exame em
  X dias → crítico para SESMT.
- ⚠️ O Vinculato **não** decide se a mudança muda o risco: ele compara os riscos
  cadastrados do cargo antigo e do novo e pede confirmação ao SESMT.

### 7.5 Afastamento (doença, acidente, maternidade)

- **Evento:** atestado recebido (colaborador envia foto pela caixa pessoal →
  IA documental extrai datas, **não** o CID) ou acidente registrado.
- **Tarefas:** DP (contagem de dias; no 16º dia de afastamento pela mesma
  causa em 60 dias, encaminhamento ao INSS; eSocial S-2230), SESMT (análise
  de nexo quando acidente; programação do ASO de retorno), gestor (cobertura
  da escala), Benefícios (regras do plano durante afastamento).
- **Dados sensíveis:** o módulo guarda **datas e tipo** de afastamento. O
  atestado fica em cofre com acesso restrito a SESMT/medicina — mesmo padrão
  da Psicologia, que já proíbe CID e dado clínico.
- **Conclusão:** afastamento encerrado → dispara a jornada de Retorno.

### 7.6 Retorno ao trabalho

- **Evento:** data prevista de fim de afastamento (Prazo) ou alta do INSS.
- **Tarefas:** SESMT (ASO de retorno — obrigatório após 30 dias ou mais de
  afastamento por doença ou acidente, pela NR-7), registro de restrições
  (sem diagnóstico), gestor (ciência das restrições e readequação), DP
  (estabilidade acidentária de 12 meses quando for o caso; eSocial), EPI e
  treinamentos (reciclagem vencida durante o afastamento).
- **Bloqueio:** retorno sem ASO de retorno → **crítico** para DP e gestor.

### 7.7 Acidente de trabalho

- **Evento:** registro de acidente pelo SESMT, gestor ou colaborador (mobile,
  com foto e local).
- **Tarefas:** SESMT (CAT/S-2210 até o 1º dia útil seguinte; em caso de morte,
  imediatamente), investigação (árvore de causas/5 porquês) em até N dias,
  **plano de ação** com responsáveis, DP (afastamento, estabilidade, S-2230),
  gestor (testemunhas e relato), Jurídico (se grave), EPI (verificar ficha de
  entrega e CA do EPI envolvido — **o dossiê já sai pronto**).
- **Conclusão:** plano de ação concluído com evidência; o dashboard de
  acidentes existente passa a ter "planos de ação atrasados".

### 7.8 Abertura de nova unidade

- **Evento:** decisão de abrir unidade (projeto com data de inauguração).
- **Tarefas:** Administrativo (endereço, CNPJ/filial, alvarás), DP (cadastro do
  estabelecimento, sindicato/CCT da base territorial, calendário de feriados
  locais), SESMT (PGR e PCMSO da unidade, CIPA/designado, brigada, LTCAT),
  EPI (local de estoque, estoque inicial pelos cargos previstos), TI (rede,
  equipamentos, perfis), Compras (mobiliário, uniformes), RH (quadro previsto
  → requisições de vaga → jornadas de admissão em lote).
- **Diferencial:** o quadro previsto × Matriz de Requisitos gera
  automaticamente a **lista de compras de EPI e a agenda de exames** da
  inauguração.

### 7.9 Mudança de jornada/escala

- **Evento:** gestor pede mudança de horário.
- **Tarefas:** DP (aditivo contratual, validação da CCT — ex.: 12×36 exige
  previsão em norma coletiva), ponto (atualizar escala via agente), Benefícios
  (VT se o trajeto/dias mudam), colaborador (assinar aditivo).
- **Alerta:** escala incompatível com a CCT cadastrada → bloqueio com a
  cláusula citada.

### 7.10 Contratação de PJ

- **Evento:** requisição de contratação PJ.
- **Tarefas:** Jurídico (contrato, revisão de cláusulas de autonomia),
  Financeiro (cadastro de fornecedor), Compras (se houver cotação), gestor
  (escopo e entregáveis), TI (acesso **como terceiro**, com prazo), Vinculato
  (política de limite de nota, ciclo de pagamento — já existe).
- ⚠️ **Cuidado de produto (Tema 1389):** a jornada de PJ **não** deve ter
  aprovação de férias, controle de ponto nem avaliação de desempenho de
  empregado. O produto deve inclusive **alertar** quando alguém tentar
  aplicar a um PJ um processo típico de CLT.

### 7.11 Férias

- **Evento:** Prazo do período concessivo (automático) ou solicitação do
  colaborador/gestor.
- **Tarefas:** gestor aprova período; DP valida regras (fracionamento em até 3
  períodos, um com ≥14 dias; início não pode ser nos 2 dias antes de feriado
  ou repouso), aviso ao colaborador com 30 dias, pagamento até 2 dias antes;
  TI (resposta automática de e-mail, se desejado); gestor (cobertura).
- **Alerta:** período concessivo vencendo em 60 dias sem programação → urgente
  para gestor e DP (férias em dobro).

### 7.12 Reembolso de despesa

- **Evento:** colaborador envia comprovante (foto).
- **Tarefas:** IA documental extrai valor/data/CNPJ; gestor aprova; Financeiro
  paga (fora do Vinculato) e confirma; DP é envolvido só se virar desconto ou
  verba.

> Continua na [Parte 3 — Central de Trabalho, Motor de Processos, Agentes e IA](03-central-motor-agentes-e-ia.md).
