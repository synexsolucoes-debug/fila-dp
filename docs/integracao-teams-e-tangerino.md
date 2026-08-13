# Integrações do Vinculato — Teams via Power Automate e Sólides via Tangerino

Este documento descreve os **dois transportes escolhidos** para as automações de DP e como
ativá-los em um cliente. Ele parte de uma decisão de produto já tomada:

- **Microsoft Teams → Power Automate** (webhook). Uma mensagem publicada no canal monitorado dispara
  um fluxo do Power Automate que faz `POST` no Vinculato, que interpreta a movimentação e abre a
  demanda.
- **Sólides → Tangerino** (sincronização incremental). A automação de admissões usa o conector
  **Sólides DP (Tangerino)** por polling, porque a API oficial **não expõe webhook** de admissão.

Tudo é **por workspace**: cada grupo tem a própria credencial, o próprio canal, as próprias
automações e o próprio histórico de eventos. Nenhuma credencial ou configuração é compartilhada
entre grupos, e nenhuma consulta de integração escapa do `workspaceId` da sessão.

---

## Parte 1 — Microsoft Teams via Power Automate

### 1.1 Visão geral do caminho

```
Mensagem no canal "Movimentações"
      │
      ▼
Fluxo do Power Automate  (gatilho "When a new channel message is added")
      │  POST com cabeçalho x-fila-dp-secret
      ▼
POST /api/integrations/webhook/teams?workspaceId=<grupo>
      │  1. confere o segredo do workspace (tempo constante)
      │  2. registra o evento (idempotência por messageId)
      │  3. interpreta a mensagem
      ▼
Demanda automática  ·  Sugestão pendente  ·  Ignorada
```

O Vinculato **não** usa um único canal global para todos os clientes. Cada workspace configura o
seu **Team** e o seu **canal**, e só as mensagens daquele canal geram movimentação.

### 1.2 Passo a passo da configuração (por workspace)

1. **Gerar o segredo do webhook.** No Vinculato, em *Configurações → Integrações → Microsoft Teams*,
   acione **Gerar segredo do webhook** (`POST /api/integrations/[id]/webhook-secret`). A resposta traz,
   **uma única vez**:
   - `secret` — o valor em claro (copie agora; não é exibido de novo);
   - `webhookUrl` — o endereço completo já com o `workspaceId` do grupo;
   - `header` — `x-fila-dp-secret`.

   O segredo é aleatório (32 bytes), guardado cifrado no cofre AES-256-GCM do workspace. Gerar de novo
   **revoga o anterior** na mesma transação.

2. **Registrar o canal monitorado.** Ainda em *Configurações → Integrações → Microsoft Teams*, informe o
   **Tenant**, o **Team** e o **canal**. Esses valores são gravados em `config_json` da integração e
   usados para casar a mensagem recebida (`teamId`/`channelId`). Enquanto o canal não é escolhido, o
   grupo aceita as mensagens que chegarem — é o estado de quem acabou de conectar.

3. **Criar o fluxo no Power Automate:**
   - Gatilho: **Microsoft Teams → When a new channel message is added** (selecione o Team e o canal
     que você registrou no passo 2).
   - Ação: **HTTP** (ou *"HTTP with Microsoft Entra ID"* não é necessário — o webhook é autenticado
     pelo segredo, não por OAuth).
     - **Method:** `POST`
     - **URI:** o `webhookUrl` do passo 1.
     - **Headers:**
       - `x-fila-dp-secret`: o `secret` do passo 1.
       - `Content-Type`: `application/json`
     - **Body:** ver o contrato na seção 1.3.

4. **Escolher as automações.** No `config_json`, `automations.salary_change` e `automations.role_change`
   ligam/desligam cada tipo de movimentação. Ausente conta como **ligada**.

### 1.3 Contrato do corpo (Body) do fluxo

Há dois formatos aceitos. **Prefira o contrato limpo** — é o mais previsível.

**Contrato recomendado** (monte no Power Automate usando o conteúdo dinâmico do gatilho):

```json
{
  "teamId":      "@{triggerOutputs()?['body/channelIdentity/teamId']}",
  "teamName":    "Departamento Pessoal",
  "channelId":   "@{triggerOutputs()?['body/channelIdentity/channelId']}",
  "channelName": "Movimentações",
  "messageId":   "@{triggerOutputs()?['body/id']}",
  "messageUrl":  "@{triggerOutputs()?['body/webUrl']}",
  "senderName":  "@{triggerOutputs()?['body/from/user/displayName']}",
  "text":        "@{triggerOutputs()?['body/body/content']}",
  "editedAt":    "@{triggerOutputs()?['body/lastModifiedDateTime']}"
}
```

**Corpo cru do gatilho** — se você simplesmente encaminhar `@{triggerOutputs()?['body']}`, o Vinculato
também entende. Ele reconhece a forma nativa do Graph: canal/time sob `channelIdentity`, remetente sob
`from.user.displayName`, conteúdo HTML sob `body.content`. Isso evita ter que montar o JSON à mão.

Observações:

- O `text` pode vir em **HTML**; o Vinculato limpa a marcação antes de interpretar.
- O `messageId` é a **chave de idempotência**. Reentrega do mesmo `messageId` não gera nova demanda.
- Se a mensagem for **editada**, o `editedAt`/`lastModifiedDateTime` faz o evento ser reconhecido como
  atualização: a sugestão pendente é atualizada, não duplicada.

### 1.4 O que vira demanda, o que vira sugestão

A classificação **não** é por palavra-chave. Uma mensagem só vira demanda automática quando reúne
evidência estruturada — gatilho de movimentação, pessoa, valor de destino e vigência:

| Mensagem | Resultado |
| --- | --- |
| `João da Silva terá alteração salarial para R$ 5.500,00 a partir de 01/09/2026.` | **Demanda** — Alteração Salarial |
| `Maria Souza passará de Assistente Administrativo para Analista Administrativo em 01/09/2026.` | **Demanda** — Alteração de Cargo/Função |
| `João terá alteração salarial a partir de 01/09/2026.` (sem valor) | **Sugestão** pendente de validação |
| `Pessoal, qual o prazo para alteração salarial?` | **Ignorada** |
| `A alteração salarial de Carlos foi cancelada.` | **Ignorada** |

Interrogação, linguagem hipotética (“estamos avaliando”) e negação/cancelamento derrubam a confiança.
Abaixo do limiar, ou faltando dado obrigatório, a movimentação vira **sugestão** — que alguém do DP
confirma, completa ou rejeita em *Integrações → Movimentações pendentes*
(`GET /api/integrations/movements`, `POST /api/integrations/movements/[id]`).

### 1.5 Segurança do webhook

- O `workspaceId` está na URL, mas **não** basta por si só: a requisição só passa se o
  `x-fila-dp-secret` conferir com o segredo **daquele** grupo. Trocar o identificador na URL não abre
  a porta de outro cliente.
- Comparação do segredo em **tempo constante**.
- Workspace inexistente e integração não configurada respondem **401 idênticos**, para não revelar
  quais identificadores existem.
- Nenhuma escrita acontece antes da autenticação.
- Payload acima de 64 KB é recusado.

---

## Parte 2 — Sólides via Tangerino (admissões)

### 2.1 Por que Tangerino, e não webhook

A API oficial da **Sólides Gestão** e a do **Tangerino (Sólides DP)** **não expõem webhook** de
admissão. Por isso a automação usa **sincronização incremental segura**, e não polling da base inteira:

- o recurso oficial do Tangerino filtra por `lastUpdate` (epoch em ms) — devolve quem foi **atualizado**
  desde o último corte;
- a **admissão** é derivada no Vinculato: mantém-se quem tem `admissionDate` a partir do corte e não
  está demitido; desligamento e correção cadastral que chegam na mesma janela **não** viram demanda.

### 2.2 Fluxo

```
Nova admissão registrada no Tangerino
      │
      ▼
Cron do Vinculato (agenda só integrações tangerino conectadas, com mapeamento de admissões ativo)
      │  GET /employee/find-all?lastUpdate=<corte>
      ▼
Deriva as admissões da janela
      │  registra o evento  (idempotência: admission:<externalId>:<admissionDate>)
      ▼
Demanda de Admissão ERP  (no MESMO workspace dono da integração)
```

O cron (`/api/cron/integrations`) só enfileira o conector **`tangerino`** com status `connected` e um
mapeamento de admissões ativo, e nunca acumula fila (não enfileira se já houver execução pendente).

### 2.3 Configuração (por workspace)

1. **Credencial.** Em *Configurações → Integrações → Sólides DP (Tangerino)*, informe o token. Autenticação
   é `Authorization: Basic <token>`. Guardado no cofre AES-256-GCM do workspace.
2. **Endpoint.** Aceito **somente** o recurso oficial: host `employer.tangerino.com.br` (ou
   `api.tangerino.com.br`), HTTPS, caminho `/employee/find-all`. Host de terceiro, caminho inventado,
   HTTP puro ou credencial na URL são recusados.
3. **Mapeamento de admissões.** Publique um mapeamento com `resource_type = 'admissions'` e direção
   `inbound`. É ele que o cron procura para decidir se agenda o polling.
4. **Destino.** Em `config_json`: `boardId` (quadro que recebe as demandas) e, opcionalmente, `companyId`
   (empresa a vincular). A data de corte inicial vai em `admissionsSince`.

### 2.4 Dado da demanda de admissão

A demanda de **Admissão ERP** nasce com o que a origem fornecer: nome, matrícula, cargo, departamento,
lotação, data de admissão, salário contratual, origem = Sólides DP, ID externo, e o **checklist** do
processo. A ficha documental é listada como presente/ausente — **o valor bruto de documento nunca entra
em banco, log ou URL** (o CPF vira HMAC por `protectCpf`).

**Limite conhecido:** o Tangerino **não expõe download de anexo**. Os arquivos dos documentos continuam
sendo obtidos na Sólides — o checklist da demanda lembra disso.

### 2.5 Idempotência

A mesma admissão **não** gera duas demandas, mesmo que o cron rode de novo. A garantia é do banco: o
evento é registrado com a chave `admission:<externalId>:<admissionDate>` e o índice único
`(workspace_id, integration_id, external_event_id)` impede o segundo registro. Readmissão da mesma
pessoa (nova `admissionDate`) é corretamente tratada como admissão nova.

---

## Parte 3 — Central de eventos e observabilidade (comum aos dois)

Todo evento externo — mensagem do Teams, admissão do Tangerino — passa pela tabela
`fdp_integration_events` antes de gerar qualquer coisa. Estados: `received → processing →
processed | ignored | error`, com `reprocessed` para retentativa deliberada.

Consulta em *Integrações → Ver logs* (`GET /api/integrations/events`), sempre escopada ao workspace da
sessão. Cada evento guarda origem, tipo, identificador externo, status, resultado (a demanda criada) e,
em caso de erro, um código e uma mensagem **já sanitizados** — sem token, segredo ou stack trace.

Os logs estruturados registram, quando aplicável, `workspaceId`, `integrationId`, `userId`, `eventId`,
timestamp e resultado — nunca PII.

---

## Parte 4 — Pendências de ativação (dependem do cliente)

Nada abaixo é implementação faltante no Vinculato; são passos de configuração externa:

- **`FDP_INTEGRATION_VAULT_KEY`** precisa estar definida no deployment (chave AES-256 em base64) para
  guardar qualquer segredo. Sem ela, a geração de segredo responde 503 nomeando a variável.
- **Teams/Power Automate:** o registro/consentimento do fluxo no tenant do cliente e a criação do fluxo
  são feitos pelo cliente. O Vinculato aceita e interpreta o payload; **não foi exercitado contra um
  tenant Microsoft real**.
- **Tangerino:** o token é gerado pelo cliente no painel do Tangerino. **Não foi exercitado contra
  credencial real** — a validação cobre formato do endpoint, derivação de admissão e idempotência.
- **Interface:** as rotas existem e estão testadas; os cards da Central de Integrações e a tela de
  validação de sugestões ainda são consumidos por API, não por tela no painel.
