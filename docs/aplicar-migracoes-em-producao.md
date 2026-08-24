# Aplicar as migrações pendentes em produção

> **O deploy de produção já aplica sozinho.** O build da Vercel roda as
> migrações pendentes antes de publicar, e **não publica** se alguma falhar —
> a versão nova não vai ao ar apontando para um banco que ela não entende.
>
> Este roteiro continua valendo para as vezes em que você aplica **fora do
> deploy**: para conferir o estado, para adiantar uma migração antes de
> publicar, ou quando o passo automático está desligado.

Procedimento para colocar o banco de produção na mesma versão do aplicativo
publicado. É o passo que faz o painel voltar quando ele responde
`SCHEMA_OUTDATED`.

Leva poucos minutos. Cada migração roda dentro de **uma transação** com trava
exclusiva: ou ela aplica inteira, ou não aplica nada. Não existe estado pela
metade.

---

## O que o deploy faz sozinho

| Onde | O que acontece |
| --- | --- |
| Deploy de **produção** | Aplica as pendentes e só publica se der certo |
| Deploy de **preview** | Não toca no banco |
| `npm run build` local ou na integração | Não toca no banco |

O preview é o caso que mais importa: se a `DATABASE_URL` de preview apontar
para produção, migrar ali aplicaria no banco de verdade uma migração vinda de
um branch qualquer. Por isso só o ambiente de produção migra, e isso é
conferido por teste.

**Para desligar**, sem mexer em código: defina `FDP_MIGRATE_ON_DEPLOY=off` nas
variáveis de ambiente da Vercel. O deploy volta a publicar sem migrar, e o
banco passa a ser sua responsabilidade — pelo roteiro abaixo.

**Se o deploy falhar com `DATABASE_URL não está disponível no build`**, a
variável existe mas não está marcada como disponível em *Build*. Marque em
*Project → Settings → Environment Variables*, ou desligue o passo e aplique à
mão.

O ponto de restauração continua sendo decisão humana: o deploy não cria branch
no Neon. Antes de publicar uma versão com migração que mexe em dado, faça o
Passo 1 abaixo.

---

## Antes de começar

Você vai precisar de:

- **Node 24** (`node -v`). O projeto declara essa versão em `engines`.
- **A connection string do banco de produção.** No painel da Vercel:
  *Project → Settings → Environment Variables → `DATABASE_URL`* (ambiente
  Production). No console do Neon ela também aparece em *Connection Details*.
- **Uma cópia do repositório na versão publicada**: as migrações que serão
  aplicadas são as que estão em `drizzle/postgres/` no seu clone.

```bash
git checkout main
git pull origin main
npm ci
```

---

## Passo 1 — Guarde um ponto de restauração

No Neon isso é instantâneo e não interrompe nada: *Console → seu projeto →
Branches → **Create branch** a partir de `main`*, com um nome do tipo
`pre-migracao-2026-08-10`.

Esse branch é uma foto do banco imediatamente antes da mudança. Se algo sair
errado, você volta apontando a aplicação para ele.

> Não pule este passo. Ele custa segundos e é a única coisa que transforma
> "deu problema" em "voltei em um minuto".

---

## Passo 2 — Veja o que está pendente

**Sem credencial nenhuma**, o próprio sistema responde. Abra
`‹seu-domínio›/api/health`:

```json
{ "status": "degraded", "database": "outdated", "pendingMigrations": 2 }
```

`pendingMigrations` maior que zero é a resposta: há o que aplicar.

**Com a connection string**, dá para ver *quais* são, pelo nome:

```bash
export DATABASE_URL="postgresql://…sua-conexao-neon…"
npm run db:status
```

```
Aplicadas : 55
Última    : 0052_user_module_shortcuts.sql em 20/08/2026, 23:41:02
No clone  : 57
Esperadas : 57 (pelo manifesto desta versão do aplicativo)

PENDENTES (2) — aplique com: npm run db:migrate
  · 0053_contractor_documents.sql
  · 0054_contractor_belongs_to_group.sql
```

Este comando **não altera nada** — pode rodar a qualquer hora, inclusive só
para conferir. Ele também acusa duas situações que o executor só descobriria
no meio do caminho:

- **arquivo alterado depois de aplicado**, que o executor recusa — e recusaria
  com metade da fila já aplicada;
- **migração aplicada que não existe no seu clone**, sinal de que o clone está
  atrás do que foi publicado. Nesse caso, atualize o clone antes de aplicar.

> `npm run db:check` é outra coisa: valida os arquivos do clone e não fala com
> banco nenhum. Serve para conferir o repositório, não o estado de produção.

---

## Passo 3 — Aplique

```bash
npm run db:migrate
```

Cada migração já aplicada é pulada em silêncio; as novas aparecem uma a uma:

```
0022_plan_catalog_pricing.sql: applied
0023_platform_lifecycle.sql: applied
0024_module_catalog.sql: applied
0025_access_module.sql: applied
Migrations PostgreSQL concluídas.
```

Se a saída terminar em `Migrations PostgreSQL concluídas.`, acabou.

---

## Passo 4 — Confirme

```bash
npm run db:status
```

```
Nada pendente: o banco está na versão que o clone descreve.
```

E pelo próprio sistema — que é o que confirma que a aplicação **publicada**
enxerga o banco novo, e não só o seu terminal. Abra `‹seu-domínio›/api/health`
no navegador (logado, se o deployment estiver protegido pela Vercel):

```json
{ "status": "ok", "database": "ok", "pendingMigrations": 0 }
```

Por último, abra no painel a tela que a migração destravou e faça o gesto que
ela permite. É a única conferência que prova o caminho inteiro — schema,
privilégio e aplicação:

| Migração | O que conferir |
| --- | --- |
| `0052_user_module_shortcuts` | Favorite um módulo, saia e volte: o favorito continua lá. |
| `0053_contractor_documents` | Abra **Documentos** na ficha de um prestador. |
| `0054_contractor_belongs_to_group` | Cadastre um PJ **sem preencher a empresa**: precisa salvar. |

---

## Se algo der errado

**`O banco já possui tabelas sem histórico de migration.`**
Acontece quando o banco foi criado antes do controle de versões de schema.
Rode **uma única vez**:

```bash
npm run db:migrate:baseline
```

Ele registra as migrações antigas como já aplicadas — sem executar DDL — e segue
com as pendentes. Depois volte a usar `npm run db:migrate` sempre.

**`/api/health` responde `"database": "no_access"`**
O schema está em dia, mas o papel que a aplicação usa não tem privilégio sobre
os objetos recém-criados. Acontece quando a migração roda com um papel e a
aplicação conecta com outro. Conceda:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO <papel_da_aplicacao>;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO <papel_da_aplicacao>;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO <papel_da_aplicacao>;
```

A última linha evita que o problema se repita na próxima migração.

**`/api/health` responde `"database": "unreachable"`**
A `DATABASE_URL` do deployment não está alcançando o banco. Confira a variável
no ambiente *Production* da Vercel — e lembre que alterar variável de ambiente
exige **redeploy** para valer.

**A migração falhou no meio**
Não existe meio: a transação faz rollback sozinha e o banco continua no estado
anterior. Leia a mensagem de erro, corrija a causa e rode `npm run db:migrate`
de novo.

---

## Segurança

- Não coloque a connection string em arquivo versionado. Use `export` na sessão
  do terminal e feche o terminal depois.
- Se a chave for exposta em algum momento, gire a senha do papel no Neon e
  atualize a variável na Vercel.
