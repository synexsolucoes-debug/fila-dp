import assert from "node:assert/strict";
import test from "node:test";
import { validateWebhookUrl } from "../lib/webhooks.ts";

/**
 * O endpoint de webhook de saída é o único lugar onde o cliente escolhe para
 * onde o servidor faz uma requisição. Se ele puder apontar para a rede interna,
 * um tenant transforma o produto em proxy para o que estiver ao alcance do
 * container — outros serviços internos, ou o endpoint de metadados da nuvem,
 * que devolve credencial de instância.
 *
 * A validação existia e cobria bem IPv4, inclusive as notações decimal,
 * hexadecimal e octal — o parser do WHATWG normaliza essas três antes da
 * checagem. O buraco estava no IPv6:
 *
 *   `new URL("https://[::1]/").hostname` === "[::1]"    // com colchetes
 *
 * A comparação era contra `"::1"` puro, então nunca casava, e
 * `https://[::1]:PORTA/` era aceito. A forma mapeada era pior: o parser
 * reescreve `::ffff:127.0.0.1` como `::ffff:7f00:1`, então procurar por ponto
 * não encontrava o IPv4 escondido nos dois últimos hextets.
 */

const recusa = (url: string, motivo: string) => {
  assert.throws(() => validateWebhookUrl(url), (error: unknown) => {
    assert.equal((error as { code?: string }).code, motivo, `${url} deveria falhar com ${motivo}`);
    return true;
  }, `${url} precisa ser recusado`);
};

test("destino público legítimo é aceito, em IPv4 e IPv6", () => {
  assert.equal(validateWebhookUrl("https://exemplo.com.br/hook"), "https://exemplo.com.br/hook");
  // Um IPv6 público não pode ser barrado junto com os privados.
  assert.ok(validateWebhookUrl("https://[2606:4700::1111]/hook"));
});

test("loopback IPv6 entre colchetes é recusado", () => {
  // O caso que passava: o hostname chega como "[::1]", não "::1".
  recusa("https://[::1]/hook", "WEBHOOK_URL_PRIVATE");
  recusa("https://[::]/hook", "WEBHOOK_URL_PRIVATE");
});

test("IPv4 mapeado em IPv6 é decodificado, não só procurado por ponto", () => {
  // O parser reescreve estes como ::ffff:7f00:1 e ::ffff:a00:1.
  recusa("https://[::ffff:127.0.0.1]/hook", "WEBHOOK_URL_PRIVATE");
  recusa("https://[::ffff:10.0.0.1]/hook", "WEBHOOK_URL_PRIVATE");
  recusa("https://[::ffff:192.168.0.1]/hook", "WEBHOOK_URL_PRIVATE");
  // E também na forma que já vem hexadecimal.
  recusa("https://[::ffff:7f00:1]/hook", "WEBHOOK_URL_PRIVATE");
});

test("link-local e unique-local IPv6 são recusados", () => {
  recusa("https://[fe80::1]/hook", "WEBHOOK_URL_PRIVATE");
  recusa("https://[fc00::1]/hook", "WEBHOOK_URL_PRIVATE");
  recusa("https://[fd00::1]/hook", "WEBHOOK_URL_PRIVATE");
});

test("as faixas privadas IPv4 continuam recusadas, em toda notação", () => {
  for (const url of [
    "https://127.0.0.1/hook",
    "https://10.0.0.5/hook",
    "https://172.16.0.1/hook",
    "https://192.168.0.1/hook",
    "https://0.0.0.0/hook",
    // Notações alternativas do mesmo 127.0.0.1: o parser normaliza as três.
    "https://2130706433/hook",
    "https://0x7f000001/hook",
    "https://017700000001/hook",
  ]) {
    recusa(url, "WEBHOOK_URL_PRIVATE");
  }
});

test("o endpoint de metadados da nuvem é recusado", () => {
  // 169.254.169.254 devolve credencial de instância em AWS, GCP e Azure.
  recusa("https://169.254.169.254/latest/meta-data/", "WEBHOOK_URL_PRIVATE");
  recusa("https://169.254.170.2/v2/credentials", "WEBHOOK_URL_PRIVATE");
});

test("nomes internos e esquemas inseguros são recusados", () => {
  recusa("https://localhost/hook", "WEBHOOK_URL_PRIVATE");
  recusa("https://api.localhost/hook", "WEBHOOK_URL_PRIVATE");
  recusa("https://servidor.local/hook", "WEBHOOK_URL_PRIVATE");
  recusa("http://exemplo.com.br/hook", "WEBHOOK_URL_INSECURE");
  recusa("file:///etc/passwd", "WEBHOOK_URL_INSECURE");
  recusa("nao-e-url", "WEBHOOK_URL_INVALID");
});

test("credencial embutida na URL é recusada", () => {
  // Ela iria parar no log de entrega e no cadastro do endpoint.
  recusa("https://usuario:senha@exemplo.com/hook", "WEBHOOK_URL_CREDENTIALS");
});

test("o fragmento é descartado do destino gravado", () => {
  assert.equal(validateWebhookUrl("https://exemplo.com.br/hook#segredo"), "https://exemplo.com.br/hook");
});
