# Fase 10 — Comercialização: site, captação, termos e LGPD

Data: 2026-08-09
Migration: `0020_marketing_leads`

Esta fase entrega o site comercial, a captação de contato e os documentos legais. A regra que
governa tudo aqui é a do §90 e do §103: **o site não pode anunciar o que o produto não faz.**

## 1. Auditoria do site anterior

O site existente violava a especificação em pontos concretos, agora corrigidos:

| Problema encontrado | Correção |
| --- | --- |
| "Plano gratuito para começar" e "Sem cartão de crédito" no herói | Removidos. O produto não tem plano gratuito publicado e cobrável. |
| Quatro planos fixos em código (Gratuito, Standard, Premium, Enterprise) com preço implícito | Substituídos por chamadas para a página de planos, que lê o catálogo real. |
| Navegação apontando só para âncoras da própria home | Navegação real para as páginas do site. |
| Ausência de declaração das fronteiras do produto | Fronteiras exibidas na home, em Solução, em Funcionalidades e no rodapé de todas as páginas. |

## 2. Páginas entregues

`/` (home revisada), `/solucao`, `/funcionalidades`, `/integracoes`, `/planos`, `/demonstracao`,
`/faq`, `/contato`, `/termos`, `/privacidade`, `/subprocessadores`. `/login` e `/recuperar` já existiam.

Todas compartilham `app/site/SiteShell.tsx`: navegação única, atalho para o conteúdo, marco
`<main id="conteudo">`, `aria-current` na página ativa, foco visível, movimento reduzido e layout
responsivo.

## 3. Planos refletem o catálogo real

`/planos` lê `fdp_saas_plans` no servidor e mostra **apenas planos ativos**. O preço e o botão de
contratação só aparecem quando o plano é cobrável de fato — preço configurado e identificador de
preço no provedor de pagamento. Caso contrário, o plano aparece como "Sob consulta" com chamada
para falar com a equipe. Sem catálogo publicado, a página inteira assume condições sob consulta.

Nenhum valor em reais está escrito em código na página: todo número vem do catálogo.

## 4. Integrações com estado real

`/integracoes` publica o catálogo de `lib/marketing.ts` com três estados: **disponível**, **parcial**
e **preparado**. Sólides e Caju aparecem como preparados, com a observação de que não há integração
oficial implementada — coerente com o que o produto realmente faz. Logo de fornecedor não é usado
como prova de integração.

## 5. Captação de contato de verdade

O formulário não é decorativo: `POST /api/site/contact` valida o conteúdo, exige consentimento
explícito, aplica limite de 5 envios por hora por endereço e grava em `fdp_marketing_leads`,
devolvendo um protocolo ao visitante.

`fdp_marketing_leads` é a única tabela do produto que não é multi-tenant — o contato chega antes de
existir workspace. A proteção é outra, verificada em banco real:

- `FOR INSERT WITH CHECK (true)` permite o envio público.
- `FOR SELECT` e `FOR UPDATE` exigem `app.platform_admin = 'true'`.
- Um papel de aplicação sem superusuário insere e lê **zero** registros; com o contexto de
  plataforma, lê todos.

`GET/PATCH /api/platform/leads` expõe os contatos apenas à administração da plataforma, com
auditoria global de cada mudança de status. O log registra que houve contato, com o assunto — nunca
nome, e-mail ou mensagem.

## 6. Documentos legais

- **Termos de uso**: escopo do serviço, o que ele não faz, responsabilidades, uso aceitável,
  disponibilidade, cobrança e cancelamento, propriedade dos dados, limitação de responsabilidade.
- **Política de privacidade**: papéis de controlador e operador, princípio de minimização com as
  medidas reais (CPF só como HMAC e quatro dígitos, dados bancários em AES-256-GCM, recusa de
  conteúdo clínico, log sem PII), bases legais, compartilhamento, retenção e eliminação, direitos
  do titular, segurança, incidentes, transferência internacional e canal do encarregado.
- **Subprocessadores e DPA**: lista de subprocessadores com finalidade e local, papéis, compromissos
  do operador, obrigações do controlador, medidas técnicas e organizacionais.

Sobre backup, o DPA diz o que é verdade: os procedimentos de restauração **devem ser ensaiados antes
de serem declarados válidos**. O produto não afirma restauração testada.

## 7. Guarda automática contra promessa falsa

`findProhibitedClaims` em `lib/marketing.ts` verifica textos contra as fronteiras do §90 —
admissão digital própria, prontuário, gestão clínica, cálculo tributário, emissão fiscal e
substituição de ERP/contador.

A guarda é sensível ao contexto: dizer "não guarda prontuário" é obrigatório e não é violação, mas a
negação precisa estar **no mesmo trecho**. Uma negativa em uma frase não autoriza a promessa na
frase seguinte — isso foi um defeito da primeira versão, encontrado pelo próprio teste e corrigido.

O teste roda a guarda sobre todas as páginas do site, inclusive as legais. Uma promessa proibida
introduzida no futuro reprova o build.

## 8. Validação executada

- `npm run lint`, `npm run db:check` (23 migrations), `npm test` (131 testes, 13 novos) e
  `npm run build`: aprovados.
- `npm run db:rehearse` contra PostgreSQL 16 real, em banco limpo: as 23 migrations aplicam.
- Comportamento da RLS dos contatos verificado com papel sem `SUPERUSER`: insere, não lê; com
  contexto de plataforma, lê.

## 9. Checklist de comercialização

| Item | Estado |
| --- | --- |
| Site com as páginas exigidas | Concluído |
| Fronteiras do produto declaradas no site | Concluído |
| Planos refletindo catálogo real | Concluído |
| Integrações com estado honesto | Concluído |
| Captação de contato funcional e auditável | Concluído |
| Termos, Privacidade e DPA | Concluído |
| Guarda automática de promessas | Concluído |
| Cobrança fim a fim homologada em produção | **Pendente** — exige operador configurar preços no Stripe e homologar checkout em modo teste |
| Backup e restauração ensaiados | **Pendente** — sem ensaio registrado, não é declarado |
| Página de status público | **Pendente** |
| Base de ajuda e documentação de usuário final | **Pendente** |

## 10. Pendências desta fase

- O site é a camada comercial; a **homologação da cobrança** continua sendo um gate operacional da
  Fase 7 (configurar preços, ativar planos e testar checkout e portal antes de abrir cadastro).
- Não há envio de e-mail: o contato fica registrado para a equipe tratar pelo painel da plataforma.
  Notificação por e-mail depende do provedor de envio, que ainda não faz parte do produto.
- Não há página de status, changelog público nem central de ajuda.
- O texto legal cobre o exigido pela especificação, mas **deve ser revisado por assessoria jurídica**
  antes do primeiro contrato — o produto não substitui essa revisão.
