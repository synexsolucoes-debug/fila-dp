/**
 * Codificador PNG mínimo, em TypeScript puro.
 *
 * Existe para a assinatura. O termo de entrega precisa de uma imagem que o
 * servidor aceite (PNG ou JPEG), e as saídas usuais — capturar a tela da área
 * de desenho — dependem de bibliotecas nativas que nem sempre estão no Expo
 * Go. Uma assinatura é traço preto em fundo branco: tons de cinza de 8 bits,
 * sem compressão de verdade, cabem em ~150 KB e não precisam de nada além de
 * aritmética.
 *
 * O DEFLATE usa só blocos "armazenados" (sem compressão), que todo leitor de
 * PNG aceita. A conferência fica em `tests/png.test.mts`, que decodifica o
 * resultado com o zlib do Node.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function writeUint32(target: Uint8Array, offset: number, value: number) {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

/** zlib com blocos armazenados: cabeçalho, blocos de até 65535 bytes, adler32. */
function zlibStore(data: Uint8Array) {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
  out[0] = 0x78; out[1] = 0x01;
  let at = 2;
  for (let index = 0; index < blocks; index++) {
    const start = index * 65535;
    const size = Math.min(65535, data.length - start);
    out[at++] = index === blocks - 1 ? 1 : 0;
    out[at++] = size & 0xff; out[at++] = (size >>> 8) & 0xff;
    out[at++] = ~size & 0xff; out[at++] = (~size >>> 8) & 0xff;
    out.set(data.subarray(start, start + size), at);
    at += size;
  }
  writeUint32(out, at, adler32(data));
  return out;
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  writeUint32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeUint32(out, 8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** PNG em tons de cinza de 8 bits. `pixels` tem `width * height` bytes, linha a linha. */
export function encodeGrayPng(width: number, height: number, pixels: Uint8Array) {
  if (pixels.length !== width * height) throw new Error("Tamanho de imagem inconsistente.");
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filtro "nenhum"
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const header = new Uint8Array(13);
  writeUint32(header, 0, width);
  writeUint32(header, 4, height);
  header[8] = 8; // profundidade
  header[9] = 0; // tons de cinza
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlibStore(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

export type Point = { x: number; y: number };
export type Stroke = Point[];

/**
 * Desenha os traços num quadro branco e devolve o PNG.
 *
 * Os pontos vêm em coordenadas da tela (`sourceWidth` × `sourceHeight`) e são
 * levados para o tamanho de saída. Cada segmento é preenchido com discos de
 * raio `thickness / 2` a cada meio pixel — sem buraco entre pontos quando o
 * dedo corre rápido.
 */
export function rasterizeSignature(strokes: Stroke[], sourceWidth: number, sourceHeight: number, width = 600, height = 240, thickness = 4) {
  const pixels = new Uint8Array(width * height).fill(255);
  const scale = Math.min(width / Math.max(sourceWidth, 1), height / Math.max(sourceHeight, 1));
  const offsetX = (width - sourceWidth * scale) / 2;
  const offsetY = (height - sourceHeight * scale) / 2;
  const r = Math.max(1, thickness / 2);
  const stamp = (cx: number, cy: number) => {
    const minX = Math.max(0, Math.floor(cx - r)); const maxX = Math.min(width - 1, Math.ceil(cx + r));
    const minY = Math.max(0, Math.floor(cy - r)); const maxY = Math.min(height - 1, Math.ceil(cy + r));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) pixels[y * width + x] = 0;
      }
    }
  };
  for (const stroke of strokes) {
    const points = stroke.map((point) => ({ x: point.x * scale + offsetX, y: point.y * scale + offsetY }));
    if (points.length === 1) stamp(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]; const b = points[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2));
      for (let s = 0; s <= steps; s++) stamp(a.x + ((b.x - a.x) * s) / steps, a.y + ((b.y - a.y) * s) / steps);
    }
  }
  return encodeGrayPng(width, height, pixels);
}
