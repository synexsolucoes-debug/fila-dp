# Parte 1 — Resumo executivo, diagnóstico e dores por departamento

Data: 2026-09-23 · Seções 1 a 4 do formato pedido.

---

## 1. Resumo executivo

**A tese em uma frase.** O Vinculato já tem o motor mais difícil de construir
(eventos, processos versionados, trabalho unificado, agentes que só propõem,
auditoria à prova de adulteração, isolamento por tenant comprovado). O que falta
não é mais motor: é **o objeto "Pessoa" como gatilho**, **o motor de prazos** e
**as portas de entrada para quem não é analista** (gestor, colaborador,
prestador). Sem essas três peças, o trabalho continua sendo empurrado por gente,
não pelo sistema.

**Cinco conclusões que orientam todo o resto:**

1. **O Vinculato está mais perto de um "sistema de controle do DP de um cliente"
   do que de uma plataforma.** Olhando o repositório, a maior parte do código de
   domínio recente é vertical e específica — Pagamentos PJ com Caju,
   Psicologia, adiantamentos (`payroll-ledger`), ficha cadastral da Sólides,
   worker Tangerino, catálogos Sankhya. Tudo bem feito, mas cada um resolve a
   dor de *uma* operação. Se o próximo ano repetir esse padrão, o produto vira
   uma coleção de módulos sob medida, caro de vender e de manter. O antídoto é
   generalizar o que já existe em três primitivas: **Jornada** (evento de
   pessoa → trabalho em várias áreas), **Requisito** (o que um cargo/risco
   exige) e **Prazo** (tudo que vence).

2. **A ponte DP ↔ SESMT é a maior oportunidade e o maior buraco.** O SESMT hoje
   tem só o dashboard de acidentes. Não há controle de ASO, exames periódicos,
   treinamentos de NR, restrições médicas nem retorno ao trabalho. Ao mesmo
   tempo, as multas do eSocial SST subiram muito com a Portaria MTE 1.131/2025
   (a omissão do S-2240 pode passar de R$ 336 mil por infração) e a NR-1 com
   riscos psicossociais passou a ser fiscalizada em 26/05/2026. O Vinculato não
   deve emitir ASO nem PGR (isso é do software de SST e da clínica). Ele deve
   **orquestrar e cobrar os prazos**, que é exatamente onde as empresas falham.

3. **O EPI já é o módulo mais maduro, e ele mostra o caminho.** A tabela
   `fdp_epi_requirements` (empresa + departamento + cargo → EPI, quantidade,
   dias para troca) já é uma matriz de requisitos por cargo. Generalizá-la para
   exames, treinamentos, documentos e acessos transforma um módulo num motor:
   *"admitiu um soldador na unidade X → o sistema já sabe o que ele precisa ter,
   até quando, e quem entrega"*.

4. **O trabalho ainda circula por gente, não pelo sistema.** O canal de saída
   é fraco: as notificações são internas, o e-mail transacional só cobre
   confirmação de cadastro e o canal WhatsApp está declarado no catálogo de
   integrações sem ter implementação. A Central de Trabalho responde "o que está
   comigo", mas quem não abre o Vinculato (gestor, colaborador, clínica,
   prestador) nunca é alcançado. O padrão do portal de nota fiscal do PJ (link
   assinado com prazo, sem ocupar assento) já provou que funciona e deve virar
   o padrão geral.

5. **A IA deve seguir a mesma regra dos agentes: ela propõe, o motor decide.**
   O repositório já tem a disciplina certa (catálogo fechado de consultas,
   "sugestão, nunca origem" no OCR, triagem quando há incerteza). A maior parte
   do mercado ainda não colheu valor da IA em RH — 88% dos líderes de RH dizem
   que não tiveram ganho significativo com ferramentas de IA
   ([Gartner, out/2025](https://www.gartner.com/en/newsroom/press-releases/2025-10-28-gartner-survey-shows-88-percent-of-hr-leaders-say-their-organizations-have-not-realized-significant-business-value-from-ai-tools)).
   A razão costuma ser IA solta, fora do processo. O Vinculato pode ganhar
   justamente por fazer o contrário: **IA embutida em pontos exatos do fluxo**
   (entrada, documento, conferência, risco), sempre passando pela triagem.

**O que eu faria antes de qualquer expansão** (detalhes na Parte 6):
Motor de Jornadas sobre os eventos que já existem → Matriz de Requisitos por
cargo/risco → Motor de Prazos como fonte da Central de Trabalho → Portal do
Gestor via link assinado + notificação externa (e-mail/Teams/WhatsApp) → SESMT
mínimo (ASO, exames, treinamentos, restrições) plugado nessas quatro peças.
**Compras, Facilities, Jurídico e TI entram como templates de processo, não
como módulos.**

---

## 2. Diagnóstico do Vinculato

Diagnóstico feito sobre o código (`db/schema.ts` com ~135 tabelas, 94 migrações,
`lib/`, `docs/`), não só sobre a descrição do produto.

### 2.1 O que já é diferencial real

| Ativo | Onde está | Por que importa |
| --- | --- | --- |
| Catálogo de eventos de domínio versionado, com payload sanitizado | `lib/domain-events.ts`, `fdp_domain_events` | É a espinha dorsal de qualquer automação entre áreas. Já existem `employee.admitted`, `termination.requested`, `role.change_requested`, `salary.change_requested`, `epi.delivery_requested` — **os gatilhos das jornadas já estão modelados** |
| Processo versionado com BPMN, instância = demanda, etapa travada por checklist, evidência, responsável e aprovador | `fdp_process_versions`, `lib/process-instances.ts` | Motor de processos com regra de verdade, não kanban com status |
| Central de Trabalho unificada (7 fontes num `UNION ALL`, cursor, escopo no servidor) | `lib/work-items.ts`, `/painel/trabalho` | A base do "o que eu preciso fazer" já existe e escala |
| Agentes que só propõem; motor determinístico; triagem quando há incerteza; kill switch | `lib/agent-proposals.ts`, `/painel/triagem` | Postura correta para DP, onde vínculo inventado vira passivo trabalhista |
| Motor de integração com fila, lease, backoff, dead-letter, idempotência | `fdp_integration_jobs` e correlatas | Infra de iPaaS pronta para conectores novos |
| Auditoria append-only com antes/depois, RLS forçado, FKs compostas por tenant | `fdp_audit_events`, migrações 0063 | Poucos concorrentes nessa faixa conseguem provar isso |
| API pública, webhooks de saída assinados, outbox transacional | `/api/v1`, `fdp_webhook_*` | Pronto para marketplace e integração de parceiros |
| EPI com estoque por local, razão append-only, destino decidido pela condição, desconto nunca automático | `docs/controle-de-epi.md` | Módulo acima da média de mercado |
| Portal externo com link assinado para PJ enviar nota | `lib/contractor-invoice-portal.ts` | Padrão reaproveitável para gestor, colaborador, clínica e fornecedor |

### 2.2 O que está fraco ou ausente

| Lacuna | Evidência | Consequência |
| --- | --- | --- |
| **Não existe "Jornada"** (evento de pessoa → trabalho coordenado em várias áreas) | Eventos existem, mas as regras de automação (`lib/automation-rules.ts`) escutam só eventos de cartão/processo: `card.created`, `card.moved`, `process.step_advanced`… Nenhuma regra escuta `employee.admitted` | Admissão, desligamento e transferência continuam dependendo de alguém lembrar de avisar TI, SESMT, gestor e benefícios |
| **Não existe motor de prazos genérico** | Há SLA de demanda, obrigações de competência e aviso de CA vencendo no EPI — cada um no seu canto | Vencimentos de ASO, experiência, férias, contrato PJ, treinamento e documento continuam em planilha |
| **SESMT quase vazio** | Só `fdp_work_accidents`; busca por ASO, exame, treinamento e PCMSO não encontra nada no domínio | Justamente a área com maior risco de multa ficou de fora |
| **Canal de saída fraco** | `fdp_notifications` é interna; `lib/email.ts` só envia confirmação; `whatsapp` está em `integrationChannels` sem implementação | Quem não abre o sistema não é alcançado; o WhatsApp continua sendo o canal real |
| **Não há portal de gestor nem de colaborador** | O único portal externo é o de nota fiscal PJ | Toda solicitação entra pelo analista (ou pelo Teams via Power Automate) |
| **Documentos são anexos, não objetos** | Anexos de demanda e EPI; ficha de admissão em PDF; nenhum modelo com variáveis, validade, versão ou assinatura | Não há como responder "quais documentos obrigatórios estão faltando ou vencidos para esta pessoa?" |
| **Navegação com 29 visões** | `lib/panel-routes.ts` lista 29 `panelViews`, 8 delas só de PJ | O produto parece maior e mais difícil do que é |
| **`WorkspaceApp.tsx` com 5.160 linhas** | Cresceu de 2.116 (auditoria de 11/08) para 5.160 | Risco de regressão e custo de cada tela nova sobem |
| **Poucos templates de processo** | `lib/process-templates.ts` tem 3 (entrega de EPI, pagamento PJ, demanda entre áreas) | O motor existe, mas o cliente começa com a tela em branco |

### 2.3 Crítica direta ao posicionamento

A cadeia *áreas → pessoas → processos → demandas → aprovações → documentos →
integrações → movimentações → auditoria* está certa como **modelo de dados**,
mas não serve como **proposta de valor**: ela descreve o produto por dentro.
O comprador (coordenador de DP, gerente de RH, técnico de SESMT, diretor
administrativo) compra uma **garantia**: *"nada vence sem alguém saber; nada
fica parado sem alguém ser cobrado; nada muda de mão sem registro"*. Sugiro que
o posicionamento seja construído sobre isso:

> **Vinculato — o trabalho entre áreas anda sozinho, e nada vence sem aviso.**

---

## 3. Principais problemas empresariais encontrados

Síntese da pesquisa, antes de detalhar por área:

1. **Digitalização baixa e fragmentada.** A maior parte das empresas brasileiras
   tem menos de 40% dos processos de RH digitalizados; admissão, documentos,
   ponto, férias e preparação de folha continuam consumindo tempo nas PMEs
   (pesquisa citada pela Exame em dez/2025, via
   [Terra](https://www.terra.com.br/noticias/hr-tech-cria-sistema-de-dp-para-eliminar-planilhas,a9cbb0c64080c153b06e0242c11b7a96vtldzo99.html)).
   O mercado ainda vende "kits de planilhas de DP" como produto
   ([Convenia](https://blog.convenia.com.br/planilhas-para-recursos-humanos-e-dp/),
   [Práticas de Pessoal](https://praticasdepessoal.com.br/kit-planilhas-para-departamento-pessoal-e-rh/)),
   sinal de que o controle real mora no Excel.
2. **O passivo trabalhista nasce da operação.** As ações trabalhistas cresceram
   31% em 2025, e o ranking do TST é liderado por **adicional de insalubridade**
   (710 mil casos), **verbas rescisórias** (659 mil) e dano moral
   ([Estado de Minas](https://www.em.com.br/trends/2025/12/7315924-direitos-trabalhistas-5-temas-que-estao-sempre-em-alta-na-justica.html),
   [Marília Notícia](https://marilianoticia.com.br/colunistas/acoes-trabalhistas-crescem-31-em-2025-o-que-as-empresas-precisam-ajustar-agora-para-2026/)).
   Insalubridade é uma disputa de **prova de SST e EPI** (ficha de entrega, CA,
   treinamento, PGR/LTCAT); verba rescisória é uma disputa de **prazo e
   conferência** no desligamento. Os dois estão no centro do que o Vinculato
   pode controlar.
3. **SST virou fiscalização automática.** O eSocial cruza dados com INSS,
   Receita e MTE; incoerência entre PGR, LTCAT, PCMSO e os eventos enviados
   virou a principal origem de autuação em SST
   ([SECONCI-RIO](https://seconci.rio/multas-para-o-esocial-sst-em-2025/),
   [Connapa](https://www.connapa.com.br/eventos-sst-no-esocial-em-2026-como-evitar-multas-no-envio-do-s-2240),
   [CL Rodrigues](https://clrodrigues.com.br/blog-prazo-eventos-sst-esocial)).
   Prazos: S-2210 até o 1º dia útil seguinte ao acidente; S-2220 e S-2240 até o
   dia 15 do mês seguinte. Enviar ASO atrasado sem justificativa é, na prática,
   uma autodenúncia ([RS Data](https://www.rsdata.com.br/aso-fora-do-prazo-no-esocial/)).
4. **Desligamento é um furo de segurança.** 83% dos ex-funcionários admitem
   manter algum acesso depois de sair; TI gasta cerca de 5 horas por
   desligamento consultando 3 ou mais fontes; 32% das organizações levam mais
   de 7 dias para revogar tudo
   ([Nudge Security](https://www.nudgesecurity.com/post/employee-offboarding-by-the-numbers),
   [ServiceChanger](https://servicechanger.com/en/blog/orphaned-accounts-offboarding-risk)).
   É um problema de **processo entre áreas**, não de TI.
5. **Busca e comunicação consomem o dia.** 62% das pessoas dizem perder tempo
   demais procurando informação, e o trabalhador médio passa 57% do tempo se
   comunicando (reunião, e-mail, chat) em vez de produzindo
   ([Microsoft Work Trend Index](https://www.microsoft.com/en-us/worklab/work-trend-index/will-ai-fix-work)).
   No DP, "procurar informação" significa perguntar no WhatsApp quem está com o
   documento.
6. **Gestor intermediário afogado em administrativo.** Só 25% do tempo de
   gestores intermediários vai para trabalho estratégico; 18% é administrativo
   (McKinsey, 2023, citado em
   [Exame](https://exame.com/carreira/275-interrupcoes-por-dia-o-que-a-ia-ja-tira-da-agenda-do-gestor-e-o-que-ainda-depende-dele/)).
   O gestor não quer um sistema de RH: quer **não ter que lembrar**.
7. **PJ sob novo risco jurídico.** O STF julga no Tema 1389 os limites da
   pejotização; enquanto isso, controle de jornada, subordinação e ausência de
   autonomia aumentam o risco de vínculo reconhecido
   ([Felsberg](https://www.felsberg.com.br/tema-1389-pejotizacao-retomada-processos-stf/),
   [Managefy](https://managefy.com.br/blog/pejotizacao-stf-tema-1389/)).
   Quem controla PJ com as mesmas rotinas do CLT (ponto, aprovação de férias)
   produz prova contra si mesmo. Esse é um ponto de **cuidado de produto**
   (Parte 5, "o que não fazer").
8. **Nova obrigação psicossocial.** A NR-1 atualizada inclui riscos
   psicossociais (estresse, assédio, burnout) no GRO/PGR, com fiscalização
   desde 26/05/2026 ([TRT4](https://www.trt4.jus.br/portais/trt4/modulos/noticias/50974782),
   [Migalhas](https://www.migalhas.com.br/quentes/448486/nr-1-a-partir-de-maio-empresas-devem-monitorar-riscos-a-saude-mental)).
   As empresas precisam de **plano de ação com evidência**, não de mais um
   questionário.

---

## 4. Dores por departamento

Para cada área: as dores, onde o controle mora hoje e o que o Vinculato deveria
(e não deveria) fazer. As legendas de onde o controle mora são: 📊 planilha,
✉️ e-mail, 💬 WhatsApp/Teams, 🗓️ calendário, 🧠 memória, 📄 papel,
🧩 sistema desconectado.

### 4.1 Departamento Pessoal

| Rotina | Dor real | Onde mora hoje | Resposta do Vinculato |
| --- | --- | --- | --- |
| Admissão | Documento chega picado pelo WhatsApp; exame admissional marcado em cima da hora (ou depois do início); ficha digitada duas vezes (admissão digital → ERP); gestor não sabe o que falta | 💬 📊 🧩 | **Jornada de Admissão** (Parte 2 §7.1). Já existe a cadeia Sólides → demanda → ficha → Sankhya; falta disparar SESMT, TI, EPI, benefícios e gestor a partir do mesmo evento |
| Experiência (45+45) | Vencimento esquecido; prorrogação ou efetivação decidida no último dia; gestor não avaliou | 📊 🧠 🗓️ | **Prazo** com consulta ao gestor 15 dias antes, por link assinado: "efetivar / prorrogar / desligar" |
| Férias | Período concessivo vencendo (pagamento em dobro); programação no Excel; aviso de 30 dias e pagamento 2 dias antes esquecidos | 📊 🗓️ | **Prazo** (concessivo) + template de férias com as datas legais calculadas; solicitação pelo gestor/colaborador |
| Afastamentos | Atestado chega por foto; controle de 15 dias para INSS feito de cabeça; retorno sem ASO de retorno | 💬 📊 🧠 | Jornada de Afastamento com contagem de dias, gatilho de INSS no 16º dia e **bloqueio de retorno sem ASO** (ponte com SESMT) |
| Benefícios (VT, VA/VR, plano de saúde) | Inclusão/exclusão esquecida na admissão, transferência e desligamento; plano de saúde cobrado de desligado | 📊 ✉️ 🧩 | Tarefa gerada pela jornada + conferência mensal "ativos x beneficiários" (o módulo auxiliar de Benefícios já existe) |
| Alterações cadastrais, salariais, transferência, promoção | Pedido informal do gestor; sem aprovação registrada; efeito na folha esquecido; dissídio aplicado errado | 💬 ✉️ | Movimentações já existem com aprovação; faltam **formulário de gestor** e **efeitos em cadeia** (EPI, exames e acessos do novo cargo) |
| Ponto e banco de horas | Inconsistências tratadas no fechamento; banco de horas vencendo sem compensar | 🧩 📊 | Conferência de ponto já existe; faltam **prazo de banco de horas** e **pedido de justificativa ao gestor/colaborador** |
| Empréstimos, adiantamentos, descontos | Parcelas controladas no Excel; desconto indevido de EPI | 📊 | O `payroll-ledger` já cobre; manter como **controle e conferência**, nunca cálculo de folha |
| eSocial / FGTS / INSS / IRRF | Prazos mensais; retificações; divergência entre folha e eventos | 🧩 🗓️ | **Calendário de obrigações** (já existe `fdp_compliance_obligations`) virando fonte do Motor de Prazos. **Não** transmitir eSocial |
| Sindicatos e CCT | Cláusulas (piso, reajuste, data-base, contribuição, adicionais) lidas em PDF por cada analista; data-base esquecida | 📄 🧠 | **Leitor de CCT com IA** gerando prazos e parâmetros propostos (Parte 3 §11) |
| Desligamento | 10 dias para pagar a rescisão; exame demissional; devolução de EPI, crachá e equipamento; acessos ativos; homologação; guia de FGTS | 💬 📊 🧠 | **Jornada de Desligamento** com relógio legal visível para todos e bloqueio de conclusão enquanto houver acesso, EPI ou equipamento em aberto |
| Conferência de folha | Comparação manual de folha atual x anterior; eventos esquecidos | 📊 | **Conferência por variação** (Parte 3 §11, IA de auditoria), sem calcular folha |
| Pendências cadastrais | PIS, dependentes, conta bancária, escolaridade faltando | 📊 🧠 | Painel de completude cadastral por pessoa (Requisitos de documento) |
| Comunicação com gestores e funcionários | O DP vira central telefônica | 💬 ✉️ | Portal do Gestor + notificações externas + respostas prontas |

**Controles tipicamente em planilha no DP** (inventário do que o Vinculato
deve absorver): vencimento de experiência, programação de férias, controle de
atestados, banco de horas, parcelas de empréstimo, admissões em andamento,
desligamentos em andamento, lista de benefícios, lista de documentos pendentes,
calendário de obrigações, controle de dissídio, lista de PJ e vencimento de
contrato, entregas de uniforme e EPI.

### 4.2 Recursos Humanos

| Tema | Dor | Recomendação |
| --- | --- | --- |
| Recrutamento e seleção | Requisição de vaga sem aprovação formal; "quem autorizou essa contratação?" | **Não construir ATS.** Construir a **Requisição de Vaga** (aprovação de headcount + centro de custo + orçamento) e integrar com o ATS; o candidato aprovado dispara a Jornada de Admissão |
| Onboarding / integração | Primeiro dia sem computador, sem acesso, sem EPI, sem crachá, sem mesa | Jornada de Admissão com **checklist "Dia 1 pronto"** e um veredito a D-2 |
| Período de experiência | Avaliação do gestor não acontece | Prazo + formulário curto do gestor (link assinado) |
| Treinamentos | Treinamento obrigatório (NR, integração) misturado com desenvolvimento | Controle de **treinamentos obrigatórios** pela Matriz de Requisitos; o LMS continua fora |
| Avaliação, feedback, PDI, clima | Muitos produtos dedicados (Qulture.Rocks, Feedz etc.) | **Fora do núcleo.** No máximo: prazo de ciclo de avaliação e evidência de conclusão |
| Cargos e salários, organograma | Organograma desatualizado; cargo sem descrição de risco | Organograma derivado de `departments`/`positions`/gestor; **cargo como entidade rica** (CBO, riscos, requisitos, faixa salarial opcional) |
| Movimentações | Promoção sem aprovação; mudança de função sem avaliar risco novo | Movimentação → **reavaliação de requisitos** (EPI, exame de mudança de função, treinamento) |
| Comunicação interna | Comunicado sem confirmação de leitura | **Ciência obrigatória** de política/comunicado, com prova (útil para NR-1 e LGPD) |
| Offboarding | Entrevista de desligamento solta; conhecimento perdido | Jornada de Desligamento com etapa opcional de entrevista e passagem de pendências do desligado |

### 4.3 SESMT / SST

| Tema | Dor | Recomendação |
| --- | --- | --- |
| ASO (admissional, periódico, retorno, mudança de função, demissional) | Vencimento do periódico descoberto na fiscalização; admissional depois do início; demissional esquecido | **Controle de exames** (não emissão): tipo, data, validade, apto/inapto/restrição, clínica. Prazo automático pela periodicidade do PCMSO |
| PCMSO / PGR / LTCAT | Documentos anuais ou bianuais vencendo; inconsistência com cargos cadastrados | Documento com validade + **conferência "cargos sem risco mapeado"** e "cargo novo sem PGR revisado" |
| Riscos por função | Admissão e mudança de função sem saber os riscos | **Riscos no cargo** (e opcionalmente por ambiente/setor), alimentando a Matriz de Requisitos |
| CAT e acidentes | S-2210 com prazo de 1 dia útil; investigação sem plano de ação | Já existe dashboard; faltam **Jornada de Acidente** (prazo da CAT, investigação, plano de ação, afastamento) e **incidentes/quase-acidentes** |
| Treinamentos NR | NR-10, NR-35, NR-33, NR-12 com reciclagem periódica; trabalhador em atividade com treinamento vencido | Treinamento como requisito de cargo e de atividade, com vencimento e **bloqueio de liberação** |
| Inspeções | Checklist em papel; não conformidade sem responsável | Template de inspeção (formulário mobile com foto) → não conformidade vira plano de ação com prazo |
| Planos de ação | Planilha 5W2H que ninguém acompanha | **Plano de ação como processo** com responsável, prazo e evidência — serve para acidente, inspeção, NR-1 psicossocial e auditoria |
| Restrições médicas e retorno | Gestor escala pessoa com restrição; DP não sabe | **Restrição como fato do colaborador**, visível para gestor e DP **sem dado clínico** (só "restrição de atividade X até data Y") |
| Riscos psicossociais (NR-1) | Obrigação nova, sem método | Plano de ação e evidência; o levantamento pode vir de ferramenta externa. **Não** construir instrumento psicométrico |

**Problemas causados pela falta de integração DP ↔ SESMT** (o núcleo da
oportunidade):

- DP admite sem saber que o ASO ainda não saiu, ou que saiu "apto com
  restrição".
- SESMT não é avisado de mudança de função, e o exame de mudança de função
  não acontece (e o S-2240 fica desatualizado).
- Afastado volta ao trabalho sem ASO de retorno porque o DP não avisou o SESMT
  do retorno.
- Desligado sai sem demissional, ou com demissional fora do prazo.
- Entrega de EPI sem cruzamento com a função real (a pessoa mudou de cargo e o
  EPI continua o antigo).
- Acidente registrado pelo SESMT sem que o DP saiba do afastamento e da
  estabilidade acidentária de 12 meses.

### 4.4 EPI

O módulo já cobre cadastro, estoque por local, entrega, troca, devolução,
higienização, descarte e análise de desconto. O que falta está na **integração
com o resto** e no **planejamento**:

| Tema | Situação no Vinculato | Evolução |
| --- | --- | --- |
| EPI obrigatório por cargo | `fdp_epi_requirements` existe (empresa/departamento/cargo → produto, quantidade, dias de troca) | Ligar ao **risco** do cargo (EPI justificado por risco do PGR) e gerar **entrega pendente automática** na admissão/mudança de função |
| CA e validade | Aviso de CA vencido ou vencendo | Consulta periódica ao CAEPI (base pública do MTE) por agente; bloquear entrega com CA vencido; sugerir substituto |
| Lote e validade do produto | Parcial | Validade por lote (luvas, cremes, filtros); FEFO na entrega |
| Troca periódica | `replacement_days` existe | **Prazo** de troca por pessoa, alimentando a Central de Trabalho e a previsão de compra |
| Assinatura | Termo como anexo | Assinatura eletrônica/biométrica no celular do almoxarife (a NR-6 aceita registro eletrônico — [Guia Trabalhista](https://www.guiatrabalhista.com.br/legislacao/nr/nr6.htm), [RS Data](https://www.rsdata.com.br/gestao-de-epi-nr6/)) |
| Estoque mínimo e reposição | Saldo por local | **Previsão de consumo** = pessoas × requisito ÷ dias de troca + admissões previstas → sugestão de compra (vira template de Compras) |
| Custo | Valor no produto | Custo por colaborador, por cargo, por centro de custo, por empresa consumidora |
| Treinamento de uso | Não existe | A NR-6 exige orientar e treinar; o treinamento de uso vira **requisito** ligado ao EPI |
| Guarda de registro | Razão append-only | Política de retenção explícita (recomenda-se 20 anos, [Neobetel](https://www.neobetel.com.br/post/entrega-de-epi-o-registro-em-ficha-%C3%A9-obrigat%C3%B3rio-e-protege-sua-empresa)) e exportação de "dossiê de EPI do colaborador" para defesa trabalhista |

**Automação-chave (cargo + função + risco + EPI obrigatório + estoque + colaborador):**

```
QUANDO colaborador é admitido OU muda de cargo/unidade
  → resolver requisitos (empresa, unidade, departamento, cargo, riscos)
  → para cada EPI exigido e ainda não entregue:
       SE há saldo no local da unidade → criar "Entrega pendente" para o almoxarife da unidade, prazo = data de início − 1 dia
       SENÃO → criar "Reposição necessária" para Compras e alertar SESMT (risco de início sem EPI)
  → para cada EPI em posse que não é mais exigido pelo novo cargo → criar "Devolução sugerida"
QUANDO troca periódica vence em N dias → criar "Troca programada"
QUANDO CA do produto vence → bloquear novas entregas daquele SKU e listar quem está com ele
QUANDO colaborador é desligado → "Devolução obrigatória" como bloqueio da jornada
```

### 4.5 Gestores

| Dor | Tradução em produto |
| --- | --- |
| Não sabe para quem pedir | **Catálogo de solicitações** com linguagem de gestor ("contratar", "desligar", "mudar horário", "pedir EPI") — ele não precisa saber que área executa |
| Não sabe o andamento | Página de acompanhamento com linha do tempo em linguagem simples ("aguardando exame admissional — clínica X, marcado para 12/10") |
| Não sabe os documentos necessários | Formulário que só pede o que o tipo exige e diz por quê |
| Esquece prazos | O sistema lembra por e-mail/Teams/WhatsApp com botão de ação |
| Pede pelo WhatsApp | Recebimento de WhatsApp/Teams → IA de entrada → solicitação estruturada em triagem |
| Manda informação incompleta | Validação na hora + IA que aponta o que falta antes de enviar |
| Não sabe o que está pendente com ele | "Minhas pendências" de gestor: aprovações, avaliações de experiência, justificativas de ponto, escalas |
| Não sabe o que aprovar | Aprovação com **resumo do impacto** (custo, efeito na folha, riscos) e aprovação em um toque |

**Portal do Gestor** — a proposta é que ele **não precise de assento** e quase
não precise de login: link assinado por e-mail/Teams/WhatsApp para a ação
específica, e uma página "Minha equipe" acessível por login simples (magic
link/SSO). Esse é o maior multiplicador de valor por cliente: o DP deixa de
ser a central telefônica.

### 4.6 Colaboradores

O portal do colaborador tradicional (holerite, férias, dados) já é oferecido por
praticamente todo sistema de folha e de ponto (Factorial, Convenia, Sólides,
Senior). **Copiar isso seria entrar numa briga perdida.** A lógica do Vinculato
é outra: **o colaborador é participante de processos**, não usuário de um
portal. O que faz sentido:

- **Caixa de pendências pessoal**: "envie seu comprovante de residência",
  "assine o termo de EPI", "compareça ao exame periódico dia 12", "confirme
  ciência da política X". Cada item chega por link assinado.
- **Acompanhamento** das próprias solicitações (sem precisar perguntar no
  WhatsApp).
- **Meus requisitos**: EPIs em posse, treinamentos válidos e vencendo, exames
  e documentos — o espelho da Matriz de Requisitos.
- **Solicitações simples**: segunda via de documento, atualização cadastral,
  pedido de EPI por dano ou perda, reembolso.
- **Não**: holerite, espelho de ponto e informe de rendimentos devem ser
  **links para o sistema de origem**, não reimplementados.

### 4.7 Financeiro

Onde acompanhar o processo financeiro **melhora a operação** sem virar ERP:

| Processo | Papel do Vinculato | Limite |
| --- | --- | --- |
| Pagamento de PJ | Já existe (cálculo base/créditos/descontos, nota, complemento, Caju) | Não emitir nota; não pagar; exportar |
| Benefícios (fatura do VA/VR/plano) | **Conferência** fatura × ativos × movimentações do mês | Não pagar a fatura |
| Reembolsos | Solicitação + comprovante + aprovação + envio ao financeiro/ERP | Não conciliar banco |
| Adiantamentos e empréstimos | Controle de parcelas (já existe) | Não calcular juros nem tributação |
| Rescisão | Relógio do pagamento em 10 dias com status do financeiro | O pagamento é do ERP/banco |
| Centros de custo | Todo processo carrega centro de custo para rateio e indicadores | Não fazer rateio contábil |
| Contratos e vencimentos | Prazos de contratos de fornecedor ligados a pessoas (clínica, VT, plano) | Não gerir contas a pagar |

### 4.8 Jurídico

| Processo | Dor | Resposta |
| --- | --- | --- |
| Processo trabalhista (subsídios) | Jurídico pede ao DP "tudo do fulano" por e-mail; DP monta pasta manualmente em dias | **Dossiê do colaborador** gerado em um clique: cadastro, movimentações, ponto conferido, EPI (fichas, CA), ASOs, treinamentos, documentos assinados, auditoria. É um diferencial forte, dado o ranking de insalubridade e verbas rescisórias no TST |
| Prazos processuais do DP | Prazo para entregar documento ao advogado | Solicitação do Jurídico ao DP com SLA |
| Procurações, contratos, notificações | Vencimento de procuração; notificação sem resposta | Documento com validade e processo de resposta |
| Contratos PJ | Contrato sem cláusulas revisadas; renovação automática esquecida | Prazo de renovação + checklist de revisão. **Atenção ao Tema 1389**: não controlar PJ como CLT |

### 4.9 TI

Quase tudo que TI sofre vem de evento de pessoa que chega tarde ou não chega:

- **Criação de usuário e equipamento** — pedido chega no dia da admissão.
- **Desligamento de acesso** — ninguém avisa; conta órfã (83% dos
  ex-funcionários mantêm algum acesso, segundo a
  [Nudge Security](https://www.nudgesecurity.com/post/employee-offboarding-by-the-numbers)).
- **Transferência** — acesso antigo continua; acesso novo não chega.
- **Licenças** — pagas para quem saiu.

**Recomendação:** o Vinculato **não** é ITSM nem gestor de identidade. Ele é a
**fonte do evento e o dono do checklist**: gera a tarefa para TI com prazo
(D-3 da admissão, D0 do desligamento), aceita confirmação por webhook ou
integração (Entra ID/Google Workspace via agente) e **não deixa o desligamento
fechar** com acesso pendente. Integração com ITSM (Jira SM, GLPI, ServiceNow)
via webhook de saída já existente.

### 4.10 Compras

Dores: solicitação por e-mail, aprovação informal, cotação sem registro,
sem prazo. **Não construir compras.** O que se liga ao núcleo:

- **Reposição de EPI e uniforme** gerada pela previsão de consumo.
- **Requisição de compra simples** como template (solicitar → aprovar por
  alçada → cotar → pedir no ERP → receber), com a entrada no estoque do EPI
  fechando o ciclo.
- Contratos de fornecedores ligados a pessoas (clínica ocupacional, VT, plano,
  refeição) com vencimento no Motor de Prazos.

### 4.11 Facilities / Administrativo

Dores: veículo e multa (quem estava dirigindo?), chaves, crachás, uniformes,
alojamento, patrimônio, manutenção. **Tudo é "coisa em posse de pessoa" ou
"solicitação administrativa".** A generalização certa:

- **Itens em posse** (o conceito já existe para EPI): crachá, chave, uniforme,
  notebook, celular, cartão corporativo, veículo. Mesmo razão append-only,
  mesma devolução obrigatória no desligamento. **Um módulo, não sete.**
- **Multa de trânsito**: processo com prazo de indicação de condutor (a
  notificação de autuação tem prazo para indicar o condutor) → identificação
  do condutor pela reserva do veículo → ciência do colaborador → análise de
  desconto (mesma regra do EPI: **nunca automática**).
- **Solicitações administrativas** (manutenção, mesa, alojamento) como
  templates do motor de processos.

> Continua na [Parte 2 — Oportunidades, funcionalidades e processos interdepartamentais](02-oportunidades-funcionalidades-e-processos.md).
