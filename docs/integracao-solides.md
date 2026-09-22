# Integração Sólides — conector de admissões concluídas

Este documento descreve o conector oficial da Sólides no Vinculato: o que ele faz, o que a API
oficial permite, o que ela não permite e como ativar em um cliente.

## 1. O que o conector faz

Quando alguém é admitido na Sólides, o Vinculato abre uma **tarefa de conciliação cadastral** com a
ficha recebida, a lotação, os dados contratuais e o checklist dos documentos que faltam.

A fronteira de produto continua valendo: **a admissão digital é executada integralmente na Sólides**.
O Vinculato recebe quem já foi admitido e concilia com o ERP. Nenhum fluxo concorrente de admissão é
criado — `assertNoAdmissionWorkflow` segue bloqueando processos, templates e SLAs de admissão.

## 2. Recurso oficial consumido

Documentação: <https://gestaoapidocs.solides.com.br/>

| Item | Valor |
| --- | --- |
| Base | `https://app.solides.com/{locale}/api/v1/` (`locale`: `pt-BR`, `es` ou `en`) |
| Recurso | `GET /colaboradores` |
| Autenticação | `Authorization: Token token=<token>` — **não** é `Bearer` |
| Filtro de admissão | `data_admissao` no formato `DD/MM/AAAA` |
| Paginação | `page` e `page_size` (máximo de 150) |
| Escopo | `status=todos` inclui inativos; por padrão o conector não envia o parâmetro |

O token é gerado pelo próprio cliente em <https://app.solides.com>, na seção **Ativar API de
Integração**. Ele é guardado no cofre AES-256-GCM por workspace, como qualquer outra credencial.

`validateSolidesEndpoint` (`lib/solides.ts`) aceita **somente** host oficial, HTTPS e o caminho
`/{locale}/api/v1/colaboradores`. Host de terceiro, caminho inventado, HTTP puro ou credencial na URL
continuam sendo recusados com `SOLIDES_OFFICIAL_RESOURCE_REQUIRED`.

## 3. Limite conhecido: arquivos de documento

A API de Gestão devolve os **dados documentais** do colaborador no bloco `documents` (CPF, RG, órgão
emissor, CTPS, PIS, título de eleitor, reservista, dados bancários). Ela **não expõe endpoint de
download dos arquivos**.

Consequência prática, declarada na tarefa e na tela em vez de disfarçada:

- o conector concilia a ficha e registra quais campos documentais vieram e quais faltam;
- os arquivos (PDF, imagem) continuam sendo obtidos na Sólides, e o checklist da tarefa inclui o
  passo de baixá-los e anexar;
- nenhum valor de documento entra na descrição da tarefa, nos metadados do item de sincronização ou
  na auditoria — apenas os nomes dos campos, mesma regra já aplicada ao CPF por `protectCpf`.

## 4. Configuração no painel

Em **Integrações → Sólides → Configurar**:

| Campo | Efeito |
| --- | --- |
| Recurso oficial da Sólides | Endpoint validado contra a lista oficial |
| Referência da conta | Identificação administrativa, sem efeito na requisição |
| Admitidos a partir de | Vira `data_admissao`; define o corte histórico da carga |
| Colaboradores por página | `page_size`, limitado a 150 |
| Quadro de destino | Onde as tarefas nascem; vazio usa o primeiro quadro com coluna de entrada |
| Empresa | Empresa do cartão; vazio usa a unidade informada pela Sólides |

Depois é preciso guardar a credencial (`token`), publicar um mapeamento com recurso
**Admissões concluídas** (`admissions`, direção de entrada) e executar **Verificar**. Salvar
configuração nunca conecta o conector: só a verificação com autenticação real muda o estado para
`connected`.

## 5. Execução e idempotência

O executor autenticado (`lib/integration-engine.ts`) faz o I/O fora da requisição do navegador,
limitando resposta, redirecionamento e tempo. Por colaborador recebido:

1. o identificador externo sai do campo `id` da Sólides;
2. o hash do item usa o **registro original**, e não apenas os campos mapeados, para que mudanças na
   ficha sejam percebidas mesmo com mapeamento enxuto;
3. um registro sem `id`, nome ou data de admissão vira conciliação pendente em vez de tarefa;
4. se já existe tarefa para aquele identificador externo, a execução marca o item como `skipped` e
   reaproveita o cartão — reprocessar a mesma carga não duplica trabalho.

O prazo do cartão usa a política de SLA de `CONCILIAÇÃO CADASTRAL` (2 dias úteis por padrão) com o
calendário e os feriados do workspace, resolvidos uma vez por execução.

### Quem tira o trabalho da fila

Sincronizar apenas **enfileira**. Quem executa é `GET /api/cron/integrations`, chamado a cada 5
minutos pelo workflow `.github/workflows/integrations-cron.yml`. Antes disso não havia nada chamando
o executor, e o sintoma era "a sincronização não anda", sem erro em lugar nenhum.

O agendamento **não** fica no `vercel.json`: em conta Hobby a Vercel recusa cron que rode mais de uma
vez por dia, e a recusa derruba o deploy inteiro, não apenas o cron. Uma varredura diária deixaria a
admissão aparecer com até 24 h de atraso. Ao migrar para o plano Pro, mova para o `vercel.json` e
desative o workflow, para ter um mecanismo só.

A rota autentica por `Authorization: Bearer`, porque a Vercel Cron só faz GET e não envia cabeçalho
próprio nem corpo. Ela aceita `CRON_SECRET` ou `FDP_INTEGRATION_WORKER_SECRET`, ambos com no mínimo
32 caracteres e comparação em tempo constante. **É preciso definir `CRON_SECRET` no projeto Vercel** —
é o valor que a plataforma envia; pode ser o mesmo do executor.

A varredura lista os workspaces ativos e processa cada um com a conexão presa àquele tenant, com teto
de 25 jobs por workspace e orçamento de 45 s por execução. O endpoint manual
`POST /api/integrations/worker` continua existindo para depuração.

## 6. Gate operacional antes de liberar para o cliente

1. Aplicar a migration `0028_solides_admission_connector` em PostgreSQL de homologação.
2. Confirmar que o workspace tem quadro com coluna de entrada e a política de SLA de
   `CONCILIAÇÃO CADASTRAL` ativa.
3. Guardar o token do cliente e executar **Verificar** contra a conta real — sem isso o conector
   permanece em `needs_credentials`.
3.1. Definir `CRON_SECRET` no projeto Vercel e os segredos `INTEGRATIONS_CRON_URL` e
   `INTEGRATIONS_CRON_SECRET` no repositório, senão a fila enfileira e não anda.
4. Rodar uma sincronização com corte curto (poucos dias) e conferir tarefa, checklist e ausência de
   valor de documento na auditoria.
5. Só então ampliar o corte histórico em **Admitidos a partir de**.

## 7. Sólides DP (Tangerino) — o outro produto

A Sólides tem **dois produtos com APIs distintas**, e o cliente pode usar só um deles. O conector da
Sólides DP vive em `lib/tangerino.ts` e é um canal separado (`tangerino`).

| Item | Gestão | DP (Tangerino) |
| --- | --- | --- |
| Base | `app.solides.com/{locale}/api/v1/` | `employer.tangerino.com.br` |
| Autenticação | `Authorization: Token token=<token>` | `Authorization: Basic <token>` |
| Recurso | `GET /colaboradores` | `GET /employee/find-all` |
| Filtro | `data_admissao` (`DD/MM/AAAA`) | `lastUpdate` (epoch em ms) |
| Paginação | `page` (base 1) / `page_size` | `page` (base 0) / `size` |
| Resposta | array na raiz | envelope `Page` do Spring (`content`) |
| Token | Ativar API de Integração | Empregador → Integrações |

Especificação: <https://employer.tangerino.com.br/v2/api-docs>

### Por que o recorte de admissão é feito aqui

O Tangerino **não tem filtro por data de admissão**. O oficial é `lastUpdate`, que devolve quem foi
ATUALIZADO desde então — na mesma janela chegam desligamento, correção de cadastro e admissão antiga.
O conector recebe a janela e descarta, registrando o motivo no item de sincronização:

- quem está `fired` ou tem `resignationDate` → `desligado`;
- quem tem `admissionDate` anterior ao corte configurado → `admitido antes do corte`.

Sem esse recorte, corrigir o telefone de alguém admitido há dois anos abriria uma conciliação de
admissão. O token é colado de Empregador → Integrações; se vier com o prefixo `Basic`, o conector
aceita mesmo assim, em vez de montar um `Basic Basic ...` que o provedor recusaria sem explicar.

### Documentos: mesma limitação

A API do Tangerino também **não expõe download de documento**. Os únicos arquivos que ela manipula são
foto do colaborador (só upload), imagem de assinatura digital e espelho de ponto via GED. Os campos
documentais disponíveis no DTO são CPF, CTPS, série da CTPS e PIS — e, como no Gestão, só a presença
ou ausência de cada um entra na tarefa.

### Ativação

Migration `0029_tangerino_connector` provisiona o conector. O resto do fluxo é idêntico ao do Gestão:
configurar recurso oficial e corte, guardar o token, publicar mapeamento `admissions` e **Verificar**.

## 8. Fora de escopo nesta entrega

- **Ponto e espelho do Tangerino** (`GET /punch/`, `GET /time-sheet`): o módulo de tempo do Vinculato
  não consome essa API. Só a listagem de colaboradores é usada.
- **Webhooks da Sólides** (`novo_colaborador`, `edicao_colaborador`, `demissao_colaborador`): a
  documentação pública lista os nomes dos eventos, mas não o payload nem o registro do endpoint.
  Enquanto isso não estiver documentado, a carga é por consulta agendada, não por evento.
- **Escrita de volta na Sólides**: o executor processa apenas mapeamentos de entrada ou bidirecionais.
- **Documentos como arquivo**: nenhum dos dois produtos expõe download de anexo na API oficial.

## 9. Ficha de contratação — o Registro de Empregado lido para o ERP

O agente navegador já traz, junto dos documentos, a **ficha cadastral em PDF**
(`worker/tangerino/playwright-session.ts`, botão *Exportar ficha do colaborador*).
Até aqui ela era só mais um anexo: quem fazia a admissão no ERP abria o PDF de um
lado, o ERP do outro, e transcrevia quarenta e poucos campos à mão.

A aba **Ficha** da demanda lê esse PDF e apresenta os campos prontos para copiar.

### 9.1 Por que o módulo não leva o nome da Sólides

O documento é o **Registro de Empregado**, cujo conteúdo mínimo é fixado pela
legislação trabalhista, não pelo fornecedor que o emite. Rótulos, blocos e ordem
são os mesmos saindo da Sólides, do Domínio ou de um registro digitalizado. O
acoplamento com a Sólides fica onde de fato existe — na obtenção do arquivo — e
não na leitura dele (`lib/employee-registration-form.ts`,
`lib/registration-form-pdf.ts`).

### 9.2 Como a leitura se ancora

`extractText` devolve o texto na ordem interna do PDF, que não é a ordem visual
da grade. Em vez de supor a sequência, o extrator procura os **rótulos** — um
conjunto fechado e conhecido —, reserva o trecho de cada um do mais longo para o
mais curto, ordena pela posição real e fatia o valor entre um rótulo e o
seguinte. Mudar a ordem interna do arquivo move os rótulos juntos, e o
fatiamento continua certo.

Quatro campos **não** são lidos, e é deliberado: `Categoria` aparece duas vezes
na mesma ficha (habilitação e documento militar), e `Por` e `Nº` são curtos
demais para distinguir. Eles saem em branco, o que manda buscar na origem —
chutar produziria valor errado com aparência de certo.

### 9.3 A regra que sustenta a ficha

**Campo que não passa na conferência não vira valor copiável.** Dígito
verificador de CPF, PIS/PASEP, CNH, título de eleitor e CNPJ é conferido antes
de qualquer coisa ser oferecida para cópia.

A assimetria é o motivo: campo vazio se denuncia sozinho a quem transcreve, mas
campo preenchido com o número errado é aceito pelo ERP, atravessa a admissão
inteira e só aparece no eSocial. Por isso a tela separa **em branco no registro**
(buscar na origem) de **não foi possível ler** (conferir no arquivo) — pedem
ações opostas.

### 9.4 Inversão declarada da regra de privacidade

Até a §8 deste documento valia: nenhum valor de documento entra em banco. A
ficha inverte isso, porque não há como oferecer "copiar o CPF" sem ter o CPF. O
que existe é o cerco, e ele é parte do desenho:

| Trava | Onde |
| --- | --- |
| Valor cifrado em AES-256-GCM, com AAD próprio | `lib/admission-sheet.ts` |
| Capability separada de `attachments.read` | `admission.sheet.read` |
| Auditoria do **acesso**, nunca do conteúdo | rota da ficha |
| Fora do retrato do workspace, buscada sob demanda | rota própria |
| Apagada ao concluir a demanda | `DELETE /api/cards/[id]` |
| Cai junto do anexo de onde foi lida | FK com `ON DELETE CASCADE` |

O AAD (`fila-dp:admission-sheet:v{versão}`) é o que impede um envelope de
credencial de ser aberto como ficha, e vice-versa, mesmo com a mesma chave.

O observador continua vendo que existe um anexo e deixa de ver o conteúdo dele —
é essa a fronteira que a capability desenha.

### 9.5 Reprocessar sem abrir navegador

A ficha guarda de qual anexo foi lida. Quando a Sólides mudar o layout, ajusta-se
o extrator e usa-se **Reler a ficha** sobre o PDF já guardado: não é preciso nova
sessão de navegador, nem reautenticar, nem que a admissão ainda exista na tela.

### 9.6 O que ainda não está resolvido

- **Campos bancários vêm vazios** na ficha analisada (`Domicílio bancário`,
  `Nº banco`, `Agência código`, `Conta vinculada no banco`). Se o ERP exigir
  banco na admissão, o dado precisa vir de outra origem.
- **Os rótulos não foram confirmados contra uma ficha real da Sólides.** Rótulo
  não encontrado vira aviso nomeando o rótulo, em vez de falhar calado — a
  primeira leitura real mostra o que ajustar.
- **Endpoint JSON da ficha**: a tela é Angular e chama
  `POST /api/v1/ficha-cadastral/report/{id}` para gerar o PDF. Se houver um
  endpoint JSON alimentando a mesma tela, ele substitui o extrator com vantagem
  — campo tipado, sem expressão regular, imune a mudança de layout.

### 9.7 Ensaio de banco

`npm run db:rehearse-admission-sheet` prova contra PostgreSQL real, com papel
**sem** superusuário: isolamento entre grupos, cascata do anexo e da demanda,
uma ficha por demanda, o CHECK de contagem, e o ciclo selar → gravar → reler →
abrir. O script recusa papel que ignore RLS, porque um ensaio que não pode
falhar encerra a dúvida sem respondê-la.


## 10. Preparo automático da ficha e o encaminhamento das filas

### 10.1 O botão que não fazia nada

**Executar agora**, no Agente Tangerino, mandava o trabalho por
`queueIntegrationRun` — a fila genérica de integrações. O worker de navegador
drena outra coisa: `fdp_tangerino_admission_consultations`. O job nascia numa
fila que nenhum runner do Tangerino lê.

O sintoma era o pior possível: a tela respondia "execução enfileirada", nada
acontecia, e não havia erro em lugar nenhum para investigar. O trabalho ficava
esperando a varredura periódica que o botão deveria ter antecipado.

O cron tinha o desvio certo desde sempre; o botão não. Era a mesma regra escrita
em dois lugares, com um deles desatualizado. A regra agora mora em
`sweepTangerinoAdmissions` (`lib/tangerino/sweep.ts`) e os dois caminhos a
chamam.

A resposta também mudou: ela distingue **enfileirado**, **já estava na fila** e
**nenhuma admissão elegível**. As três eram "sucesso" antes, e a terceira fazia
a pessoa esperar por um trabalho que nunca foi criado.

### 10.2 A ficha nasce sozinha quando o PDF chega

A ficha só existia quando alguém abria a aba e clicava em "Ler a ficha". O
agente entrava no Tangerino, baixava o PDF e anexava à demanda — e a transcrição
continuava manual porque ninguém sabia que precisava dar aquele clique.

Agora a conclusão da transferência
(`POST /api/integrations/tangerino/attachments/[id]/complete`) prepara a ficha.
Três estados, porque são três situações que pedem coisas diferentes de quem olha:

| Estado | O que a tela diz |
| --- | --- |
| `pending` | Preparando a ficha — o documento chegou e está sendo lido. |
| `ready` | Campos disponíveis para copiar. |
| `failed` | O motivo, com o PDF à mão para conferência manual. |

O CHECK `fdp_admission_sheets_ready_envelope_check` amarra estado e conteúdo:
**pronta implica envelope cifrado presente**. É o que impede uma ficha vazia de
se apresentar como lida.

### 10.3 O que protege a correção manual

Uma ficha já pronta **não** volta para `pending` porque a transferência rodou de
novo com o mesmo arquivo. Quem conferiu e corrigiu campos não perde esse
trabalho por um reprocessamento que ninguém pediu. O que reabre o preparo é um
anexo **diferente** — documento novo é informação nova.

### 10.4 Falha de leitura não provoca novo download

O PDF já está guardado no Vinculato. Reprocessá-lo não custa navegador, não
exige sessão autenticada e não depende da máquina do operador estar ligada. Por
isso o preparo roda no servidor (cron) e não no worker do Windows — e por isso
uma mudança de layout se resolve ajustando o extrator e relendo o arquivo
existente.

Arquivo que não é PDF, PDF sem camada de texto ou de outro modelo vai direto
para `failed`, sem gastar três tentativas para chegar à mesma conclusão: são
propriedades do arquivo, e não falhas transitórias.

## 11. Origem de cada campo, identidade e conclusão

### 11.1 Três origens, e por que a distinção não é decorativa

| Origem | De onde vem |
| --- | --- |
| `document` | Lido do Registro de Empregado anexado |
| `registry` | Do cadastro do colaborador já aprovado no Vinculato |
| `manual` | Digitado por uma pessoa na própria ficha |

Precedência: **manual > documento > cadastro**. Não é hierarquia de qualidade, é
ordem de decisão — quem corrigiu um campo já olhou o documento e decidiu contra
ele, e reler o PDF não pode desfazer isso sozinho. O valor extraído continua
guardado e aparece ao lado, para que a divergência seja visível em vez de
silenciosa.

Os dois envelopes cifrados ficam na mesma linha: um para o que o documento
disse, outro para o que a pessoa corrigiu. Um envelope só obrigaria a releitura
a escolher entre perder a correção ou ignorar o documento novo, sem terceira
opção.

**Os dados bancários** vêm vazios no Registro de Empregado. `PATCH` na rota da
ficha é a porta explícita para completá-los — sem ela, a ficha entregaria uma
admissão que não fecha no ERP.

### 11.2 Validação matemática não prova titularidade

Um CPF com dígito verificador correto é um CPF válido — de alguém. Antes de
trazer qualquer coisa do cadastro, a ficha compara o que o documento diz com o
colaborador vinculado à demanda. Divergindo, **o preenchimento automático não
acontece** e a divergência vira pendência na tela.

A comparação de CPF usa os quatro últimos dígitos, que é o que o cadastro guarda
(`protectCpf` grava HMAC e os quatro finais). Quatro dígitos não são prova de
identidade, e o código não finge que são: é uma peneira para o caso real —
documento de outra pessoa anexado na demanda errada.

O nome só levanta divergência quando **nenhum sobrenome** coincide. Casamento,
nome social e abreviação mudam o texto sem mudar quem é; um alarme a cada
diferença tocaria em admissão legítima e seria ignorado por hábito.

O cadastro nunca fornece documento pessoal — só cargo, empresa e data de
admissão. RG e PIS do cadastro vieram de uma digitação anterior, e usá-los aqui
transformaria erro antigo em confirmação nova.

### 11.3 A demanda termina quando o DP confirma

Baixar o documento, extrair campos e copiar para a área de transferência não
provam cadastro nenhum — a área de transferência não sabe se o operador colou,
se o ERP aceitou nem se a tela foi salva.

`POST /api/cards/[id]/registration-sheet/confirm` registra a matrícula que o
Sankhya devolveu, o responsável e a data. O banco cobra os três: `confirmed_at`
sem matrícula e sem responsável é recusado por CHECK.

### 11.4 Retenção explícita

A conclusão marca `retention_until` (30 dias por padrão, configurável na
confirmação) e o cron apaga quando vence. A versão anterior apagava no ato —
parecia cuidadoso e era cedo demais: erro de digitação no ERP aparece no dia
seguinte, e a conferência ficava sem o material que a sustentaria.

Arquivar o cartão agenda a mesma janela, mas **não encurta** um prazo já
definido pela confirmação: quem concluiu escolheu o prazo. Nenhuma ficha
existente ganhou data retroativa — o expurgo só alcança linha com prazo marcado.

## 12. Admissão aberta na Sólides vira demanda (descoberta)

Até a versão anterior o agente sabia fazer uma coisa só: pegar um colaborador
que **já existia** no Vinculato e conferir a admissão dele na origem. Isso serve
para conciliar cadastro — e não serve para o trabalho que o DP faz todo dia.

Quem aparece em "Dados contratuais" na Sólides é exatamente quem **ainda não foi
cadastrado no ERP**. Essa pessoa nunca esteve no Sankhya, logo nunca esteve em
`fdp_employees`, logo a varredura não tinha por onde começar e a demanda não
tinha a quem se prender. Em produção o sintoma foi exato: 107 colaboradores
ativos, 5 admissões abertas na origem, e nenhuma demanda.

### O sentido certo

```
lista de admissões na Sólides → registro da admissão aberta → demanda na fila
     (listAdmissions)            (fdp_tangerino_open_admissions)      (cartão)
```

`discoverOpenAdmissions` (em `lib/tangerino/discovery.ts`) lê a lista que a tela
já mostra — sem pesquisar, porque pesquisar exigiria um nome que o Vinculato não
tem —, abre cada cartão para ler situação e etapa, e registra o que viu. Quem
chegou a "Dados contratuais" ganha uma demanda com o checklist do cadastro no
ERP, para alguém assumir, conferir a ficha e concluir.

### O que ela deliberadamente não faz

**Não cria colaborador.** A lista de colaboradores é o espelho do ERP; enchê-la
de gente que ainda não está lá transformaria toda conferência entre os dois
sistemas em divergência falsa. A admissão vive como o que é — processo em aberto
na origem — e `employee_id` só é preenchido quando o cadastro acontece de
verdade e a importação traz a pessoa.

**Não chuta empresa.** A empresa do cartão sai da configuração da integração
(`companyId`) ou da única empresa do grupo. Com duas ou mais e nenhuma escolhida,
o cartão nasce sem empresa e quem assume preenche — CNPJ errado numa admissão é
pior do que campo em branco.

**Não duplica.** Duas proteções, e as duas importam: o índice único sobre o
processo da origem, e o evento de integração com chave derivada do processo e da
data. A varredura pode rodar de hora em hora sem encher a fila com a mesma
pessoa.

**Não abre demanda com identificador instável.** Um `card:0` serve para clicar
naquela leitura e para mais nada; gravá-lo faria a execução seguinte tratar dois
cartões diferentes como a mesma admissão.

### Onde ela roda

No fim do ciclo do worker, e **só quando a fila secou**: o que uma pessoa pediu
tem precedência sobre a varredura automática, e abrir o navegador para listar
enquanto há consulta esperando atrasaria quem está na frente de uma tela. Uma
falha na listagem não derruba a varredura já concluída — exceto o desafio de
autenticação, que precisa chegar ao painel.

## 13. OCR de fotos de documento — sugestão, nunca origem

A ficha (§9-§11) lê o Registro de Empregado, um PDF de layout fixo e texto
selecionável. Boa parte dos anexos que chegam pela Sólides, porém, são **fotos**
de RG, CPF e CTPS — tiradas por celular, às vezes tortas ou mal iluminadas. O
extrator de PDF não serve para isso, e forçar o mesmo caminho produziria erro
silencioso.

### 13.1 Por que é uma quarta coisa, não uma quarta origem

A tabela de origens do campo (§11.1) tem três entradas — `document`, `registry`,
`manual` — e a leitura de foto **não vira uma quarta**. A diferença não é de
nome: as três origens da ficha alimentam `mergeSheetFields` e podem preencher um
campo sozinhas. O resultado do OCR nunca faz isso. Ele fica em
`fdp_admission_sheet_photo_ocr` — tabela própria, um candidato por foto anexada —
e só vira valor de verdade quando uma pessoa o copia para dentro do mesmo
`PATCH /api/cards/[id]/registration-sheet` que já existia para correção manual.
Confirmar uma sugestão **é** preencher à mão; a proveniência gravada é `manual`,
como qualquer outra correção.

A razão é a mesma do §13 introdutório: o layout de uma foto de RG varia por
estado, a foto pode estar torta, e o OCR erra mais nos dígitos que não podem
errar. Colocar o resultado no mesmo pé que a leitura do PDF esconderia essa
diferença de confiabilidade atrás de uma tela igual.

### 13.2 O que é lido, e o que deliberadamente não é

`lib/photo-document-fields.ts` só produz candidato para quatro campos:

| Campo | Como é aceito |
| --- | --- |
| `taxId` (CPF) | Dígito verificador confere, e só há **um** candidato plausível no texto |
| `pisNumber` (PIS/PASEP) | Mesma regra do CPF — dígito verificador e candidato único |
| `birthDate` | Rótulo "Data de Nascimento" encontrado e a data passa na mesma validação da ficha |
| `fullName` | Rótulo "Nome" encontrado — sempre marcado `confidence: "low"`, por ser texto livre |

Número de RG, número e série da CTPS, e qualquer outro rótulo curto ou
ambíguo ficam de fora, pela mesma razão dos rótulos ambíguos do extrator de PDF
(§9.2): sem um jeito de conferir o valor sozinho, chutar produz um dado errado
com aparência de certo — e esse é justamente o tipo de erro que este recurso
existe para reduzir, não para introduzir. Quando o texto tem **mais de um**
candidato plausível a CPF ou PIS (duas pessoas fotografadas, ou dois números na
mesma imagem), nenhum é aceito — a ambiguidade vira nenhuma sugestão, não uma
sugestão arriscada.

### 13.3 Onde a leitura acontece, e o que precisa estar configurado

A engrenagem é a mesma da ficha em PDF (§10): o upload de cada foto enfileira
o OCR (`enqueuePhotoOcr`), a conclusão da transferência tenta ler na hora
(`runPendingPhotoOcrForCard`, para não esperar o próximo ciclo do cron com os
bytes já em mãos), e o que não terminar entra na fila do cron
(`claimPendingPhotoOcr` / `preparePhotoOcr`, `/api/cron/integrations`) — reler
uma foto já guardada não precisa de sessão de navegador nem de o worker do
Windows estar ligado, só da chave do provedor.

O provedor é o **Google Cloud Vision** (`lib/photo-ocr.ts`), REST, sem SDK.
Configura-se com `FDP_OCR_GOOGLE_VISION_API_KEY` (ver `.env.example`). Sem essa
variável, `ocrConfigured()` volta falso e toda tentativa termina em
`OCR_NOT_CONFIGURED` — a foto continua anexada normalmente, só não gera
sugestão. Ativar isto é uma decisão deliberada sobre dado pessoal sensível: a
foto do documento é enviada ao Google para ser lida. É o mesmo tipo de escolha
que levou a Sólides a entrar como conector (§1) — trocar isolamento total por
uma tarefa que, sem automação, alguém teria que fazer o mesmo lendo o mesmo
documento na tela.

### 13.4 O mesmo cerco da ficha, reaplicado

O valor sugerido é documento pessoal, então guarda no mesmo envelope
AES-256-GCM que `fdp_admission_sheets` usa (`lib/admission-sheet.ts`,
reaproveitado sem alteração). A confiança por campo (`"ok"` ou `"low"`) não é
conteúdo — é metadado sobre a qualidade da leitura — e por isso fica em coluna
aberta, como já acontece com os avisos da ficha. RLS forçado, cascata para
`fdp_workspaces` / `fdp_cards` / `fdp_card_attachments`, um resultado por
anexo: reler substitui, nunca acumula.
