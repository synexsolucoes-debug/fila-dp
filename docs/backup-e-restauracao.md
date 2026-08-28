# Backup e restauração (§85)

Um backup só existe quando a restauração é provada. Este documento diz o que o
produto verifica sozinho, o que depende de configuração no provedor, e como
restaurar quando for preciso.

## O que já é verificado a cada PR

O job `database` da CI roda `npm run db:rehearse-restore`, que faz o ciclo
completo contra PostgreSQL real — não contra simulação:

1. aplica as 72 migrations num banco de origem limpo;
2. semeia dados representativos de **dois** clientes;
3. gera o dump;
4. restaura num banco vazio;
5. compara a contagem de linhas tabela por tabela;
6. confere que políticas de RLS, `FORCE ROW LEVEL SECURITY`, triggers de
   imutabilidade e constraints sobreviveram;
7. confirma que o isolamento multi-tenant continua valendo **no restaurado**;
8. confirma que competência fechada continua imutável no restaurado.

O passo 7 é o que separa este ensaio de um `pg_dump` cerimonial: um backup que
volta sem RLS volta com os dados de todos os clientes visíveis para qualquer um.

### Tempos medidos

Medição real do ensaio em PostgreSQL 16 local, com o volume semeado no teste
(dois clientes, dados de amostra):

| Etapa | Tempo |
|---|---|
| Aplicar as 72 migrations | 11,47 s |
| Gerar o dump | 0,19 s |
| Restaurar em banco vazio | 1,42 s |
| Conferir contagens, RLS, triggers e isolamento | < 0,2 s |

**Estes números não são promessa de RTO.** Eles medem o volume do ensaio, não o
banco de produção; servem para provar que o procedimento funciona e que o custo
fixo dele é baixo. O RTO real cresce com o volume de dados e precisa ser medido
sobre uma restauração de produção antes de virar compromisso com cliente.

## O que este repositório **não** consegue verificar sozinho

A janela de recuperação (*history retention* / PITR) é configuração do projeto
no Neon, fora do código. É a diferença entre "sabemos voltar" e "temos de onde
voltar" — e é a lacuna que fazia esta seção ficar em aberto.

`npm run verify:backup` fecha a lacuna quando há credencial:

```
NEON_API_KEY=... NEON_PROJECT_ID=... npm run verify:backup
```

Ele lê a janela configurada e **reprova** se for menor que o mínimo acordado
(7 dias por padrão, ajustável em `FDP_BACKUP_MINIMO_DIAS`). Sem credencial, ele
sai com erro dizendo que não verificou, em vez de passar em silêncio — um
verificador que aprova sem olhar é pior que verificador nenhum, porque a equipe
vê CI verde e conclui que está coberta.

Para rodar em ambiente sem credencial (fork, contribuição externa), use
`--permitir-sem-credencial`: ele imprime alto que não conferiu e sai com zero.

### O que precisa estar configurado no Neon

| Item | Valor mínimo | Onde |
|---|---|---|
| History retention (PITR) | 7 dias | Project → Settings → History retention |
| Branch de produção protegida | ativa | Project → Branches |

## Restaurar: o passo a passo

1. **Pare de escrever.** Coloque a aplicação em manutenção antes de restaurar;
   restaurar sob escrita produz um estado que ninguém sabe descrever depois.
2. **Escolha o instante**, não o backup. O Neon restaura por ponto no tempo:
   determine o timestamp imediatamente anterior ao incidente.
3. **Restaure em uma branch nova**, nunca por cima da produção. Uma restauração
   direta destrói a evidência do incidente junto com o dano.
4. **Confira antes de apontar a aplicação**, na branch restaurada:
   - `npm run db:status` — as migrations estão todas aplicadas?
   - `DATABASE_URL=<branch restaurada> npm run verify:isolation` — a RLS
     sobreviveu? Um workspace ainda não alcança o outro?
   - `DATABASE_URL=<branch restaurada> npm run verify:sql` — cada consulta do
     produto ainda prepara contra este schema?
5. **Só então** aponte `DATABASE_URL` para a branch restaurada.
6. **Registre a janela perdida.** O que foi escrito entre o ponto restaurado e o
   incidente não voltou: essa lista é a primeira coisa que o DP precisa para
   refazer o trabalho, e ela não se reconstrói depois.

O passo 4 não é zelo excessivo: os três comandos existem, rodam em segundos, e
cada um deles já pegou defeito real neste repositório.

## Por que não há backup próprio além do provedor

Manter um pipeline de dump paralelo significaria uma cópia dos dados de folha de
todos os clientes fora do perímetro do Neon, com chave, rotação e auditoria
próprias — mais superfície de vazamento do que garantia de continuidade. A
decisão é usar o PITR do provedor e **provar a restauração**, que é a parte que
costuma faltar.

Se um cliente exigir cópia sob custódia própria, isso é decisão contratual e
muda o desenho: entra como requisito, não como script solto.
