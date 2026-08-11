# Rotação de credenciais

Procedimento para trocar um segredo do Vinculato em produção sem derrubar a
operação — e, mais importante, sem destruir dado que depende dele.

Nem todo segredo se rotaciona do mesmo jeito. Três se comportam de formas
diferentes, e um deles apaga dado se for trocado sem cuidado. A tabela abaixo é
a parte que vale ler antes de mexer em qualquer coisa.

## O que acontece ao trocar cada segredo

| Segredo | Efeito da troca | Pode rotacionar sozinho? |
| --- | --- | --- |
| `DATABASE_URL` (senha do banco) | Nada é perdido. A aplicação para de conectar até o redeploy. | Sim |
| `FDP_INTEGRATION_VAULT_KEY` | Nada é perdido **se** usar versionamento (abaixo). | Sim, com versionamento |
| `FDP_AUTH_SECRET` | Derruba todas as sessões, invalida links de recuperação e chaves da API pública. | Sim, com aviso aos usuários |
| `FDP_PII_HASH_SECRET` | **Invalida todos os `cpf_hash` já gravados.** | Não — veja o aviso |
| `FDP_API_KEY_SECRET` | Invalida as chaves da API pública já emitidas. | Sim, reemitindo as chaves |

### O aviso do `FDP_PII_HASH_SECRET`

O CPF nunca é gravado em claro: o que fica no banco é um HMAC
(`lib/registrations.ts`, `protectCpf`) mais os quatro últimos dígitos. Isso é
proposital — mas significa que o hash **não pode ser recalculado**, porque o
CPF original não existe mais em lugar nenhum para ser re-hasheado.

Trocar esse segredo transforma todo `cpf_hash` existente em lixo: a busca por
CPF para de encontrar pessoas e a detecção de duplicidade para de funcionar,
silenciosamente. Não há migração que conserte, porque o dado de entrada não
está guardado.

**Só troque esse segredo se ele vazou**, e sabendo que a recuperação exige
recadastrar o CPF de cada pessoa pela interface.

### A armadilha do `FDP_AUTH_SECRET`

Dois outros segredos caem nele quando não estão definidos:

- `FDP_PII_HASH_SECRET ?? FDP_AUTH_SECRET` (`lib/registrations.ts:51`)
- `FDP_API_KEY_SECRET ?? FDP_AUTH_SECRET` (`lib/api-v1.ts:36`)

Ou seja: se o deployment **não** tiver `FDP_PII_HASH_SECRET` próprio, rotacionar
o `FDP_AUTH_SECRET` cai no caso anterior e destrói os `cpf_hash` junto.

Antes de tocar no `FDP_AUTH_SECRET`, confirme na Vercel que
`FDP_PII_HASH_SECRET` existe como variável separada. Se não existir, defina-a
**com o valor atual do `FDP_AUTH_SECRET`** primeiro, publique, e só então
rotacione o `FDP_AUTH_SECRET`. Assim os hashes continuam válidos.

---

## Rotacionar a senha do banco (Neon)

O caso mais comum, e o único que não perde nada.

### 1. Guarde um ponto de restauração

Console do Neon → projeto → **Branches** → *Create branch* a partir de `main`,
com um nome datado (`pre-rotacao-2026-08-11`).

Leva segundos, não interrompe nada, e é a única coisa que transforma "deu
problema" em "voltei em um minuto".

### 2. Troque a senha

Console do Neon → **Roles** → o papel usado pela aplicação → **Reset password**.

O Neon mostra a connection string nova **uma única vez**. Copie as duas
variantes (com e sem `-pooler`) para um gerenciador de senhas — não para um
arquivo de texto, não para uma conversa.

> A partir daqui a aplicação em produção está sem acesso ao banco. Os dois
> passos seguintes consertam. Faça em horário de baixo movimento.

### 3. Atualize a Vercel

*Project → Settings → Environment Variables → `DATABASE_URL`* → cole a string
nova (a **com** `-pooler`: o driver HTTP do Neon é serverless e abre muitas
conexões curtas).

Duas coisas que costumam morder aqui:

- O código lê, nesta ordem, `DATABASE_URL` → `POSTGRES_URL` →
  `NEON_DATABASE_URL` (`db/index.ts`). Se alguma das outras duas estiver
  cadastrada, atualize também — uma variável velha esquecida continua sendo
  usada.
- Se Preview e Development apontarem para o mesmo banco, atualize os três
  ambientes.

### 4. Publique de novo

Variável de ambiente na Vercel **só passa a valer em um deploy novo**. Salvar
não basta.

*Deployments → o último de Production → `···` → Redeploy*, com
*"Use existing Build Cache"* desmarcado.

### 5. Verifique — com comando, não com impressão

```bash
git checkout main && git pull origin main
export DATABASE_URL="postgresql://…string-nova…"   # a direct, sem -pooler
npm run verify:isolation
```

O script começa checando se o papel da conexão respeita RLS e **só continua se
respeitar**: um ensaio conduzido como superusuário ou com `BYPASSRLS` passaria
sem provar isolamento nenhum. Depois ele prova o isolamento entre grupos.

Abra também o painel e carregue uma tela com dados. Se a senha não tiver
pegado, a conexão falha de forma visível — não passa despercebido.

### 6. Feche

No Neon, em **Monitoring**, confira se não há conexão ativa de origem que você
não reconheça.

---

## Rotacionar a chave do cofre de integrações

Esta é a única que já nasceu preparada para rotação, e por isso não perde nada.

O cofre guarda a **versão** da chave junto de cada credencial selada
(`lib/integrations.ts`, `currentVaultKey` / `vaultKeyByVersion`). Segredo antigo
continua sendo aberto com a chave antiga; segredo novo é selado com a nova.

1. Gere a chave nova: `openssl rand -base64 32`.
2. Na Vercel, defina `FDP_INTEGRATION_VAULT_KEYS` com **as duas** chaves:
   ```json
   {"1": "<chave-antiga>", "2": "<chave-nova>"}
   ```
3. Defina `FDP_INTEGRATION_VAULT_KEY_VERSION=2`.
4. Publique.

Não remova a chave `1` enquanto existir credencial selada com ela. Removê-la
cedo demais faz o cofre responder `VAULT_KEY_VERSION_MISSING` na hora de abrir
uma integração — a credencial não some, mas fica inacessível até a chave voltar.

---

## O que a rotação não faz

Trocar um segredo invalida o acesso **daqui para frente**. Ela não desfaz o que
foi feito com a credencial enquanto ela era válida.

Se um segredo esteve exposto, além de rotacionar vale revisar o histórico de
conexões e a trilha de auditoria (`fdp_platform_audit_events` e as trilhas por
grupo) no período em que ele circulou.

## Quando o papel da aplicação é o dono do banco

O Neon cria um papel dono (`neondb_owner`) por padrão, e é comum a aplicação
acabar usando ele. Isso **não** desliga o RLS — as tabelas do produto usam
`FORCE ROW LEVEL SECURITY`, que se aplica inclusive ao dono da tabela — mas dá
à aplicação poder de DDL que ela não precisa: criar, alterar e derrubar tabela.

`npm run verify:isolation` diz em uma linha qual papel está conectando e se ele
tem `SUPERUSER` ou `BYPASSRLS`. Se tiver qualquer um dos dois, o isolamento
multi-tenant não está sendo aplicado e isso é um incidente, não uma melhoria.

Separar o papel da aplicação do papel dono é trabalho à parte, com sua própria
migração de permissões; a rotação de senha acima não depende disso.
