import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import test from "node:test";
import { encodeGrayPng, rasterizeSignature } from "../src/lib/png.ts";

/** Lê um PNG em tons de cinza de 8 bits com o zlib do Node — um leitor independente do codificador. */
function decode(png: Uint8Array) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "assinatura PNG");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8; let width = 0; let height = 0; const idat: Uint8Array[] = [];
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") { width = view.getUint32(at + 8); height = view.getUint32(at + 12); assert.equal(data[8], 8); assert.equal(data[9], 0); }
    if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, (width + 1) * height);
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) pixels.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  return { width, height, pixels };
}

test("o PNG gerado é lido por um decodificador independente, pixel a pixel", () => {
  const pixels = new Uint8Array(70_000).map((_, index) => index % 256);
  const decoded = decode(encodeGrayPng(350, 200, pixels));
  assert.equal(decoded.width, 350);
  assert.equal(decoded.height, 200);
  assert.deepEqual(decoded.pixels, pixels, "acima de 65535 bytes o zlib precisa de mais de um bloco");
});

test("a assinatura sai como traço preto em fundo branco, sem buraco no traço rápido", () => {
  const png = rasterizeSignature([[{ x: 10, y: 50 }, { x: 290, y: 50 }]], 300, 100, 600, 200, 4);
  const { width, pixels } = decode(png);
  assert.equal(pixels[0], 255, "fundo branco");
  // A linha horizontal atravessa a imagem inteira, sem falha entre os dois pontos.
  const row = 100;
  for (let x = 30; x < 570; x++) assert.equal(pixels[row * width + x], 0, `pixel ${x} do traço`);
  assert.ok(png.length < 200_000, "cabe folgado no limite de anexo");
});
