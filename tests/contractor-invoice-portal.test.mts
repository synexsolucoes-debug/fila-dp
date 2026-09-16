import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertPortalLinkUsable,
  createPortalToken,
  hashPortalToken,
  parsePortalToken,
  portalExpiryFromDays,
  portalLinkStatus,
  portalLinkUrl,
  PORTAL_DEFAULT_DAYS,
  samePortalHash,
} from "../lib/contractor-invoice-portal.ts";

/**
 * O portal do prestador: o link que recebe a nota fiscal.
 *
 * Coletar nota era o gargalo do fechamento — e o trabalho não era de quem
 * emite, era de quem estava tentando fechar: o aviso saía como texto para colar
 * no WhatsApp, o prestador respondia com o PDF anexado, e alguém do DP subia o
 * arquivo na tela, trinta vezes.
 *
 * O que este arquivo guarda é a parte que não pode estar errada. Uma URL
 * pública com um segredo dentro tem um conjunto pequeno de formas de falhar, e
 * todas elas são graves: segredo em claro no banco, token de um cliente valendo
 * em outro, link que não morre no prazo, recusa que diz demais.
 */

const rota = await readFile(new URL("../app/api/portal/nota/[token]/route.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/postgres/0084_contractor_invoice_portal.sql", import.meta.url), "utf8");
const servico = await readFile(new URL("../lib/contractor-invoice-service.ts", import.meta.url), "utf8");

/* -------------------------------------------------------------------------- */
/* Token                                                                       */
/* -------------------------------------------------------------------------- */

test("o token carrega o inquilino e um segredo, e o hash amarra os dois", () => {
  const token = createPortalToken("ws-alpha");
  const lido = parsePortalToken(token.token);
  assert.equal(lido?.workspaceId, "ws-alpha");
  assert.equal(lido?.secret, token.secret);
  assert.equal(token.hash, hashPortalToken("ws-alpha", token.secret));
  // Trocar o prefixo na mão não reaproveita o segredo em outro cliente: o hash
  // é calculado sobre os dois juntos, então o token simplesmente não existe lá.
  assert.notEqual(hashPortalToken("ws-beta", token.secret), token.hash);
});

test("dois tokens nunca saem iguais", () => {
  const vistos = new Set(Array.from({ length: 50 }, () => createPortalToken("ws-alpha").token));
  assert.equal(vistos.size, 50);
});

test("o segredo tem entropia de sobra", () => {
  const { secret } = createPortalToken("ws-alpha");
  // 32 bytes em base64url dão 43 caracteres. O piso está no `parsePortalToken`,
  // e um segredo curto é um segredo adivinhável.
  assert.ok(secret.length >= 43, `segredo curto demais: ${secret.length}`);
  assert.match(secret, /^[A-Za-z0-9_-]+$/u, "o segredo precisa sobreviver a uma URL sem escapar");
});

test("token malformado não é lido, e nenhum formato recusa diferente do outro", () => {
  for (const valor of ["", "   ", "sem-separador", ".", ".segredo", "ws-alpha.", "ws-alpha.curto", null, undefined, 42]) {
    assert.equal(parsePortalToken(valor), null, `aceitou ${String(valor)}`);
  }
});

test("o inquilino pode conter hífen, e o corte é no primeiro ponto", () => {
  const token = createPortalToken("ws-alpha-2026");
  assert.equal(parsePortalToken(token.token)?.workspaceId, "ws-alpha-2026");
});

test("a comparação de hash não vaza pelo tempo nem aceita tamanho diferente", () => {
  const { hash } = createPortalToken("ws-alpha");
  assert.equal(samePortalHash(hash, hash), true);
  assert.equal(samePortalHash(hash, `${hash}x`), false);
  assert.equal(samePortalHash(hash, hash.slice(0, -1)), false);
  assert.equal(samePortalHash(hash, hash.replace(/.$/u, "0")), false);
});

/* -------------------------------------------------------------------------- */
/* Situação                                                                    */
/* -------------------------------------------------------------------------- */

const futuro = new Date(Date.now() + 86_400_000).toISOString();
const passado = new Date(Date.now() - 86_400_000).toISOString();

test("a situação do link segue a ordem em que os fatos se sobrepõem", () => {
  assert.equal(portalLinkStatus({ expires_at: futuro }), "active");
  assert.equal(portalLinkStatus({ expires_at: passado }), "expired");
  assert.equal(portalLinkStatus({ expires_at: futuro, submitted_at: passado }), "submitted");
  assert.equal(portalLinkStatus({ expires_at: futuro, revoked_at: passado }), "revoked");
});

test("revogar vence tudo, e entregar vence o vencimento", () => {
  // Revogar é decisão explícita de alguém e não deve ser apagada pelo prazo.
  assert.equal(portalLinkStatus({ expires_at: passado, revoked_at: passado }), "revoked");
  assert.equal(portalLinkStatus({ expires_at: futuro, submitted_at: passado, revoked_at: passado }), "revoked");
  // E um link que cumpriu o que existia para cumprir não é prazo perdido: no
  // mês seguinte ele apareceria como atraso que nunca houve.
  assert.equal(portalLinkStatus({ expires_at: passado, submitted_at: passado }), "submitted");
});

test("só o link ativo aceita envio, e cada recusa diz o que fazer", () => {
  assert.doesNotThrow(() => assertPortalLinkUsable({ expires_at: futuro }));
  for (const [linha, codigo] of [
    [{ expires_at: passado }, "PORTAL_LINK_EXPIRED"],
    [{ expires_at: futuro, revoked_at: passado }, "PORTAL_LINK_REVOKED"],
    [{ expires_at: futuro, submitted_at: passado }, "PORTAL_LINK_SUBMITTED"],
  ] as const) {
    assert.throws(() => assertPortalLinkUsable(linha), (error: { code?: string; message?: string }) => {
      assert.equal(error.code, codigo);
      // Quem recebe a recusa não é usuário do produto: a mensagem precisa dizer
      // a quem recorrer, não o nome do estado interno.
      assert.match(String(error.message), /procure quem cuida do pagamento/iu);
      return true;
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Prazo e endereço                                                            */
/* -------------------------------------------------------------------------- */

test("o prazo tem padrão, teto e piso", () => {
  const agora = new Date("2026-09-16T12:00:00Z");
  const dia = 86_400_000;
  assert.equal(portalExpiryFromDays(undefined, agora).getTime(), agora.getTime() + PORTAL_DEFAULT_DAYS * dia);
  assert.equal(portalExpiryFromDays(5, agora).getTime(), agora.getTime() + 5 * dia);
  // Sem teto, um link seria credencial permanente entregue por WhatsApp.
  assert.equal(portalExpiryFromDays(9999, agora).getTime(), agora.getTime() + 90 * dia);
  for (const invalido of [0, -3, "abc", null, Number.NaN]) {
    assert.equal(portalExpiryFromDays(invalido, agora).getTime(), agora.getTime() + PORTAL_DEFAULT_DAYS * dia,
      `${String(invalido)} deveria cair no padrão`);
  }
});

test("o endereço recusa em vez de devolver um link que não abre", () => {
  assert.equal(portalLinkUrl("ws.seg", "https://app.exemplo.com"), "https://app.exemplo.com/portal/nota/ws.seg");
  assert.equal(portalLinkUrl("ws.seg", "https://app.exemplo.com/"), "https://app.exemplo.com/portal/nota/ws.seg");
  // Um caminho relativo seria colado no WhatsApp e não abriria nada, com o erro
  // aparecendo do lado de quem não pode corrigi-lo.
  assert.throws(() => portalLinkUrl("ws.seg", ""), (error: { code?: string }) => {
    assert.equal(error.code, "APP_URL_NOT_CONFIGURED");
    return true;
  });
});

/* -------------------------------------------------------------------------- */
/* A rota pública                                                              */
/* -------------------------------------------------------------------------- */

test("a rota pública nasce presa ao inquilino do token", () => {
  // Não há consulta sem recorte seguida de filtro na aplicação: a RLS da tabela
  // vale para esta rota como vale para qualquer outra.
  assert.match(rota, /getScopedD1\(\{ workspaceId: parsed\.workspaceId \}\)/u);
  assert.doesNotMatch(rota, /\bgetD1\(\)/u, "a rota do portal não pode abrir conexão sem inquilino");
  assert.match(rota, /WHERE link\.workspace_id = \? AND link\.token_hash = \?/u);
});

test("toda recusa de token é a mesma recusa", () => {
  // Distinguir malformado de inexistente ensinaria a quem está adivinhando onde
  // chegou mais perto.
  assert.match(rota, /if \(!parsed\) throw genericNotFound\(\);/u);
  assert.match(rota, /if \(!link \|\| !samePortalHash\(link\.token_hash, hash\)\) throw genericNotFound\(\);/u);
  assert.match(rota, /PORTAL_LINK_NOT_FOUND/u);
  assert.doesNotMatch(rota, /token (inexistente|inválido para este workspace)/iu);
});

test("a rota limita tentativas antes de consultar o banco", () => {
  const corpo = rota.slice(rota.indexOf("async function resolveLink"), rota.indexOf("const portalPayload"));
  const limite = corpo.indexOf("consumePublicAuthRateLimit");
  const consulta = corpo.indexOf("d1.prepare");
  assert.ok(limite > 0 && consulta > limite,
    "sem limite antes da consulta a rota vira um oráculo que diz se um segredo existe");
});

test("o envio passa pelo mesmo registro da tela, com o alerta de duplicidade fechado", () => {
  assert.match(rota, /registerInvoice\(d1, \{/u);
  assert.match(rota, /assertNotDuplicated\(d1, \{/u);
  // Quem envia não pode dispensar o próprio alerta: liberar um envio repetido é
  // decisão de conferência, e conferência é do DP.
  assert.match(rota, /acknowledged: false/u);
  assert.match(rota, /canAcknowledge: false/u);
});

test("o arquivo é obrigatório no portal e o link fecha junto com a nota", () => {
  assert.match(rota, /INVOICE_FILE_REQUIRED/u);
  assert.match(rota, /checkInvoiceFile\(\{ name: file\.name, type: file\.type, size: file\.size \}\)/u);
  // A condição no WHERE é o que impede dois envios simultâneos de virarem duas
  // notas: o segundo não encontra link aberto e é recusado antes de escrever.
  assert.match(rota, /SET submitted_at = now\(\), submitted_invoice_id = \?[\s\S]*?AND submitted_at IS NULL AND revoked_at IS NULL/u);
});

test("o arquivo enviado é apagado quando o envio não se completa", () => {
  // Sem isso, cada recusa depois do upload deixaria um objeto órfão contando
  // contra a cota de armazenamento do cliente.
  assert.match(rota, /if \(uploadedObjectKey && bucketRef\) await bucketRef\.delete\(uploadedObjectKey\)/u);
});

test("a resposta do portal não carrega o que o prestador não deve ver", () => {
  const payload = rota.slice(rota.indexOf("const portalPayload"), rota.indexOf("export async function GET"));
  for (const vazamento of ["provider_id", "closing_id", "workspace_id", "company_id"]) {
    assert.ok(!payload.includes(vazamento), `${vazamento} não deveria sair na resposta pública`);
  }
  assert.match(payload, /contractorName|expectedAmount|issuer/u);
});

/* -------------------------------------------------------------------------- */
/* O ator que não é pessoa                                                     */
/* -------------------------------------------------------------------------- */

test("o histórico da nota admite ator que não é membro, e cobra o nome dele", () => {
  // Carimbar o id de quem gerou o link registraria que uma pessoa do DP enviou
  // uma nota que ela não enviou — numa tabela cuja razão de existir é responder
  // "quem fez o quê".
  assert.match(servico, /export type InvoiceActor =/u);
  assert.match(servico, /\{ kind: "contractor_portal"; name: string \}/u);
  assert.doesNotMatch(servico, /actorUserId: input\.actorUserId/u, "o ator voltou a ser sempre uma pessoa");
  assert.match(rota, /actor: \{ kind: "contractor_portal", name: link\.contractor_name \}/u);

  assert.match(migration, /ALTER TABLE "fdp_contractor_invoice_events" ALTER COLUMN "actor_user_id" DROP NOT NULL/u);
  assert.match(migration, /CHECK \(\("actor_kind" = 'user' AND "actor_user_id" IS NOT NULL\)[\s\S]*?'contractor_portal' AND length\(trim\("actor_label"\)\) > 0\)/u);
});

test("o canal da nota e do arquivo fica registrado, com pessoa obrigatória no painel", () => {
  for (const tabela of ["fdp_contractor_invoices", "fdp_contractor_documents"]) {
    const coluna = tabela === "fdp_contractor_invoices" ? "uploaded" : "created";
    assert.match(migration, new RegExp(`ALTER TABLE "${tabela}" ALTER COLUMN "${coluna}_by" DROP NOT NULL`, "u"));
    assert.match(migration, new RegExp(`CHECK \\("${coluna}_via" IN \\('panel', 'contractor_portal'\\)\\)`, "u"));
    assert.match(migration, new RegExp(`CHECK \\("${coluna}_via" <> 'panel' OR "${coluna}_by" IS NOT NULL\\)`, "u"));
  }
});

/* -------------------------------------------------------------------------- */
/* A tabela de links                                                           */
/* -------------------------------------------------------------------------- */

test("a tabela de links guarda hash, nunca o token", () => {
  assert.match(migration, /"token_hash" text NOT NULL/u);
  assert.doesNotMatch(migration, /"token" text/u, "o token completo não pode ter coluna");
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "fdp_contractor_invoice_portal_links_token_uq"/u);
});

test("um link vivo por fechamento", () => {
  // Dois válidos ao mesmo tempo deixariam o prestador adivinhando qual usar.
  assert.match(migration, /"fdp_contractor_invoice_portal_links_open_uq"[\s\S]*?\("workspace_id", "closing_id"\)[\s\S]*?WHERE "revoked_at" IS NULL AND "submitted_at" IS NULL/u);
});

test("a tabela do portal tem RLS forçada como toda tabela com workspace_id (§8)", () => {
  assert.match(migration, /ALTER TABLE "fdp_contractor_invoice_portal_links" ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /ALTER TABLE "fdp_contractor_invoice_portal_links" FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /USING \("workspace_id" = NULLIF\(current_setting\('app\.workspace_id', true\), ''\)\)/u);
  assert.match(migration, /WITH CHECK \("workspace_id" = NULLIF\(current_setting\('app\.workspace_id', true\), ''\)\)/u);
});

test("revogar e entregar exigem os dois campos, nunca meio fato", () => {
  assert.match(migration, /CHECK \(\("revoked_at" IS NULL AND "revoked_by" IS NULL\) OR \("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL\)\)/u);
  assert.match(migration, /CHECK \(\("submitted_at" IS NULL AND "submitted_invoice_id" IS NULL\)[\s\S]*?IS NOT NULL AND "submitted_invoice_id" IS NOT NULL\)\)/u);
});

test("a migration entrou no journal do Drizzle", async () => {
  const journal = JSON.parse(await readFile(new URL("../drizzle/postgres/meta/_journal.json", import.meta.url), "utf8")) as
    { entries: Array<{ tag: string; idx: number }> };
  assert.ok(journal.entries.some((entry) => entry.tag === "0084_contractor_invoice_portal"));
});

/* -------------------------------------------------------------------------- */
/* O painel                                                                    */
/* -------------------------------------------------------------------------- */

test("gerar link de novo revoga o anterior em vez de esbarrar no índice", async () => {
  const painelRota = await readFile(new URL("../app/api/payments/contractors/invoices/portal-links/route.ts", import.meta.url), "utf8");
  assert.match(painelRota, /SET revoked_at = now\(\), revoked_by = \?, revoke_reason = 'Substituído por um link novo'/u);
  // Quem já mandou a nota fica de fora: gerar link para quem cumpriu é convidar
  // a uma segunda via que ninguém pediu.
  assert.match(painelRota, /AND closing\.invoice_current_id IS NULL/u);
  assert.match(painelRota, /AND closing\.status NOT IN \('closed', 'paid'\)/u);
});

test("o link só existe na resposta que o cria; a listagem nunca o devolve", async () => {
  const painelRota = await readFile(new URL("../app/api/payments/contractors/invoices/portal-links/route.ts", import.meta.url), "utf8");
  const listagem = painelRota.slice(painelRota.indexOf("const publicLink"), painelRota.indexOf("export async function POST"));
  assert.ok(!listagem.includes("portalLinkUrl"), "a listagem virou um chaveiro de credenciais válidas");
  assert.match(painelRota, /requireCapability\(workspace, "invoice\.portal\.manage"\)/u);
});

test("o token não entra na trilha de auditoria", async () => {
  const painelRota = await readFile(new URL("../app/api/payments/contractors/invoices/portal-links/route.ts", import.meta.url), "utf8");
  const trilha = painelRota.slice(painelRota.indexOf("prepareAuditEvent({"))
    .replace(/\/\/[^\n]*/gu, "")
    .replace(/\/\*[\s\S]*?\*\//gu, "");
  assert.ok(!/token/iu.test(trilha), "auditoria guarda o que aconteceu, não a credencial que permite repetir");
});

test("a mensagem do aviso leva o link, e o link é casado por id e não por nome", async () => {
  const aviso = await readFile(new URL("../lib/contractor-invoice-notice.ts", import.meta.url), "utf8");
  assert.match(aviso, /portalUrls\.get\(String\(row\.provider_id \?\? row\.providerId \?\? ""\)\)/u,
    "dois prestadores homônimos receberiam o link um do outro");
  assert.match(aviso, /Por gentileza emitir sua NF e enviar por este link:/u);
});

test("a página do portal não é indexável e o token não aparece no corpo", async () => {
  const pagina = await readFile(new URL("../app/portal/nota/[token]/page.tsx", import.meta.url), "utf8");
  assert.match(pagina, /robots: \{ index: false, follow: false, nocache: true \}/u);
  const mapa = await readFile(new URL("../lib/site-map.ts", import.meta.url), "utf8");
  assert.match(mapa, /privatePaths = \[[^\]]*"\/portal"/u, "o portal precisa ficar fora do robots.txt");

  const formulario = await readFile(new URL("../app/portal/nota/[token]/PortalInvoiceForm.tsx", import.meta.url), "utf8");
  // Uma captura de tela do pedido, que é coisa que se manda no grupo do
  // trabalho, não deve carregar junto a credencial que autoriza o envio.
  assert.doesNotMatch(formulario, /\{token\}(?!<\/)/u, "o token não pode ser desenhado na página");
});
