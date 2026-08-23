# Worker Tangerino no Windows, com autenticação assistida

Este modo substitui o runner efêmero do GitHub Actions por um navegador visível
em uma máquina controlada pela empresa. Ele **não resolve nem contorna CAPTCHA**:
quando o Tangerino pedir uma confirmação, uma pessoa conclui o login na janela e
o perfil guarda a sessão para as próximas consultas.

## Segurança antes de começar

- Use uma conta Windows dedicada e uma máquina com disco criptografado.
- Restrinja `C:\ProgramData\Vinculato\TangerinoProfiles` a essa conta: o diretório
  contém cookies autenticados.
- O arquivo `.env.tangerino-worker.local` contém acesso ao banco e ao cofre. Não
  envie esse arquivo, não o coloque em pasta sincronizada e não o versione.
- Cada workspace recebe um diretório derivado por hash. Cookies nunca são
  compartilhados entre clientes.

## Instalação

1. Instale Node.js 24 e baixe este repositório na máquina dedicada.
2. No diretório do projeto, execute:

   ```powershell
   npm ci
   npx playwright install chromium
   Copy-Item .env.tangerino-worker.example .env.tangerino-worker.local
   ```

3. Preencha `.env.tangerino-worker.local` com `DATABASE_URL` e a chave ou mapa de
   chaves `FDP_TANGERINO_VAULT_*` usados pelo Agente Tangerino no deployment.
   Usuário e senha do Tangerino não ficam nesse arquivo; continuam cifrados no
   cofre do Vinculato.
4. Na Vercel, defina `FDP_TANGERINO_WORKER_MODE=persistent` em produção. Assim o
   backend mantém a consulta na fila para este worker e não dispara GitHub
   Actions. Não remova o token compartilhado do Sankhya.
5. Inicie o processo em uma sessão Windows visível:

   ```powershell
   npm run worker:tangerino:windows
   ```

## Primeiro teste

1. Deixe o worker aberto.
2. No Vinculato, acione **Agente Tangerino → Testar login**.
3. O worker encontra o teste em até cinco segundos e abre o Chromium.
4. Se aparecer CAPTCHA ou MFA, conclua **todo o login** manualmente nessa janela.
5. O worker continua sozinho, fecha o navegador e preserva a sessão no perfil.
6. Confira se o card muda de **Teste pendente** para **Pronto**.

Se o prazo de dez minutos terminar, o teste falha sem repetir a senha. Inicie um
novo teste quando puder acompanhar a janela. Se o Tangerino invalidar a sessão
depois, o próximo trabalho abrirá novamente a janela para renovação manual.

## Operação contínua

Depois do primeiro teste, mantenha `npm run worker:tangerino:windows` rodando na
conta Windows dedicada. Para produção, registre esse comando em uma tarefa do
Agendador do Windows disparada **ao entrar na conta**, pois o navegador precisa
de uma sessão gráfica quando houver desafio humano. Não configure a tarefa para
“Executar independentemente de o usuário estar conectado”.


