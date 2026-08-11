# Assistente do painel

O assistente responde dúvidas de uso do Vinculato dentro do próprio painel:
onde fica uma tela, o que o papel da pessoa permite, qual o caminho para uma
tarefa. Ele **não** é um agente que executa ações e **não** enxerga dado de
pessoa.

## O que ele sabe, e por quê é tão pouco

O contexto enviado ao provedor é deliberadamente pobre:

| Vai | Não vai |
| --- | --- |
| Nome do grupo empresarial | Colaborador, prestador, empresa cliente |
| Nome e papel de quem pergunta | CPF, CNPJ, PIS, conta bancária, chave Pix |
| Tela em que a pessoa está | Qualquer valor em dinheiro |
| Módulos liberados e bloqueados, com o motivo do bloqueio | Folha, fechamento, apuração, movimentação |

Um assistente que enxergasse a folha inteira exigiria uma decisão de LGPD que
não cabe ao produto tomar sozinho. Um que enxerga a estrutura da tela já
responde a maior parte das perguntas de suporte, que é o que reduz chamado.

Seja explícito com o cliente sobre a primeira coluna: **o nome do grupo e o nome
de quem pergunta saem para o provedor**, porque é o que permite a resposta se
dirigir à pessoa e ao papel dela. Nada além disso.

## O limite de privacidade é código, não configuração

`lib/assistant/redaction.ts` remove dado pessoal do texto **antes** de ele
deixar o processo. O módulo não lê variável de ambiente nenhuma e não aceita um
"modo permissivo": um limite que pode ser desligado por variável não é um
limite. Há um teste que lê o próprio arquivo-fonte e falha se alguém
introduzir `process.env` ou uma flag de bypass ali.

A redação acontece em `askAssistant`, no último passo antes do `fetch` — não na
rota, onde seria fácil esquecer numa chamada nova. Também há teste para a ordem.

O que é removido: CPF (com e sem máscara), CNPJ, PIS, cartão, IBAN,
agência/conta, e-mail, telefone, chave Pix e valores em reais. Falso positivo é
aceitável; falso negativo não.

Além da redação, `assertNoForbiddenFields` **quebra** se um campo com nome
proibido (`password_hash`, `tax_id`, `net_amount`, …) aparecer no contexto. Um
campo assim significa que alguém montou o contexto errado — a resposta certa é
falhar em teste, não limpar em silêncio e seguir com o dado a caminho.

### O que fica gravado

A pergunta é gravada **já redigida** em `fdp_assistant_messages`: o texto
original não fica nem no banco do cliente. O campo `redactions_json` registra o
tipo e a quantidade do que foi removido, nunca o valor.

As duas tabelas têm `FORCE ROW LEVEL SECURITY` por `workspace_id`, e a consulta
ainda filtra por `user_id`: RLS isola o grupo, o filtro isola a pessoa dentro
dele. A conversa de um usuário não aparece para outro do mesmo grupo.

A tela avisa quando algo foi removido ("Removi cpf, valor da sua pergunta antes
de enviar"). Sem esse aviso a pessoa acha que o assistente ignorou o dado e
repete a pergunta.

## Configuração

O produto não embute chave de ninguém e não escolhe provedor por você.

| Variável | Obrigatória | Observação |
| --- | --- | --- |
| `FDP_ASSISTANT_PROVIDER` | sim | `anthropic` ou `openai` |
| `FDP_ASSISTANT_API_KEY` | sim | aceita também `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |
| `FDP_ASSISTANT_MODEL` | não | cai no padrão do provedor |
| `FDP_ASSISTANT_BASE_URL` | não | para gateway próprio ou ensaio local |
| `FDP_ASSISTANT_MAX_TOKENS` | não | padrão 900 |

Sem configuração o assistente **não some da tela**: ele abre e diz "Assistente
não configurado", sem campo de digitar e sem citar nome de variável secreta ao
usuário final. A rota responde `503 ASSISTANT_NOT_CONFIGURED`. Sucesso otimista
seria pior que recusa: num sistema de DP, resposta inventada é pior que resposta
nenhuma.

## Migração

`drizzle/postgres/0035_assistant_conversations.sql` cria
`fdp_assistant_conversations` e `fdp_assistant_messages`. Aplique antes do
deploy, como as demais.

## Como isto foi verificado

- `tests/assistant.test.mts` — 14 testes, incluindo os que leem o próprio código
  para provar a ordem da redação e a ausência de bypass.
- Ensaio no navegador sem provedor: painel recolhido por padrão, recusa clara,
  sem campo de digitar, Esc fecha, `POST` responde 503 sem citar segredo, e o
  painel cabe em 390px sem rolagem horizontal.
- Ensaio no navegador com um provedor local que grava byte a byte o que recebe:
  a pergunta digitada com CPF e valor chegou ao provedor como
  `"O prestador de CPF [CPF] recebe [VALOR]; como cadastro ele?"`. A chave foi
  no cabeçalho `x-api-key`, não no corpo. O banco guardou a mesma frase redigida
  e `[{"kind": "cpf", "count": 1}, {"kind": "valor", "count": 1}]`.
- `npm run a11y-check` passa a abrir o assistente de propósito — um painel que
  só aparece quando chamado ainda precisa ser legível quando aparece. Zero
  violações WCAG 2.2 AA em 1440 e 390.
