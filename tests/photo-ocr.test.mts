import assert from "node:assert/strict";
import test from "node:test";
import { ocrConfigured, photoOcrError, runDocumentOcr } from "../lib/photo-ocr.ts";

/**
 * O cliente do Google Cloud Vision para OCR de fotos de documento.
 *
 * NENHUMA chamada de rede real acontece aqui: `fetch` é substituído por um
 * dublê em cada teste que precisa dele, e restaurado depois. O que estes
 * testes PROVAM é o contrato do módulo — quando ele recusa antes de chamar a
 * rede, como interpreta a resposta do Vision, e como mapeia falha em
 * `ApiError` — não o comportamento real do serviço do Google.
 */

const originalKey = process.env.FDP_OCR_GOOGLE_VISION_API_KEY;
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  if (originalKey === undefined) delete process.env.FDP_OCR_GOOGLE_VISION_API_KEY;
  else process.env.FDP_OCR_GOOGLE_VISION_API_KEY = originalKey;
  globalThis.fetch = originalFetch;
});

test("ocrConfigured segue a variável de ambiente, e string em branco não conta", () => {
  delete process.env.FDP_OCR_GOOGLE_VISION_API_KEY;
  assert.equal(ocrConfigured(), false);
  process.env.FDP_OCR_GOOGLE_VISION_API_KEY = "   ";
  assert.equal(ocrConfigured(), false);
  process.env.FDP_OCR_GOOGLE_VISION_API_KEY = "chave-de-teste";
  assert.equal(ocrConfigured(), true);
});

test("sem chave configurada, o OCR recusa antes de tocar a rede", async () => {
  delete process.env.FDP_OCR_GOOGLE_VISION_API_KEY;
  let called = false;
  globalThis.fetch = (async () => { called = true; throw new Error("não deveria ser chamado"); }) as typeof fetch;
  await assert.rejects(
    () => runDocumentOcr({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" }),
    /OCR_NOT_CONFIGURED|não está configurado/u,
  );
  assert.equal(called, false, "sem chave, a rede nunca é chamada — é o que impede vazar a foto por engano");
});

test("tipo de arquivo fora da lista permitida é recusado antes da rede", async () => {
  process.env.FDP_OCR_GOOGLE_VISION_API_KEY = "chave-de-teste";
  let called = false;
  globalThis.fetch = (async () => { called = true; throw new Error("não deveria ser chamado"); }) as typeof fetch;
  await assert.rejects(
    () => runDocumentOcr({ bytes: new Uint8Array([1, 2, 3]), contentType: "application/pdf" }),
    /suportada/u,
  );
  assert.equal(called, false);
});

test("foto vazia é recusada antes da rede", async () => {
  process.env.FDP_OCR_GOOGLE_VISION_API_KEY = "chave-de-teste";
  await assert.rejects(
    () => runDocumentOcr({ bytes: new Uint8Array([]), contentType: "image/jpeg" }),
    /vazia|grande demais/u,
  );
});

test("resposta de sucesso do Vision devolve o texto reconhecido", async () => {
  process.env.FDP_OCR_GOOGLE_VISION_API_KEY = "chave-de-teste";
  globalThis.fetch = (async () => new Response(JSON.stringify({
    responses: [{ fullTextAnnotation: { text: "CPF 111.222.333-96" } }],
  }), { status: 200 })) as typeof fetch;
  const text = await runDocumentOcr({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" });
  assert.equal(text, "CPF 111.222.333-96");
});

test("resposta sem texto reconhecido devolve string vazia, não erro", async () => {
  process.env.FDP_OCR_GOOGLE_VISION_API_KEY = "chave-de-teste";
  globalThis.fetch = (async () => new Response(JSON.stringify({ responses: [{}] }), { status: 200 })) as typeof fetch;
  const text = await runDocumentOcr({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" });
  assert.equal(text, "");
});

test("erro HTTP do Vision vira falha nomeada", async () => {
  process.env.FDP_OCR_GOOGLE_VISION_API_KEY = "chave-de-teste";
  globalThis.fetch = (async () => new Response("", { status: 500 })) as typeof fetch;
  await assert.rejects(() => runDocumentOcr({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" }), /HTTP 500/u);
});

test("erro reportado dentro da resposta 200 do Vision também vira falha", async () => {
  process.env.FDP_OCR_GOOGLE_VISION_API_KEY = "chave-de-teste";
  globalThis.fetch = (async () => new Response(JSON.stringify({
    responses: [{ error: { message: "Bad image data." } }],
  }), { status: 200 })) as typeof fetch;
  await assert.rejects(() => runDocumentOcr({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" }), /Bad image data/u);
});

test("photoOcrError mapeia falha conhecida para 422 com o código original", async () => {
  process.env.FDP_OCR_GOOGLE_VISION_API_KEY = "chave-de-teste";
  let causa: unknown;
  try {
    await runDocumentOcr({ bytes: new Uint8Array([]), contentType: "image/jpeg" });
  } catch (erro) {
    causa = erro;
  }
  const apiError = photoOcrError(causa) as unknown as { status: number; code: string };
  assert.equal(apiError.status, 422);
  assert.equal(apiError.code, "OCR_IMAGE_SIZE_INVALID");
});

test("photoOcrError não vaza causa desconhecida — mapeia para erro genérico", () => {
  const apiError = photoOcrError(new Error("qualquer coisa")) as unknown as { status: number; code: string };
  assert.equal(apiError.status, 500);
  assert.equal(apiError.code, "OCR_UNKNOWN_ERROR");
});
