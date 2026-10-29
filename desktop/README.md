# Vinculato para Windows (app de mesa)

Instalador `.exe` que coloca o Vinculato no computador como programa — ícone na
área de trabalho e no menu Iniciar, janela própria, menu de módulos e atalhos de
teclado, no estilo dos sistemas de DP instalados (Domínio e afins).

Os dados **continuam no servidor**. O app abre o mesmo Vinculato que o navegador
abre; toda atualização publicada na Vercel chega aqui sem reinstalar.

## O que o app faz

| Recurso | Como |
| --- | --- |
| Menu **Módulos** | Visão geral, Meu trabalho, Demandas, Cadastros, Operação DP, Folha, Ponto, Pagamento PJ, Indicadores (`Ctrl+1` … `Ctrl+9`), além de Processos, EPI, Acidentes, Adiantamentos, Integrações e Histórico |
| Várias janelas | `Ctrl+N`, ou "abrir em nova aba" em qualquer link do sistema — útil para comparar competências lado a lado |
| Atalhos | `F5` atualiza, `F11` tela cheia, `Alt+←/→` voltar/avançar, `Ctrl+P` imprime, `Ctrl+K` continua abrindo a busca do painel |
| Tela de abertura | Logo e "Conectando ao servidor…" enquanto o sistema carrega |
| Sem conexão | Mostra uma tela explicando o problema, com "Tentar novamente" (e tenta sozinho quando a rede volta) |
| Links externos | eSocial, gov.br, PDFs de terceiros etc. abrem no navegador padrão, nunca dentro do app |
| Lembra a janela | Tamanho, posição e se estava maximizada |
| Servidor configurável | **Arquivo → Configurar servidor…** (para homologação ou domínio próprio) |

A página do sistema pode detectar o app por `window.vinculatoDesktop?.isDesktop`.
Nenhuma API do Windows é exposta ao site.

## Gerar o instalador

O jeito normal é pelo GitHub Actions (workflow **App de mesa (Windows)**):

- a cada mudança em `desktop/`, ou pela aba **Actions → Run workflow**, o
  `Vinculato-Setup-<versão>.exe` fica disponível como artefato do job;
- ao criar uma tag `desktop-vX.Y.Z`, o `.exe` também é publicado numa Release.

Localmente, num Windows com Node 24:

```bash
cd desktop
npm ci
npm start          # abre o app apontando para o servidor padrão
npm run dist:win   # gera dist/Vinculato-Setup-<versão>.exe
```

Para apontar para outro servidor sem mexer na configuração do usuário:
`set VINCULATO_URL=https://homolog.exemplo.com.br` antes do `npm start`.

## Ordem do servidor

1. O que foi salvo em **Configurar servidor** (fica no perfil do Windows);
2. a variável `VINCULATO_URL`;
3. o padrão de produção, `https://vinculato.vercel.app` (em `src/config.cjs`).

Endereços `*.chatgpt.site` são ignorados: essa cópia exige login do ChatGPT
antes de chegar ao Vinculato.

Só `https` é aceito (exceto `localhost`, para desenvolvimento).

## Observações

- O instalador ainda **não é assinado digitalmente**. Na primeira execução o
  Windows SmartScreen mostra "O Windows protegeu o computador" → *Mais
  informações* → *Executar assim mesmo*. Para tirar o aviso é preciso um
  certificado de assinatura de código (configurável no electron-builder).
- Atualização do próprio app (a "casca") é feita reinstalando a nova versão; o
  sistema em si se atualiza sozinho, porque vem do servidor.
- Testes: `npm test` (configuração, regras de navegação e conferência de que
  cada item do menu aponta para uma rota real de `lib/panel-routes.ts`).
