import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { epiAckLinkStatus, assertEpiAckLinkUsable, epiAckLinkUrl } from "../lib/epi-delivery-ack-link.ts";

/**
 * Link assinado genérico, passo 1: dar ciência da entrega de EPI.
 *
 * O token, o hash e o prazo são os mesmos do portal do prestador
 * (`tests/contractor-invoice-portal.test.mts` já prova essa parte). O que
 * este arquivo prova é o que muda: a situação e a recusa do link de EPI, e
 * que gerar/confirmar passam pela capacidade e pela escrita certas.
 */

const migration = await readFile(new URL("../drizzle/postgres/0101_epi_delivery_ack_links.sql", import.meta.url), "utf8");
const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
const gerar = await readFile(new URL("../app/api/epi/deliveries/[id]/ack-link/route.ts", import.meta.url), "utf8");
const confirmar = await readFile(new URL("../app/api/portal/epi/[token]/route.ts", import.meta.url), "utf8");
const epiService = await readFile(new URL("../lib/epi-service.ts", import.meta.url), "utf8");
const view = await readFile(new URL("../app/painel/features/epi/EpiControlView.tsx", import.meta.url), "utf8");

/* -------------------------------------------------------------------------- */
/* Migration e RLS                                                            */
/* -------------------------------------------------------------------------- */

test("a tabela nasce com isolamento por tenant e um link vivo por entrega", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "fdp_epi_delivery_ack_links"/u);
  assert.match(migration, /ALTER TABLE "fdp_epi_delivery_ack_links" ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /ALTER TABLE "fdp_epi_delivery_ack_links" FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /CREATE POLICY "fdp_epi_delivery_ack_links_workspace_isolation"/u);
  assert.match(migration, /fdp_epi_delivery_ack_links_open_uq"[\s\S]{0,120}WHERE "revoked_at" IS NULL AND "acknowledged_at" IS NULL/u);
  assert.match(migration, /fdp_epi_delivery_ack_links_delivery_fk[\s\S]{0,200}"fdp_epi_deliveries"/u);
});

test("o schema declara as mesmas colunas da migration", () => {
  assert.match(schema, /export const epiDeliveryAckLinks = pgTable\("fdp_epi_delivery_ack_links"/u);
  assert.match(schema, /fdp_epi_delivery_ack_links_delivery_fk/u);
  assert.match(schema, /fdp_epi_delivery_ack_links_open_uq/u);
});

/* -------------------------------------------------------------------------- */
/* Situação e recusa do link                                                  */
/* -------------------------------------------------------------------------- */

test("revogado vence tudo; confirmado vence o vencimento; sem os dois, o prazo decide", () => {
  const futuro = new Date(Date.now() + 60_000).toISOString();
  const passado = new Date(Date.now() - 60_000).toISOString();
  assert.equal(epiAckLinkStatus({ expires_at: futuro }), "active");
  assert.equal(epiAckLinkStatus({ expires_at: passado }), "expired");
  assert.equal(epiAckLinkStatus({ expires_at: passado, acknowledged_at: passado }), "acknowledged");
  assert.equal(epiAckLinkStatus({ expires_at: futuro, acknowledged_at: passado, revoked_at: passado }), "revoked");
});

test("cada situação não ativa recusa com o código certo", () => {
  const futuro = new Date(Date.now() + 60_000).toISOString();
  const passado = new Date(Date.now() - 60_000).toISOString();
  assert.doesNotThrow(() => assertEpiAckLinkUsable({ expires_at: futuro }));
  assert.throws(() => assertEpiAckLinkUsable({ expires_at: passado }),
    (error: unknown) => { assert.equal((error as { code?: string }).code, "EPI_ACK_LINK_EXPIRED"); return true; });
  assert.throws(() => assertEpiAckLinkUsable({ expires_at: futuro, revoked_at: passado }),
    (error: unknown) => { assert.equal((error as { code?: string }).code, "EPI_ACK_LINK_REVOKED"); return true; });
  assert.throws(() => assertEpiAckLinkUsable({ expires_at: futuro, acknowledged_at: passado }),
    (error: unknown) => { assert.equal((error as { code?: string }).code, "EPI_ACK_LINK_ACKNOWLEDGED"); return true; });
});

test("o link recusa gerar endereço sem FDP_APP_URL configurado", () => {
  assert.throws(() => epiAckLinkUrl("token-qualquer", ""),
    (error: unknown) => { assert.equal((error as { code?: string }).code, "APP_URL_NOT_CONFIGURED"); return true; });
  assert.equal(epiAckLinkUrl("token-qualquer", "https://app.vinculato.com.br/"), "https://app.vinculato.com.br/portal/epi/token-qualquer");
});

/* -------------------------------------------------------------------------- */
/* Gerar e confirmar                                                          */
/* -------------------------------------------------------------------------- */

test("gerar o link exige a mesma capacidade de assinar a entrega e revoga o anterior", () => {
  assert.match(gerar, /requireNamedCapability\(workspace, "epi\.deliver"/u);
  assert.match(gerar, /revoked_at = now\(\), revoked_by = \?, revoke_reason = 'Substituído por um link novo'/u);
  assert.match(gerar, /WHERE workspace_id = \? AND delivery_id = \? AND revoked_at IS NULL AND acknowledged_at IS NULL/u);
});

test("o token não entra na auditoria de geração do link", () => {
  const inicio = gerar.indexOf("prepareAuditEvent({");
  const trecho = gerar.slice(inicio, gerar.indexOf("}),", inicio));
  assert.doesNotMatch(trecho, /token\.token|token\.hash/u);
});

test("confirmar assina a entrega pela escrita estreita do portal, não pela rota do painel", () => {
  assert.match(confirmar, /prepareSignDelivery\(d1, \{/u);
  assert.match(epiService, /export function prepareSignDelivery/u);
  assert.match(epiService, /status = 'signed'/u);
});

test("confirmar exige nome, recusa entrega cancelada e fecha o link na mesma condição que impede assinar duas vezes", () => {
  assert.match(confirmar, /"EPI_SIGNATURE_REQUIRED"/u);
  assert.match(confirmar, /link\.delivery_status === "canceled"/u);
  assert.match(confirmar, /WHERE workspace_id = \? AND id = \? AND acknowledged_at IS NULL AND revoked_at IS NULL/u);
});

test("a rota pública é limitada por tentativa, como o portal do prestador", () => {
  assert.match(confirmar, /consumePublicAuthRateLimit\("epi_ack_portal"/u);
});

/* -------------------------------------------------------------------------- */
/* A tela                                                                     */
/* -------------------------------------------------------------------------- */

test("o botão de link de ciência só aparece para quem entrega, na entrega pendente de assinatura", () => {
  assert.match(view, /permissions\?\.deliver && delivery\.status === "pending_signature" && <button disabled=\{busy\} onClick=\{\(\) => onAckLink\(delivery\)\}/u);
  assert.match(view, /await requestJson<\{ url: string \}>\(`\/api\/epi\/deliveries\/\$\{delivery\.id\}\/ack-link`, \{ method: "POST"/u);
});
