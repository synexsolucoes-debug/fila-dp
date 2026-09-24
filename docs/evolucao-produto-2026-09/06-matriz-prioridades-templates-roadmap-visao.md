# Parte 6 — Matriz de impacto, prioridades, templates, roadmap e visão

Seções 21 a 25 do formato pedido, mais as duas seções finais: **As 20 melhores
oportunidades** e **Se eu fosse o Product Manager do Vinculato**.

---

## 21. Matriz de impacto

Complexidade estimada considerando o que **já existe** no repositório (ex.:
Jornada é "média", não "alta", porque eventos, outbox, processos, subprocesso
por `createDemand` e Central de Trabalho já existem).

| Funcionalidade | Problema resolvido | Departamento | Impacto | Complexidade | Prioridade |
| --- | --- | --- | --- | --- | --- |
| Motor de Jornadas (admissão, desligamento, transferência, mudança de função, afastamento, retorno) | Trabalho entre áreas depende de alguém avisar | Todos | Muito alto | Média | P0 |
| Motor de Prazos unificado (fonte da Central) | Vencimentos em planilha e memória | DP, SESMT, EPI, Jurídico | Muito alto | Média | P0 |
| Notificação externa (e-mail + Teams; WhatsApp em seguida) com resumo diário | Quem não abre o sistema não é alcançado | Todos | Muito alto | Baixa/média | P0 |
| Link assinado genérico (aprovar, responder, enviar documento, dar ciência) | Gestor/colaborador fora do sistema | Gestores, colaboradores | Muito alto | Baixa (reaproveita portal PJ) | P0 |
| Matriz de Requisitos por cargo/risco (generalizar `fdp_epi_requirements`) | Não se sabe o que cada pessoa precisa ter | SESMT, EPI, DP, TI | Muito alto | Média | P0 |
| Cargo rico (riscos, CBO, atividades especiais) e Unidade como entidade | Base da matriz e do SST | SESMT, DP | Alto | Baixa | P0 |
| Controle de exames ocupacionais (ASO) | Multas e passivo de SST | SESMT, DP | Muito alto | Média | P0 |
| Central de Trabalho: bloqueados, parados, aguardando terceiros, em risco | "O que pode dar problema?" | Todos | Alto | Baixa/média | P1 |
| Portal do Gestor | DP como central telefônica | Gestores, DP | Muito alto | Média | P1 |
| Treinamentos obrigatórios (validade) | NR vencida em atividade de risco | SESMT | Alto | Média | P1 |
| Restrições médicas funcionais + retorno com ASO | Retorno sem ASO; gestor escala quem não pode | SESMT, gestor | Alto | Baixa | P1 |
| Jornada de Acidente com CAT e plano de ação | Prazo de 1 dia útil; investigação solta | SESMT | Alto | Média | P1 |
| Biblioteca de 30+ templates | Cliente começa em branco | Todos | Muito alto | Média (conteúdo) | P1 |
| Documentos com ciclo de vida + modelos com variáveis | Documentos faltando/vencidos invisíveis | DP, SESMT | Alto | Média | P1 |
| Assinatura eletrônica por integração | Assinatura manual/papel | DP, EPI | Alto | Baixa/média | P1 |
| IA de entrada (texto → proposta) | Pedidos informais e incompletos | DP, gestores | Alto | Média | P1 |
| IA documental generalizada | Conferência manual de documentos | DP | Alto | Média (base existe) | P1 |
| Dossiê do colaborador | Montagem manual de subsídios | Jurídico, DP, SESMT | Alto | Média | P1 |
| Command Center | Diretoria sem visão de saúde | Gestão | Alto | Baixa/média | P1 |
| Itens em posse (generalizar EPI) | Crachá, chave, notebook esquecidos no desligamento | Facilities, TI | Médio/alto | Média | P2 |
| Caixa do Colaborador (pendências pessoais) | Colaborador cobrado por WhatsApp | Colaboradores | Alto | Média | P2 |
| Conferência de folha por variação (IA de auditoria) | Erro de folha descoberto depois | DP | Alto | Alta | P2 |
| Leitor de CCT | Cláusulas lidas à mão; data-base esquecida | DP | Alto | Média/alta | P2 |
| Previsão de consumo e reposição de EPI | Falta de estoque na admissão | EPI, Compras | Médio | Média | P2 |
| Controle de terceiros (documentação de SST de contratadas) | Terceiro entra sem ASO/NR | SESMT, Facilities | Alto (indústria) | Média | P2 |
| Estabilidades com bloqueio de desligamento | Desligamento nulo, reintegração | DP, Jurídico | Alto | Baixa/média | P2 |
| Simulação de versão de processo | Publicar processo quebrado | Admin | Médio | Média | P2 |
| Nova navegação (6 itens) + decomposição do `WorkspaceApp.tsx` | Produto parece complexo; regressões | Todos | Alto | Alta | P1 (começar) / P2 (concluir) |
| SDK de conectores por API | Implantação cara via RPA | Plataforma | Alto | Alta | P2 |
| Mineração de processos (sugerir automações) | Automação depende de alguém pensar nela | Admin | Médio | Alta | P3 |
| Modo parceiro multi-cliente | Distribuição | Canal | Muito alto (comercial) | Alta | P3 |
| Marketplace | Ecossistema | Plataforma | Médio | Alta | P3 |
| App nativo | Biometria/offline pesado | Campo | Médio | Alta | P3 |

---

## 22. Prioridades P0 / P1 / P2 / P3

### P0 — Essencial (resolver agora)

Sem isso, a promessa central ("o trabalho circula sozinho, nada vence sem
aviso") não é verdadeira.

1. **Motor de Jornadas** sobre o catálogo de eventos: admissão e desligamento
   primeiro; depois mudança de função, transferência, afastamento e retorno.
2. **Motor de Prazos** unificado, entrando na Central de Trabalho.
3. **Notificação externa** (e-mail já configurado; Teams; resumo diário).
4. **Link assinado genérico** para ação externa.
5. **Matriz de Requisitos** + **cargo rico** + **unidade**.
6. **Controle de exames ocupacionais** (o requisito mais crítico).

### P1 — Alta prioridade (grande ganho de produtividade)

1. Central de Trabalho com bloqueados, parados, aguardando terceiros e risco.
2. Portal do Gestor.
3. Treinamentos obrigatórios, restrições funcionais, jornada de acidente.
4. Biblioteca de templates (30+).
5. Documentos com ciclo de vida, modelos e assinatura integrada.
6. IA de entrada e IA documental generalizada.
7. Dossiê do colaborador.
8. Command Center.
9. Início da nova navegação (Trabalho · Pessoas · Jornadas · Operações ·
   Documentos · Visão).

### P2 — Evolução (maturidade)

Itens em posse; Caixa do Colaborador; conferência de folha por variação;
leitor de CCT; previsão de EPI; controle de terceiros; estabilidades;
simulação de versão; SDK de conectores; conclusão da decomposição da
interface; WhatsApp oficial; PWA.

### P3 — Futuro (estratégico)

Mineração de processos; modo parceiro multi-cliente; marketplace; app nativo;
previsão de atraso por aprendizado; benchmark anônimo entre clientes
("seu tempo de admissão está no 3º quartil do seu segmento").

---

## 23. Templates de processos

Biblioteca inicial com **36 templates**. Cada um já nasce com etapas, áreas,
prazos, documentos, requisitos e veredito. Os marcados com ★ são jornadas
(multiárea, disparadas por evento).

### Pessoas — ciclo de vida
1. ★ **Admissão CLT** (com "Dia 1 pronto")
2. ★ **Admissão de aprendiz** (contrato com entidade formadora, jornada
   limitada, curso)
3. ★ **Admissão de estagiário** (termo de compromisso, instituição de ensino,
   seguro)
4. ★ **Contratação de PJ** (sem ritos de CLT; alerta de Tema 1389)
5. **Readmissão** (verificar prazo mínimo e histórico)
6. **Avaliação de experiência** (45/90 dias; efetivar, prorrogar, desligar)
7. ★ **Desligamento sem justa causa**
8. ★ **Pedido de demissão**
9. ★ **Desligamento por justa causa** (com Jurídico)
10. **Término de contrato de experiência/determinado**
11. ★ **Transferência entre unidades**
12. ★ **Transferência entre empresas do grupo**
13. ★ **Promoção / mudança de cargo**
14. ★ **Mudança de função com alteração de risco**
15. **Alteração salarial por mérito**
16. **Aplicação de dissídio/reajuste coletivo**
17. **Mudança de jornada/escala**
18. **Alteração cadastral** (endereço, conta, dependentes, estado civil)

### Ausências
19. **Férias** (individual)
20. **Férias coletivas**
21. ★ **Afastamento por doença** (15 dias / INSS)
22. ★ **Licença-maternidade/paternidade** (com estabilidade)
23. ★ **Retorno ao trabalho** (com ASO de retorno)

### SST e EPI
24. **Exame periódico** (convocação em lote por vencimento)
25. **Treinamento obrigatório de NR** (turma, presença, certificado, validade)
26. ★ **Acidente de trabalho** (CAT, investigação, plano de ação)
27. **Registro de incidente/quase-acidente**
28. **Inspeção de segurança** (checklist mobile → não conformidades)
29. **Entrega de EPI** (existe)
30. **Troca de EPI por dano/perda** (com análise de desconto)
31. **Reposição de estoque de EPI**
32. **Plano de ação de riscos psicossociais (NR-1)**

### Administrativo, financeiro e outras áreas
33. **Reembolso de despesa**
34. **Pagamento de prestadores PJ** (existe)
35. **Multa de trânsito** (indicação de condutor e análise de desconto)
36. ★ **Abertura de nova unidade**

Templates adicionais de outras áreas, para quando o motor estiver maduro:
requisição de compra simples, requisição de vaga, solicitação de acesso a
sistema, solicitação de equipamento, subsídios para processo trabalhista,
renovação de contrato de fornecedor, entrada de terceiro na unidade,
solicitação administrativa (manutenção/alojamento).

---

## 24. Roadmap

### Fase 1 — Fundamentos (≈ 8–10 semanas)

- **Funcionalidades:** cargo rico + unidade; Matriz de Requisitos
  (generalizando o EPI); Motor de Prazos como nova fonte de `WorkItem`;
  gatilho por evento de domínio no motor de regras; subprocesso paralelo com
  junção (Jornada); jornadas de **Admissão** e **Desligamento**; notificação
  externa (e-mail + Teams) e resumo diário; link assinado genérico; controle
  de exames ocupacionais; filtros "bloqueados/parados" na Central.
- **Dependências:** catálogo de eventos (existe), outbox (existe), portal PJ
  como base do link (existe), Resend (existe). Nova: decisão de modelo de
  "unidade".
- **Impacto:** o produto passa a cumprir a promessa central; o SESMT vira
  comprador; o DP para de ser o mensageiro.
- **Motivo:** tudo o que vem depois (IA, portais, templates) depende de
  jornadas, requisitos e prazos. Fazer IA antes disso seria colocar
  inteligência em cima de trabalho que ainda não está modelado.

### Fase 2 — Automação (≈ 10–12 semanas)

- **Funcionalidades:** demais jornadas (transferência, mudança de função,
  afastamento, retorno, acidente); Portal do Gestor; treinamentos e
  restrições; documentos com ciclo de vida, modelos e assinatura integrada;
  biblioteca de templates (36); escalonamento; Command Center; início da nova
  navegação; agente de identidade (Entra ID/Google) com confirmação; CAEPI.
- **Dependências:** Fase 1 completa; escolha do provedor de assinatura.
- **Impacto:** redução visível de WhatsApp e e-mail; tempo de admissão e de
  desligamento medido e em queda.
- **Motivo:** com as primitivas prontas, cada template novo custa conteúdo, não
  código.

### Fase 3 — Inteligência (≈ 12 semanas)

- **Funcionalidades:** IA de entrada multicanal (com WhatsApp oficial); IA
  documental generalizada; briefing diário; dossiê do colaborador;
  conferência de folha por variação; leitor de CCT; score de risco
  explicável; Caixa do Colaborador; itens em posse.
- **Dependências:** dados das Fases 1–2 (sem histórico de jornadas não há o que
  prever); política de privacidade para IA por workspace; métricas de
  aceitação de propostas.
- **Impacto:** o analista passa de digitador a conferente; entrada informal
  vira solicitação estruturada.
- **Motivo:** a IA agora tem processo, requisito e prazo onde se encaixar — e
  cada recurso tem métrica de aceitação.

### Fase 4 — Plataforma (contínuo, a partir de ~9 meses)

- **Funcionalidades:** SDK de conectores e catálogo por API; modo parceiro
  multi-cliente; pacotes de segmento (construção, indústria, saúde, varejo,
  logística); mineração de processos; controle de terceiros; marketplace
  quando houver massa crítica; benchmark anônimo entre clientes; PWA → app
  nativo se necessário.
- **Dependências:** base de clientes; API pública (existe) e webhooks (existem)
  estáveis; governança de templates.
- **Impacto:** implantação mais barata, canal de distribuição, efeito de rede.
- **Motivo:** plataforma sem núcleo forte é só uma loja vazia.

**Trabalho técnico paralelo em todas as fases:** decomposição progressiva do
`WorkspaceApp.tsx` (5.160 linhas) junto com cada tela reescrita; fim do
snapshot como resposta de mutação (pendência de 11/08); testes de ensaio de
banco para cada invariante nova (padrão já adotado no repositório).

---

## 25. Visão futura (três anos)

**2029: o Vinculato é a camada de operação de pessoas entre os sistemas que a
empresa já tem.**

- A empresa média brasileira continua com uma folha (Senior, TOTVS, Domínio,
  Sankhya), um ponto (Tangerino, Pontotel, Secullum), um software de SST (SOC
  ou similar), uma admissão digital e dois ou três benefícios. **Nenhum deles
  é substituído.** O Vinculato é o único lugar onde eles se encontram.
- **Todo evento de pessoa vira jornada automaticamente.** Admitir, transferir,
  promover, afastar, desligar: o sistema sabe o que cada área precisa fazer,
  até quando, e cobra quem estiver atrasado — no canal onde a pessoa está.
- **Toda pessoa tem um estado de conformidade** calculado em tempo real
  (exames, treinamentos, EPI, documentos, acessos, itens), e a empresa sabe a
  qualquer momento a sua exposição legal.
- **A IA trabalha como um analista júnior supervisionado:** lê o que chega,
  confere documentos, monta propostas, aponta divergências da folha, prevê
  atrasos e monta dossiês. Nada sensível acontece sem confirmação humana, e
  tudo fica auditado em cadeia verificável.
- **Escritórios contábeis e consultorias de SST operam dezenas de clientes**
  pelo modo parceiro e publicam templates e pacotes de segmento.

**Por que isso diferencia de um ERP:**

| ERP / suíte de RH | Vinculato |
| --- | --- |
| Sistema de **registro** (o que é) | Sistema de **operação** (o que precisa acontecer) |
| Organizado por módulo/departamento | Organizado por evento, pessoa e prazo |
| Quer substituir os outros sistemas | Conecta os sistemas que ficam |
| Processo embutido no código do fornecedor | Processo versionado, configurável por template |
| Usuário = quem tem licença | Participante = qualquer pessoa, por link assinado |
| IA como assistente de tela | IA como etapa do fluxo, com proposta e auditoria |
| Implantação em meses | Implantação em dias com pacote de segmento |

Nome de categoria sugerido: **Employee Operations Platform** no curto prazo
(é mais fácil de explicar a DP/RH/SESMT) e **Business Operations Platform**
apenas quando os templates de outras áreas tiverem tração comprovada. Declarar
"Business Operations" cedo demais convida a comparação com ServiceNow e Pipefy
num terreno em que o Vinculato ainda não tem vantagem.

---

## As 20 melhores oportunidades para o Vinculato

Dificuldade: **baixa / média / alta**, considerando o que já existe.

1. **Jornada de Admissão com "Dia 1 pronto"**
   - *Problema:* primeiro dia sem exame, acesso, EPI ou crachá.
   - *Solução:* caso-pai com tarefas por área e veredito a D−2.
   - *Exemplo:* 12 admissões na segunda; na quinta anterior, o coordenador vê
     4 sem ASO e 2 sem acesso, e as áreas já foram cobradas.
   - *Benefício:* fim do retrabalho de véspera; experiência do admitido.
   - *Departamentos:* RH, DP, SESMT, TI, Almoxarifado, Facilities, gestor.
   - *Dificuldade:* média.

2. **Jornada de Desligamento com relógio legal e bloqueio de conclusão**
   - *Problema:* rescisão fora do prazo; acessos e EPIs esquecidos.
   - *Solução:* prazo de 10 dias visível para todos; conclusão só com zero
     pendência.
   - *Exemplo:* no D+7 sem pagamento confirmado, o Financeiro e o coordenador
     recebem alerta crítico.
   - *Benefício:* evita multa do art. 477, contas órfãs e perda de patrimônio.
   - *Departamentos:* DP, TI, Financeiro, SESMT, Facilities, gestor.
   - *Dificuldade:* média.

3. **Matriz de Requisitos por cargo/risco**
   - *Problema:* ninguém sabe ao certo o que cada função exige.
   - *Solução:* generalizar `fdp_epi_requirements` para exames, treinamentos,
     documentos, acessos e itens.
   - *Exemplo:* Pedro vira Eletricista; o sistema pede exame de mudança de
     função, NR-10 e novos EPIs, e sugere devolver o que não é mais exigido.
   - *Benefício:* conformidade automática; base de tudo que é SST.
   - *Departamentos:* SESMT, DP, EPI, TI.
   - *Dificuldade:* média.

4. **Motor de Prazos único**
   - *Problema:* vencimentos em planilhas separadas.
   - *Solução:* toda validade vira prazo com antecedência, severidade e
     responsável; na janela, vira tarefa.
   - *Exemplo:* segunda-feira, a Central mostra "ASO de 6 pessoas vence em 15
     dias — convocar".
   - *Benefício:* elimina a dependência de memória.
   - *Departamentos:* DP, SESMT, EPI, Jurídico, Financeiro.
   - *Dificuldade:* média.

5. **Controle de exames ocupacionais**
   - *Problema:* ASO vencido, admissional atrasado, demissional esquecido.
   - *Solução:* registro de exame (tipo, data, validade, apto/restrição),
     periodicidade pelo PCMSO, portal da clínica.
   - *Exemplo:* a clínica devolve o ASO pelo link; o requisito fica verde e a
     entrega de EPI é liberada.
   - *Benefício:* reduz exposição a multas do eSocial SST.
   - *Departamentos:* SESMT, DP, clínica.
   - *Dificuldade:* média.

6. **Link assinado genérico + notificação externa**
   - *Problema:* gestor e colaborador fora do sistema.
   - *Solução:* ação específica por e-mail/Teams/WhatsApp com prazo e escopo.
   - *Exemplo:* gestor aprova as férias da equipe no Teams em um toque.
   - *Benefício:* adesão sem custo de assento.
   - *Departamentos:* todos.
   - *Dificuldade:* baixa.

7. **Portal do Gestor**
   - *Problema:* DP como central telefônica; pedidos incompletos.
   - *Solução:* catálogo em linguagem de gestor, acompanhamento, minhas
     pendências, minha equipe.
   - *Exemplo:* gestor abre "Desligar" e o formulário já pergunta o que o
     tipo exige.
   - *Benefício:* menos retrabalho e WhatsApp.
   - *Departamentos:* gestores, DP, RH.
   - *Dificuldade:* média.

8. **Central de Trabalho com risco, bloqueio e parados**
   - *Problema:* a lista não diz o que vai dar problema.
   - *Solução:* seções fixas e score explicável.
   - *Exemplo:* "Em risco: rescisão da Maria — prazo em 2 dias úteis,
     financeiro sem confirmação".
   - *Benefício:* prioriza o que importa.
   - *Departamentos:* todos.
   - *Dificuldade:* baixa/média.

9. **Dossiê do colaborador**
   - *Problema:* subsídios para ação trabalhista montados à mão.
   - *Solução:* exportação assinada com cadastro, movimentações, ponto
     conferido, EPI, ASO, treinamentos, documentos e auditoria.
   - *Exemplo:* ação pedindo insalubridade; o jurídico recebe em minutos as
     fichas de EPI com CA e as assinaturas.
   - *Benefício:* defesa melhor; venda para o jurídico.
   - *Departamentos:* Jurídico, DP, SESMT.
   - *Dificuldade:* média.

10. **Biblioteca de 36 templates**
    - *Problema:* cliente começa em branco.
    - *Solução:* templates prontos e parametrizáveis.
    - *Exemplo:* implantação escolhe "pacote Indústria" e ganha jornadas,
      requisitos e prazos típicos.
    - *Benefício:* tempo até valor em dias.
    - *Departamentos:* todos.
    - *Dificuldade:* média (conteúdo).

11. **Jornada de Afastamento e Retorno com ASO obrigatório**
    - *Problema:* retorno sem ASO; INSS no 16º dia esquecido.
    - *Solução:* contagem de dias e bloqueio de retorno.
    - *Exemplo:* ao lançar o 3º atestado da mesma causa, o sistema avisa que o
      acumulado passou de 15 dias.
    - *Benefício:* conformidade e segurança.
    - *Departamentos:* DP, SESMT, gestor.
    - *Dificuldade:* média.

12. **Jornada de Acidente com CAT e plano de ação**
    - *Problema:* prazo de 1 dia útil; investigação sem acompanhamento.
    - *Solução:* prazo, investigação e plano de ação nascem com o registro.
    - *Exemplo:* registro no celular às 16h; às 8h do dia seguinte, alerta
      crítico se a CAT não foi informada como emitida.
    - *Benefício:* conformidade e prevenção.
    - *Departamentos:* SESMT, DP, gestor, Jurídico.
    - *Dificuldade:* média (dashboard existe).

13. **IA de entrada multicanal**
    - *Problema:* pedidos informais e incompletos.
    - *Solução:* texto livre → proposta → pergunta de volta o que falta.
    - *Exemplo:* "João vai sair de férias dia 15" → "Qual João?" → rascunho de
      férias com as datas legais calculadas.
    - *Benefício:* o WhatsApp deixa de ser um buraco negro.
    - *Departamentos:* DP, gestores.
    - *Dificuldade:* média.

14. **IA documental ligada a requisitos**
    - *Problema:* conferência manual de documentos.
    - *Solução:* classificar, extrair, comparar, fechar pendência.
    - *Exemplo:* colaborador envia foto do certificado NR-35; o treinamento
      fica válido até a data extraída, após conferência.
    - *Benefício:* horas de analista por semana.
    - *Departamentos:* DP, SESMT.
    - *Dificuldade:* média (OCR existe).

15. **Command Center**
    - *Problema:* diretoria sem visão de saúde operacional.
    - *Solução:* veredito, prazos legais, jornadas, conformidade, gargalos.
    - *Exemplo:* diretor recebe na segunda "Atenção: 2 ASOs vencidos na
      unidade Sul".
    - *Benefício:* patrocínio executivo e renovação.
    - *Departamentos:* gestão.
    - *Dificuldade:* baixa/média.

16. **Itens em posse (generalizar o EPI)**
    - *Problema:* crachá, chave, notebook, uniforme, veículo sem controle.
    - *Solução:* mesmo razão e mesma regra de devolução do EPI.
    - *Exemplo:* desligamento lista automaticamente notebook, crachá e chave
      do armário.
    - *Benefício:* patrimônio e segurança.
    - *Departamentos:* Facilities, TI, DP.
    - *Dificuldade:* média.

17. **Conferência de folha por variação**
    - *Problema:* erro de folha descoberto depois do pagamento.
    - *Solução:* comparar competências e fontes e apontar o que não tem
      explicação.
    - *Exemplo:* "salário do José +12% sem movimentação aprovada".
    - *Benefício:* menos erro e retrabalho; argumento forte de venda.
    - *Departamentos:* DP.
    - *Dificuldade:* alta (depende de importar a folha).

18. **Leitor de CCT**
    - *Problema:* cláusulas lidas à mão; data-base esquecida.
    - *Solução:* IA propõe parâmetros e prazos com a página citada.
    - *Exemplo:* ao subir a CCT, surgem 14 propostas: data-base, piso,
      adicional noturno, regra de 12×36.
    - *Benefício:* conformidade e agilidade.
    - *Departamentos:* DP, Jurídico.
    - *Dificuldade:* média/alta.

19. **Controle de terceiros**
    - *Problema:* terceirizado entra na unidade sem ASO/NR/EPI.
    - *Solução:* requisitos por empresa contratada e por atividade, com portal
      do fornecedor.
    - *Exemplo:* empreiteira envia documentos dos 20 trabalhadores; o sistema
      aponta 3 sem NR-35 válida.
    - *Benefício:* reduz responsabilidade solidária/subsidiária.
    - *Departamentos:* SESMT, Facilities, Compras.
    - *Dificuldade:* média.

20. **Modo parceiro multi-cliente**
    - *Problema:* distribuição cara, cliente a cliente.
    - *Solução:* escritório contábil/consultoria de SST opera vários
      workspaces com painel consolidado.
    - *Exemplo:* consultoria de SST acompanha ASO e treinamentos de 40
      clientes numa tela.
    - *Benefício:* canal de vendas e retenção.
    - *Departamentos:* parceiros.
    - *Dificuldade:* alta.

---

## Se eu fosse o Product Manager do Vinculato

### As próximas decisões de produto

1. **Declarar o núcleo:** "operação de pessoas entre sistemas, com profundidade
   em DP + SST + EPI". Escrever isso num documento de princípios, ao lado da
   arquitetura operacional, e usá-lo para **recusar** pedidos.
2. **Congelar novos módulos verticais** até as primitivas existirem. Para cada
   pedido de cliente, fazer a pergunta: *é jornada, requisito, prazo, item em
   posse ou template?* Se for, entra como configuração, não como módulo.
   Pagamentos PJ, Psicologia e Caju ficam como estão, empacotados como
   "pacotes" opcionais, sem expansão até haver um segundo cliente pedindo.
3. **Decidir o modelo de "unidade"** (estabelecimento operacional) antes de
   construir SST e requisitos — mudar isso depois custa migração em tudo.
4. **Decidir a política de RPA:** conector por navegador é serviço de
   implantação com contrato próprio; o roadmap de produto investe em API,
   webhook e importação.
5. **Escolher a métrica-norte:** *% de jornadas concluídas dentro do prazo sem
   intervenção manual de cobrança* (proxy de "o trabalho circula sozinho").
   Métricas de apoio: % de "Dia 1 pronto", prazos legais vencidos (meta zero),
   % de solicitações fora do portal.
6. **Definir o comprador principal:** o coordenador de DP de empresas de 200 a
   2.000 colaboradores com operação física (indústria, construção, logística,
   saúde, varejo) — onde DP + SST + EPI doem juntos. Empresas de escritório
   puro valorizam menos o núcleo.

### O que desenvolver antes de qualquer expansão (na ordem)

1. **Gatilho por evento de domínio no motor de regras** e **subprocesso
   paralelo com junção** — a infraestrutura de Jornada (poucas semanas, porque
   eventos, outbox e `createDemand` existem).
2. **Jornadas de Admissão e Desligamento**, ponta a ponta, com o primeiro
   cliente. Nada de seis jornadas de uma vez: duas, bem feitas e medidas.
3. **Motor de Prazos** como nova fonte da Central de Trabalho.
4. **Notificação externa + link assinado genérico.**
5. **Cargo rico + unidade + Matriz de Requisitos**, começando pelo que já
   existe (EPI) e acrescentando **exames**.
6. **Medir por 4–6 semanas** (tempo de admissão, Dia 1 pronto, desligamentos no
   prazo, WhatsApp vs. portal) antes de abrir a Fase 2.

### O que eu não faria nos próximos seis meses

- Marketplace, app nativo, editor BPMN para o cliente final, novos conectores
  por navegador sem contrato de implantação, módulos de Compras/Facilities/
  Jurídico/TI, chatbot genérico, qualquer cálculo de folha.

### Riscos que eu vigiaria

- **Dispersão:** o histórico recente do repositório (dezenas de PRs sobre
  Tangerino/Sólides/Sankhya/PJ) mostra muita energia em integração específica
  de um cliente. É normal no começo; vira risco se continuar.
- **Complexidade de interface:** cada primitiva nova precisa **reduzir** telas,
  não adicionar. A nova navegação deveria nascer junto com as Jornadas.
- **Privacidade em SST:** exames e afastamentos trazem dado sensível; manter a
  regra "apto/inapto/restrição funcional, nunca diagnóstico", já praticada em
  Psicologia.
- **Promessa de IA:** lançar cada recurso de IA com métrica de aceitação desde
  o primeiro dia.

---

## Fontes consultadas

Pesquisa feita em setembro de 2026. Além do próprio repositório (`db/schema.ts`,
`lib/`, `docs/arquitetura-operacional.md`, `docs/controle-de-epi.md`,
`docs/auditoria-estrategica-saas-2026-08.md`,
`docs/vinculato-diagnostico-e-execucao.md`):

- Digitalização do RH no Brasil: [Terra/Exame](https://www.terra.com.br/noticias/hr-tech-cria-sistema-de-dp-para-eliminar-planilhas,a9cbb0c64080c153b06e0242c11b7a96vtldzo99.html); planilhas de DP: [Convenia](https://blog.convenia.com.br/planilhas-para-recursos-humanos-e-dp/), [Práticas de Pessoal](https://praticasdepessoal.com.br/kit-planilhas-para-departamento-pessoal-e-rh/), [Group Software](https://www.groupsoftware.com.br/blog/rotinas-de-departamento-pessoal/)
- Ações trabalhistas: [Estado de Minas](https://www.em.com.br/trends/2025/12/7315924-direitos-trabalhistas-5-temas-que-estao-sempre-em-alta-na-justica.html), [Marília Notícia](https://marilianoticia.com.br/colunistas/acoes-trabalhistas-crescem-31-em-2025-o-que-as-empresas-precisam-ajustar-agora-para-2026/), [Debate Jurídico](https://debatejuridico.com.br/confira-o-ranking-de-20-assuntos-mais-recorrentes-na-justica-do-trabalho/)
- eSocial SST e multas: [RS Data](https://www.rsdata.com.br/aso-fora-do-prazo-no-esocial/), [SECONCI-RIO](https://seconci.rio/multas-para-o-esocial-sst-em-2025/), [Connapa](https://www.connapa.com.br/eventos-sst-no-esocial-em-2026-como-evitar-multas-no-envio-do-s-2240), [CL Rodrigues](https://clrodrigues.com.br/blog-prazo-eventos-sst-esocial), [Ocupacional](https://ocupacional.com.br/site/multas-no-esocial-2025-o-que-muda-e-como-evitar/)
- NR-6 e EPI: [Guia Trabalhista](https://www.guiatrabalhista.com.br/legislacao/nr/nr6.htm), [MTE — NR-6](https://www.gov.br/trabalho-e-emprego/pt-br/acesso-a-informacao/participacao-social/conselhos-e-orgaos-colegiados/comissao-tripartite-partitaria-permanente/arquivos/normas-regulamentadoras/nr-06-atualizada-2022-1.pdf), [RS Data](https://www.rsdata.com.br/gestao-de-epi-nr6/), [Neobetel](https://www.neobetel.com.br/post/entrega-de-epi-o-registro-em-ficha-%C3%A9-obrigat%C3%B3rio-e-protege-sua-empresa)
- NR-1 psicossocial: [TRT4](https://www.trt4.jus.br/portais/trt4/modulos/noticias/50974782), [Migalhas](https://www.migalhas.com.br/quentes/448486/nr-1-a-partir-de-maio-empresas-devem-monitorar-riscos-a-saude-mental), [Convenia](https://blog.convenia.com.br/nr-1/)
- Pejotização (Tema 1389): [Felsberg](https://www.felsberg.com.br/tema-1389-pejotizacao-retomada-processos-stf/), [Managefy](https://managefy.com.br/blog/pejotizacao-stf-tema-1389/), [STF](https://portal.stf.jus.br/jurisprudenciaRepercussao/verAndamentoProcesso.asp?incidente=7138684&numeroProcesso=1532603&classeProcesso=ARE&numeroTema=1389)
- Offboarding e acessos: [Nudge Security](https://www.nudgesecurity.com/post/employee-offboarding-by-the-numbers), [ServiceChanger](https://servicechanger.com/en/blog/orphaned-accounts-offboarding-risk), [Beyond Identity](https://www.beyondidentity.com/resource/cybersecurity-risks-of-improper-offboarding-after-layoffs)
- Produtividade e comunicação: [Microsoft Work Trend Index](https://www.microsoft.com/en-us/worklab/work-trend-index/will-ai-fix-work), [Exame — gestores](https://exame.com/carreira/275-interrupcoes-por-dia-o-que-a-ia-ja-tira-da-agenda-do-gestor-e-o-que-ainda-depende-dele/)
- IA em RH: [Gartner (88%)](https://www.gartner.com/en/newsroom/press-releases/2025-10-28-gartner-survey-shows-88-percent-of-hr-leaders-say-their-organizations-have-not-realized-significant-business-value-from-ai-tools), [HR Executive](https://hrexecutive.com/agentic-ai-in-hr-unpacking-the-hype-and-addressing-the-uncertainty/), [Applexus — Joule](https://www.applexus.com/blogs/sap-successfactors-agentic-ai), [Darwinbox](https://darwinbox.com/blog/10-best-ai-agent-platforms-hr-teams), [Gloat](https://gloat.com/academy/vendor-landscape-joule-sana-copilot/)
- Benchmark: [ServiceNow HRSD](https://www.servicenow.com/community/hrsd-blog/hr-lifecycle-events-101-what-are-they-and-how-do-you-configure/ba-p/2279110), [Rippling](https://www.rippling.com/blog/introducing-rippling-platform), [Pipefy](https://www.pipefy.com/pt-br/press-release/nova-solucao-da-pipefy-para-rh-junta-ia-e-automacao-para-melhorar-experiencia-de-colaboradores/), [Jira Service Management](https://www.atlassian.com/software/jira/service-management/product-guide/tips-and-tricks/hr-service-management), [monday.com](https://monday.com/blog/service/employee-onboarding-automation/), [ClickUp](https://clickup.com/templates/employee-onboarding-t-48349788), [Deel](https://www.deel.com/resources/strategic-it-onboarding-offboarding-guide/), [BambooHR](https://www.bamboohr.com/platform/onboarding/), [Factorial](https://factorialhr.com.br/funcionalidades-do-software-factorial), [SOC](https://www.soc.com.br/gestao-de-sst/), [Metra](https://www.sistemametra.com.br/blog/melhores-softwares-de-sst/), [Leena AI](https://leena.ai/), [Moveworks](https://www.moveworks.com/), [Ken Research](https://www.kenresearch.com/brazil-cloud-based-hrtech-and-payroll-market)

Observação: estatísticas de terceiros foram reproduzidas como publicadas nas
fontes e não foram verificadas de forma independente. Prazos legais citados
(CLT, NR-7, eSocial) devem ser confirmados pelo jurídico/SESMT de cada cliente
antes de virar regra configurada no produto.
