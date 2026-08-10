export const revalidate = 31536000;

/**
 * A small, dependency-free ICO built at request/build time. Keeping this route
 * means browsers that still request `/favicon.ico` receive the Vinculato mark
 * instead of reaching the Next.js not-found route.
 */
function createFavicon() {
  const size = 16;
  const bitmapBytes = size * size * 4;
  const maskBytes = size * 4;
  const imageBytes = 40 + bitmapBytes + maskBytes;
  const bytes = new Uint8Array(22 + imageBytes);
  const view = new DataView(bytes.buffer);

  // ICO header and its single 16×16, 32-bit image directory entry.
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, 1, true);
  bytes[6] = size;
  bytes[7] = size;
  view.setUint16(10, 1, true);
  view.setUint16(12, 32, true);
  view.setUint32(14, imageBytes, true);
  view.setUint32(18, 22, true);

  const imageOffset = 22;
  view.setUint32(imageOffset, 40, true);
  view.setInt32(imageOffset + 4, size, true);
  view.setInt32(imageOffset + 8, size * 2, true);
  view.setUint16(imageOffset + 12, 1, true);
  view.setUint16(imageOffset + 14, 32, true);
  view.setUint32(imageOffset + 16, 0, true);
  view.setUint32(imageOffset + 20, bitmapBytes, true);

  const pixelOffset = imageOffset + 40;
  const putPixel = (x: number, y: number, red: number, green: number, blue: number) => {
    const offset = pixelOffset + ((size - 1 - y) * size + x) * 4;
    bytes[offset] = blue;
    bytes[offset + 1] = green;
    bytes[offset + 2] = red;
    bytes[offset + 3] = 255;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) putPixel(x, y, 14, 59, 59);
  }

  const drawBar = (left: number, top: number, width: number, height: number) => {
    for (let y = top; y < top + height; y += 1) {
      for (let x = left; x < left + width; x += 1) putPixel(x, y, 98, 213, 178);
    }
  };

  drawBar(3, 8, 2, 5);
  drawBar(7, 3, 2, 10);
  drawBar(11, 6, 2, 7);
  return bytes;
}

export function GET() {
  return new Response(createFavicon(), {
    headers: {
      "Content-Type": "image/x-icon",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
