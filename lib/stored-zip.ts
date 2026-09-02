/**
 * ZIP sem compressão, produzido em fluxo.
 *
 * Notas fiscais já chegam comprimidas (PDF, PNG, JPEG). Tentar comprimi-las
 * novamente só aumenta o uso de CPU e, pior, obrigaria a guardar cada arquivo
 * inteiro na memória antes de iniciar o download. O formato STORE mantém os
 * bytes originais e permite enviar uma nota por vez.
 */

export type StoredZipEntry = {
  name: string;
  size: number;
  body: ReadableStream<Uint8Array>;
  modifiedAt?: Date;
};

type CentralEntry = {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  dosDate: number;
  dosTime: number;
};

const encoder = new TextEncoder();
const ZIP32_MAX = 0xffff_ffff;
const ZIP_ENTRY_MAX = 0xffff;

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb8_8320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function updateCrc(crc: number, bytes: Uint8Array) {
  let current = crc;
  for (const byte of bytes) current = crcTable[(current ^ byte) & 0xff]! ^ (current >>> 8);
  return current >>> 0;
}

function binary(size: number, write: (view: DataView) => void) {
  const bytes = new Uint8Array(size);
  write(new DataView(bytes.buffer));
  return bytes;
}

function dosDateTime(value: Date) {
  const year = Math.min(2107, Math.max(1980, value.getFullYear()));
  const month = Math.min(12, Math.max(1, value.getMonth() + 1));
  const day = Math.min(31, Math.max(1, value.getDate()));
  const hours = Math.min(23, Math.max(0, value.getHours()));
  const minutes = Math.min(59, Math.max(0, value.getMinutes()));
  const seconds = Math.min(59, Math.max(0, value.getSeconds()));
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | Math.floor(seconds / 2),
  };
}

function localHeader(nameLength: number, dosDate: number, dosTime: number) {
  return binary(30, (view) => {
    view.setUint32(0, 0x0403_4b50, true);
    view.setUint16(4, 20, true);
    // Data descriptor + nomes UTF-8.
    view.setUint16(6, 0x0808, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, dosTime, true);
    view.setUint16(12, dosDate, true);
    view.setUint16(26, nameLength, true);
  });
}

function dataDescriptor(crc: number, size: number) {
  return binary(16, (view) => {
    view.setUint32(0, 0x0807_4b50, true);
    view.setUint32(4, crc, true);
    view.setUint32(8, size, true);
    view.setUint32(12, size, true);
  });
}

function centralHeader(entry: CentralEntry) {
  return binary(46, (view) => {
    view.setUint32(0, 0x0201_4b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0808, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, entry.dosTime, true);
    view.setUint16(14, entry.dosDate, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.size, true);
    view.setUint32(24, entry.size, true);
    view.setUint16(28, entry.name.length, true);
    view.setUint32(42, entry.offset, true);
  });
}

function endOfCentralDirectory(entries: number, centralSize: number, centralOffset: number) {
  return binary(22, (view) => {
    view.setUint32(0, 0x0605_4b50, true);
    view.setUint16(8, entries, true);
    view.setUint16(10, entries, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
  });
}

function validateEntries(entries: StoredZipEntry[]) {
  if (entries.length > ZIP_ENTRY_MAX) throw new Error("O ZIP ultrapassa o limite de 65.535 arquivos.");
  let total = 22;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > ZIP32_MAX) {
      throw new Error(`O arquivo ${entry.name} ultrapassa o limite do formato ZIP.`);
    }
    const name = encoder.encode(entry.name);
    if (name.length === 0 || name.length > ZIP_ENTRY_MAX) throw new Error("Nome de arquivo inválido para o ZIP.");
    total += 30 + name.length + entry.size + 16 + 46 + name.length;
    if (total > ZIP32_MAX) throw new Error("O conjunto de notas ultrapassa o limite de 4 GB do formato ZIP.");
  }
  return total;
}

async function* zipChunks(entries: StoredZipEntry[]) {
  const central: CentralEntry[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const { date, time } = dosDateTime(entry.modifiedAt ?? new Date());
    const header = localHeader(name.length, date, time);
    const localOffset = offset;
    yield header;
    yield name;
    offset += header.length + name.length;

    let crc = 0xffff_ffff;
    let actualSize = 0;
    const reader = entry.body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const bytes = chunk.value instanceof Uint8Array ? chunk.value : new Uint8Array(chunk.value);
        actualSize += bytes.length;
        if (actualSize > ZIP32_MAX) throw new Error(`O arquivo ${entry.name} ultrapassa o limite do formato ZIP.`);
        crc = updateCrc(crc, bytes);
        yield bytes;
      }
    } finally {
      reader.releaseLock();
    }
    if (actualSize !== entry.size) throw new Error(`O tamanho de ${entry.name} mudou durante o download.`);

    const finalCrc = (crc ^ 0xffff_ffff) >>> 0;
    const descriptor = dataDescriptor(finalCrc, actualSize);
    yield descriptor;
    offset += actualSize + descriptor.length;
    central.push({ name, crc: finalCrc, size: actualSize, offset: localOffset, dosDate: date, dosTime: time });
  }

  const centralOffset = offset;
  for (const entry of central) {
    const header = centralHeader(entry);
    yield header;
    yield entry.name;
    offset += header.length + entry.name.length;
  }
  const centralSize = offset - centralOffset;
  yield endOfCentralDirectory(central.length, centralSize, centralOffset);
}

export function createStoredZip(entries: StoredZipEntry[]) {
  const size = validateEntries(entries);
  const iterator = zipChunks(entries);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await iterator.next();
        if (chunk.done) controller.close(); else controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  return { stream, size };
}
