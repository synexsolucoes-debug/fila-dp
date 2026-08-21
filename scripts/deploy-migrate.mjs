import { spawn } from "node:child_process";

/**
 * Aplica as migrações pendentes durante o build de produção.
 *
 * Foi uma decisão consciente de quem opera: o passo manual depois de cada
 * deploy já foi esquecido, e schema atrasado derruba o painel inteiro com
 * `SCHEMA_OUTDATED`. Rodar aqui troca "alguém precisa lembrar" por "não
 * publica sem o banco junto".
 *
 * O preço é real e está mitigado, não ignorado:
 *
 *  - **DDL sem ninguém olhando.** Cada migração roda dentro de uma transação
 *    com trava exclusiva; ou aplica inteira, ou não aplica nada. E se falhar,
 *    o build falha junto: a versão nova do aplicativo não vai ao ar apontando
 *    para um banco que ela não entende. O ponto de restauração continua sendo
 *    responsabilidade de quem publica — no Neon, um branch antes do deploy.
 *
 *  - **Dois deploys ao mesmo tempo.** A trava do executor serializa a
 *    aplicação, mas o segundo processo já leu a lista de pendentes antes de
 *    esperar, e tentaria aplicar de novo o que o primeiro acabou de aplicar.
 *    Aqui isso não vira deploy vermelho: em caso de falha, o estado é lido de
 *    novo, e se não sobrou nada pendente foi porque o outro deploy ganhou a
 *    corrida — que é sucesso, não erro.
 *
 * Só roda em produção. Um deployment de preview com a `DATABASE_URL` de
 * produção migraria o banco de verdade a partir de um branch qualquer, e essa
 * é a forma mais fácil de aplicar em produção uma migração que ninguém
 * revisou.
 */

const ambiente = process.env.VERCEL_ENV ?? "";
const chave = String(process.env.FDP_MIGRATE_ON_DEPLOY ?? "").trim().toLowerCase();

if (chave === "off") {
  console.log("[deploy-migrate] desligado por FDP_MIGRATE_ON_DEPLOY=off — aplique com `npm run db:migrate`.");
  process.exit(0);
}

/* Fora da Vercel isto é um build local ou da integração: migrar ali seria
   aplicar schema num banco que não é o alvo deste build. */
if (!process.env.VERCEL) {
  console.log("[deploy-migrate] build fora da Vercel — nada a aplicar.");
  process.exit(0);
}

if (ambiente !== "production") {
  console.log(`[deploy-migrate] ambiente "${ambiente || "desconhecido"}" — só o de produção aplica migração.`);
  process.exit(0);
}

if (!(process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? process.env.NEON_DATABASE_URL)?.startsWith("postgres")) {
  /* Recusar é melhor que seguir em silêncio: publicar sem migrar é
     exatamente o estado que este passo existe para evitar, e ele não daria
     nenhum sinal até o painel cair. */
  console.error("[deploy-migrate] DATABASE_URL não está disponível no build de produção.");
  console.error("  Marque a variável como disponível em Build na Vercel, ou desligue este passo");
  console.error("  com FDP_MIGRATE_ON_DEPLOY=off e aplique à mão pelo roteiro em");
  console.error("  docs/aplicar-migracoes-em-producao.md.");
  process.exit(1);
}

const rodar = (script) => new Promise((resolve) => {
  const filho = spawn(process.execPath, ["--experimental-strip-types", script], { stdio: "inherit" });
  filho.on("close", (code) => resolve(code ?? 1));
});

console.log("[deploy-migrate] aplicando migrações pendentes antes de publicar…");
const codigo = await rodar("scripts/migrate.mjs");

if (codigo === 0) {
  console.log("[deploy-migrate] banco na mesma versão do aplicativo.");
  process.exit(0);
}

/* Falhou. Antes de derrubar o deploy, pergunta o que ficou: se não há mais
   nada pendente, outro deploy aplicou enquanto este esperava a trava. */
console.error("[deploy-migrate] a aplicação falhou; conferindo o estado do banco…");
const estado = await rodar("scripts/migration-status.mjs");

if (estado === 0) {
  console.log("[deploy-migrate] nada pendente — outro deploy aplicou primeiro. Seguindo.");
  process.exit(0);
}

console.error("[deploy-migrate] há migração pendente e ela não aplicou. O build para aqui.");
console.error("  Publicar agora colocaria no ar uma versão que o banco não acompanha.");
process.exit(1);
