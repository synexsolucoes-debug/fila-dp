import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const resetRoute = new URL("../app/api/auth/reset/route.ts", import.meta.url);

/**
 * Dois defeitos na redefinição de senha, ambos em rota pública e sem sessão.
 *
 * 1. O `catch` devolvia `error.message` cru ao cliente. Uma falha de banco
 *    entregava nome de tabela, de coluna e de constraint a quem estivesse
 *    sondando — e essa é a única rota do produto onde qualquer pessoa da
 *    internet consegue provocar uma exceção sem estar autenticada.
 *
 * 2. Consumir um link marcava como usado apenas aquele link. Quem pede
 *    recuperação três vezes deixa três links vivos na caixa de e-mail; os
 *    outros dois continuavam trocando a senha depois da conta já recuperada,
 *    até expirarem.
 */

test("a redefinição não devolve a mensagem interna do erro ao cliente", async () => {
  const source = await readFile(resetRoute, "utf8");

  // O padrão exato que vazava: `error.message` dentro do corpo da resposta.
  assert.doesNotMatch(
    source,
    /Response\.json\(\{\s*error:\s*error instanceof Error \? error\.message/u,
    "a mensagem interna do erro não pode ir para o corpo da resposta",
  );

  // Ela continua existindo — no log do servidor, que é onde deve estar.
  assert.match(source, /log\("error", "auth\.password_reset_failed"/u);
  assert.match(source, /errorMessage: error instanceof Error \? error\.message\.slice\(0, 300\)/u);
});

test("a falha devolve requestId, para ligar o relato do usuário ao log", async () => {
  const source = await readFile(resetRoute, "utf8");
  assert.match(source, /const requestId = crypto\.randomUUID\(\)/u);
  assert.match(source, /requestId,/u, "o requestId precisa ir no corpo da resposta");
  assert.match(source, /code: "PASSWORD_RESET_FAILED"/u);
});

test("a mensagem de falha diz o que fazer, em vez de ser genérica", async () => {
  const source = await readFile(resetRoute, "utf8");
  // "Não foi possível concluir a operação" não ajuda quem está sem acesso à
  // conta: a mensagem precisa dizer que o link continua valendo e onde pedir
  // outro.
  assert.match(source, /O link continua válido/u);
  assert.match(source, /solicite um novo/u);
  assert.doesNotMatch(source, /error: "Não foi possível concluir a operação\."/u);
});

test("falha de infraestrutura conhecida mantém a resposta própria", async () => {
  const source = await readFile(resetRoute, "utf8");
  // Banco atrás da versão ou fora do ar já tem mensagem que diz o que houve
  // sem expor SQL; ela não pode ser engolida pelo tratamento genérico.
  assert.match(source, /if \(classifyInfrastructureFault\(error\)\) return apiError\(error\)/u);
});

test("redefinir a senha queima todos os links pendentes, não só o usado", async () => {
  const source = await readFile(resetRoute, "utf8");
  assert.match(
    source,
    /UPDATE fdp_access_recovery_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = \? AND used_at IS NULL/u,
    "um link antigo na caixa de e-mail não pode trocar a senha depois da recuperação",
  );
  // O escopo é o usuário, não o token: filtrar por `id` era o defeito.
  assert.doesNotMatch(source, /UPDATE fdp_access_recovery_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = \?/u);
});

test("redefinir a senha encerra as sessões abertas", async () => {
  const source = await readFile(resetRoute, "utf8");
  // Recuperar acesso é o que a pessoa faz quando desconfia de invasão: deixar a
  // sessão do invasor viva anularia o efeito da troca.
  assert.match(source, /UPDATE fdp_auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = \? AND revoked_at IS NULL/u);
});

test("o link só vale íntegro, no prazo e uma vez", async () => {
  const source = await readFile(resetRoute, "utf8");
  // O token é comparado por hash: o valor cru nunca é guardado no banco.
  assert.match(source, /hashRecoveryToken\(token\)/u);
  assert.match(source, /used_at IS NULL AND rt\.expires_at > CURRENT_TIMESTAMP/u);
  assert.match(source, /token\.length < 32/u);
  // Link inválido, expirado e já usado respondem igual: distinguir diria a quem
  // sonda qual token existe.
  assert.match(source, /Este link expirou, já foi usado ou não é válido\./u);
});

test("as três escritas acontecem juntas", async () => {
  const source = await readFile(resetRoute, "utf8");
  // Trocar a senha sem queimar o link, ou sem revogar a sessão, deixaria a conta
  // num estado pior que o inicial. O lote garante tudo ou nada.
  assert.match(source, /await d1\.batch\(\[/u);
  const batch = source.slice(source.indexOf("d1.batch(["), source.indexOf("]);", source.indexOf("d1.batch([")));
  assert.match(batch, /UPDATE fdp_users SET password_hash/u);
  assert.match(batch, /fdp_access_recovery_tokens/u);
  assert.match(batch, /fdp_auth_sessions/u);
});
