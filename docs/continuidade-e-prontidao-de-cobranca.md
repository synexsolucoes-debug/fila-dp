# Continuidade (backup e restauração) e prontidão de cobrança

Data: 2026-08-09

Este documento fecha os dois itens que impediam declarar o produto pronto para clientes pagantes:
a restauração nunca havia sido ensaiada (§86) e a cobrança nunca havia sido verificada de ponta a
ponta (§73, §103).

## 1. Ensaio de backup e restauração

`npm run db:rehearse-restore` executa o ciclo completo contra PostgreSQL real:

1. cria dois bancos descartáveis;
2. aplica todas as migrations na origem;
3. semeia dados de **dois clientes**, incluindo um fechamento PJ concluído e congelado;
4. gera o dump com `pg_dump --format=custom`;
5. restaura em banco vazio com `pg_restore --exit-on-error`;
6. verifica; e
7. remove os bancos do ensaio.

### O que é verificado

| Verificação | Por quê |
| --- | --- |
| Contagem por tabela idêntica entre origem e destino | Prova que nenhum registro se perdeu |
| Dados de negócio presentes | Um restore vazio também "passa" numa comparação ingênua |
| Políticas de RLS preservadas | Restaurar sem isolamento seria um vazamento silencioso |
| `FORCE ROW LEVEL SECURITY` preservado | Sem `FORCE`, o dono da tabela ignora a política |
| Triggers preservados | A imutabilidade dos fechamentos depende deles |
| Constraints preservadas | As regras do cálculo PJ vivem em CHECKs |
| Isolamento multi-tenant no banco restaurado | A prova que realmente importa |
| Fechamento concluído continua imutável | O congelamento sobreviveu ao ciclo |

Qualquer falha reprova o ensaio com saída diferente de zero.

### Resultado da execução

Executado em PostgreSQL 16, com a semente do ensaio:

```
• preparar bancos de ensaio: 1.16s
• aplicar migrations na origem: 1.35s
• semear dados de dois clientes: 0.10s
• gerar o dump: 0.26s
• restaurar em banco vazio: 1.13s

✓ contagem por tabela idêntica
✓ dados de negócio presentes no restaurado
✓ políticas de RLS preservadas
✓ FORCE ROW LEVEL SECURITY preservado
✓ triggers de imutabilidade preservados
✓ constraints preservadas
✓ isolamento multi-tenant continua válido no restaurado
✓ fechamento concluído segue imutável no restaurado
```

**A verificação não é vazia.** Repetimos o ensaio concedendo `BYPASSRLS` ao papel de aplicação e a
checagem acusou corretamente: `vazamento apos restore: fechamento de outro cliente visivel`. Uma
verificação de isolamento que passa em qualquer cenário não prova nada — esta reprova quando deve.

### Sobre RPO e RTO

Os tempos acima referem-se ao volume semeado no ensaio e **não são promessa de RTO em produção**. O
que o ensaio estabelece é o procedimento e a garantia de integridade; os números de produção
dependem do volume real e da política de retenção do provedor de banco, e devem ser medidos sobre
uma cópia de tamanho representativo antes de virar compromisso contratual.

O que ainda falta para um plano de continuidade completo:

- executar o ensaio sobre uma cópia com volume de produção e registrar os tempos obtidos;
- definir e contratar a janela de retenção e o RPO com o provedor;
- ensaiar a recuperação de anexos do Blob junto com o banco;
- fixar periodicidade do ensaio e responsável.

## 2. Prontidão de cobrança

`GET /api/platform/billing-readiness`, exclusivo da administração da plataforma, responde à
pergunta que separa "código pronto" de "posso vender".

### Bloqueios

| Verificação | Por quê é bloqueio |
| --- | --- |
| `STRIPE_SECRET_KEY` configurada | Sem ela não há checkout |
| `STRIPE_WEBHOOK_SECRET` configurada | Sem ela o webhook não é confiável |
| `FDP_APP_URL` configurada | Checkout e portal precisam retornar ao domínio certo |
| Existe plano ativo no catálogo | Sem plano publicado não há o que vender |
| Planos com preço têm identificador no provedor | Preço sem `price_...` quebra o checkout |
| Webhook já processou evento real | Prova que a integração de cobrança funciona |
| Existe assinatura criada pelo checkout | Prova o fluxo de ponta a ponta |

### Atenções (não bloqueiam)

Falhas recentes de webhook e ausência de fatura paga registrada.

### Regras do diagnóstico

- `ready` só é verdadeiro quando **todos** os bloqueios caem. Não existe "quase pronto".
- Cada bloqueio traz a orientação do que fazer para resolvê-lo.
- Cadastro público aberto com cobrança incompleta é sinalizado explicitamente
  (`signupWithoutBilling`): o cliente entraria sem conseguir pagar.
- Nenhum segredo é devolvido — apenas se está configurado ou não.
- Planos em rascunho não são acusados por falta de preço: eles não são vendidos.

### O que isto não faz

Este diagnóstico **não homologa a cobrança sozinho**. Ele torna a homologação verificável: um
operador configura as chaves e os preços, conclui uma assinatura em modo de teste e então a rota
passa a responder `ready: true` com base em fatos registrados no banco, não em opinião.

## 3. Validação executada

- `npm run lint`, `npm run db:check` (23 migrations), `npm test` (139 testes, 8 novos) e
  `npm run build`: aprovados.
- `npm run db:rehearse-restore` executado contra PostgreSQL 16 real: aprovado nas 8 verificações,
  e comprovadamente reprovando quando o isolamento é removido.

## 4. Pendências que permanecem

- **Homologação da cobrança em produção**: depende de credenciais reais do provedor, que não existem
  neste repositório. A ferramenta está pronta; a execução é operacional.
- **Recuperação de anexos**: o ensaio cobre o banco, não o armazenamento de arquivos.
- **Conector de relógio de ponto**: o módulo de Ponto (§28) foi implementado — ver
  `docs/conferencia-de-ponto.md` —, mas nenhum fornecedor de REP tem integração oficial. As marcações
  entram por API, importação ou digitação.
- **Envio de e-mail**: notificações e avisos de cobrança dependem de provedor de envio ainda ausente.
