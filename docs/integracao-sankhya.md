# Integração Sankhya — espelho de consulta

Desenho da leitura do ERP Sankhya pelo Vinculato. **Ainda não implementado**: este documento existe
para acordar o desenho antes de escrever código, e para registrar o que já foi confirmado na
especificação oficial e o que continua dependendo da instalação do cliente.

## 1. O que esta integração é, e o que ela não é

**É** um espelho de consulta: o Vinculato lê funcionários, folhas, rescisões e férias da Sankhya e
guarda uma cópia própria, para que a operação enxergue no Vinculato o que já existe no ERP sem
precisar abrir dois sistemas.

**Não é**, nesta fase:

- **escrita no Sankhya** — nenhum dado sai do Vinculato para o ERP;
- **escrita no domínio operacional do Vinculato** — o espelho não altera `fdp_employees`,
  `fdp_payroll_cycles` nem `fdp_employee_movements`;
- **conferência** — comparar o que o Vinculato esperava contra o que a Sankhya tem, e abrir
  divergência, é um passo seguinte, deliberadamente fora deste escopo.

A Sankhya continua sendo a fonte da verdade da folha. O Vinculato espelha, e isso mantém de pé a
fronteira que o produto já declara: **não é ERP de folha**.

### Por que espelho, e não gravação no domínio

`fdp_employees`, `fdp_payroll_cycles` e `fdp_employee_movements` têm ciclo próprio — aprovação
atribuída, gates de pré e pós-fechamento, histórico auditável. Um sync do ERP sobrescrevendo essas
tabelas destruiria estado operacional que alguém construiu no Vinculato.

Há uma razão mais forte: quando a conferência entrar, ela precisa dos **dois lados separados** para
comparar. Se o ERP sobrescreve o lado do Vinculato, não sobra o que conferir — some justamente o
valor. Espelho errado se apaga e recarrega; domínio corrompido, não.

## 2. Contrato oficial

Documentação: <https://developer.sankhya.com.br/>

### Autenticação

O fluxo atual é **OAuth 2.0 Client Credentials com `X-Token`**:

| Item | Valor |
| --- | --- |
| Endpoint | `POST /authenticate` |
| Credenciais | `client_id` e `client_secret` do componente de integração (Portal do Desenvolvedor) |
| Cabeçalho extra | `X-Token`, obtido na tela **Configurações Gateway** do Sankhya Om |
| Retorno | JWT, enviado como `Authorization` nas chamadas seguintes |

O fluxo antigo (`POST /login` com appkey + usuário/senha, sessão de 30 min por
`INATSESSTIMEOUT`) está **descontinuado** — a própria Sankhya recomenda migrar e não evolui mais o
`login`. O conector usa apenas o `/authenticate`.

O canal `erp` do Vinculato já aceita `clientId`, `clientSecret` e `xToken` em
`allowedCredentialKeys`, e `lib/integration-security.ts` já permite `*.sankhya.com.br`. O encaixe
existe; o que não existe é código Sankhya — as variáveis `FDP_SANKHYA_*` do `vercel-env.example` não
são lidas por nada hoje.

### Consulta

Um único serviço genérico atende todas as entidades do ERP:

```
POST /gateway/v1/mge/service.sbr?serviceName=CRUDServiceProvider.loadRecords&outputType=json
```

```json
{
  "serviceName": "CRUDServiceProvider.loadRecords",
  "requestBody": {
    "dataSet": {
      "rootEntity": "Funcionario",
      "includePresentationFields": "N",
      "modifiedSince": "2026-08-01T00:00:00",
      "offsetPage": "0",
      "entity": [{ "path": "", "fieldset": { "list": "CODFUNC, NOMEFUNC, DTADM" } }]
    }
  }
}
```

Três campos moldam o conector:

- **`modifiedSince`** — carga incremental de verdade, por data de alteração;
- **`offsetPage`** — paginação, começando em zero;
- **`hasMoreResult`** na resposta — indica que há mais páginas.

## 3. O usuário de consulta: duas travas independentes

A leitura roda com um **usuário Sankhya dedicado, com perfil de acesso somente leitura** nas
entidades de DP. Isso não substitui o cuidado no código — soma-se a ele:

| Trava | O que impede |
| --- | --- |
| No código | O módulo só monta `loadRecords`. `saveRecords` não existe nele. |
| No ERP | O usuário de consulta não tem permissão de escrita. |

Se uma falhar, a outra segura. Um defeito no conector não consegue escrever na folha, e uma permissão
frouxa não vira escrita porque o código não sabe escrever.

Ganho operacional junto: com usuário próprio, tudo que a integração fizer aparece na auditoria do
Sankhya identificado como o Vinculato, separado da atividade das pessoas.

### Sobre o exemplo da Pontotel

A Pontotel **faz parte do Grupo Sankhya** e tem integração nativa: o próprio ERP roda um job a cada
12 h e empurra os cadastros para lá; o retorno das apurações volta por arquivo de exportação (E02).
É privilégio de primeira parte, e não há como um terceiro habilitar o mesmo caminho. O Vinculato
puxa via API — o que se aproveita do modelo dela é a postura do usuário restrito, não o mecanismo.

## 4. Modelo de dados

Tabelas-espelho novas, todas com RLS por workspace como o restante do schema:

| Tabela | Conteúdo |
| --- | --- |
| `fdp_erp_employees` | Funcionários do ERP |
| `fdp_erp_payroll_items` | Itens de folha por competência |
| `fdp_erp_vacations` | Períodos aquisitivos e gozo |
| `fdp_erp_terminations` | Rescisões |
| `fdp_erp_sync_state` | Marca d'água por workspace, conector e entidade |

Regras que valem para todas:

- **Somente escrita pelo conector.** Nenhuma rota de usuário grava nelas.
- **Chave externa preservada.** O identificador da Sankhya fica guardado, para que a conferência
  futura tenha por onde casar os registros.
- **CPF nunca em claro** — passa por `protectCpf` (HMAC + últimos quatro dígitos), como já vale para
  `fdp_employees`.
- **Auditoria sem valores.** O registro de sincronização guarda contagens e nomes de campo, não
  valores de folha.

## 5. O que o motor de integrações ainda não faz

Quatro lacunas reais, em ordem de esforço:

| Lacuna | Hoje | Precisa |
| --- | --- | --- |
| Token em duas etapas | a credencial vira cabeçalho direto | `POST /authenticate` → JWT, com cache curto |
| Corpo da requisição | estático, vindo da configuração | montado por recurso: entidade, fieldset e critério |
| Paginação | uma requisição por execução | laço até `hasMoreResult` ser falso |
| Marca d'água | data de corte fixa na configuração | watermark por entidade, alimentando `modifiedSince` |

E um problema de volume: a carga inicial de folha não cabe no orçamento de 45 s do cron. Precisa de
um modo **backfill**, separado da varredura incremental, que avança por páginas entre execuções
guardando o progresso — em vez de tentar puxar tudo de uma vez e estourar o limite da função.

Canal próprio `sankhya`, não o `erp` genérico: mesmo argumento que valeu para o Tangerino — contrato
próprio merece módulo próprio, e um workspace pode ter os dois.

## 6. Ordem de entrega

1. **Funcionários** — menor volume; valida autenticação, paginação e watermark de uma vez.
2. **Férias**.
3. **Rescisões**.
4. **Folha** — maior volume e maior sensibilidade; entra por último, já com o backfill provado.

Cada etapa é útil sozinha: espelhar funcionários já elimina a consulta em dois sistemas.

## 7. O que depende do cliente

Sem estes quatro itens não há como implementar nem testar contra a conta real:

1. **Usuário dedicado** no Sankhya Om (ex.: `INTEGRACAO_VINCULATO`), com perfil **somente leitura**
   nas entidades de DP.
2. **Componente de integração** criado no Portal do Desenvolvedor, vinculado a esse usuário, para
   obter `client_id` e `client_secret`.
3. **`X-Token`** da tela *Configurações Gateway*.
4. **Sankhya nuvem ou instalação própria?** Se for on-premise, o host muda e
   `lib/integration-security.ts` precisa acompanhar.

## 8. Pendências de descoberta

- **Nomes das entidades.** `Funcionario` (TFPFUN) está confirmado. Para férias, rescisão e folha há
  as tabelas conhecidas — TFPFER (férias), TFPTPR (tipo de rescisão), TFPMTD (motivos de
  desligamento) —, mas **não** os nomes de entidade que o `rootEntity` espera, e isso varia por
  instalação. Precisa ser confirmado na instância do cliente antes de codificar; até lá, nenhum nome
  entra no código como suposição.
- **Campos por entidade.** O `fieldset.list` precisa ser explícito. Pedir tudo é lento e traz dado
  que não queremos espelhar.

## 9. Fora de escopo declarado

- **Escrita no Sankhya.** O conector não implementa `saveRecords`.
- **Conferência automática.** Comparar Vinculato × Sankhya e abrir divergência é passo seguinte.
- **Acesso direto ao banco do ERP.** Um usuário somente-leitura no Oracle/SQL Server consultando
  TFPFUN diretamente seria mais rápido para carga volumosa, mas exige rota de rede até o banco,
  passa por cima das regras de negócio do ERP e quebra em silêncio quando a Sankhya muda o schema
  numa atualização. Fica registrado como alternativa avaliada e recusada.
