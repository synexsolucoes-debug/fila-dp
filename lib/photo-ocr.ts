/**
 * OCR de uma foto de documento, via OCR.space.
 *
 * ## Por que este provedor, e não outro
 *
 * Decisão do DP: entre um motor local (Tesseract, que erra muito mais em
 * foto de celular torta, com reflexo ou mal iluminada) e um serviço de
 * nuvem, a nuvem venceu. Entre serviços de nuvem, o Google Cloud Vision lê
 * melhor, mas exige cartão de crédito cadastrado mesmo para usar a cota
 * gratuita — o OCR.space não exige (só um email, para gerar a chave), e por
 * isso foi o escolhido. A implicação de qualquer um dos dois é a mesma e é
 * deliberada: a foto do documento (RG, CPF, CTPS) sai do Vinculato e vai
 * para o provedor processar.
 *
 * ## A normalização antes de enviar
 *
 * A cota gratuita do OCR.space tem teto de tamanho de arquivo (1 MB) — bem
 * abaixo do que uma foto de celular normalmente pesa (2-8 MB). Em vez de
 * simplesmente recusar a maioria das fotos reais, este módulo usa `sharp`
 * (já uma dependência do projeto) para reorientar pelo EXIF, redimensionar e
 * recomprimir antes de enviar — o mesmo passo também corrige foto virada de
 * lado, que atrapalha a leitura tanto quanto o tamanho do arquivo.
 *
 * ## O que NÃO acontece aqui
 *
 * Este módulo só devolve texto bruto. Interpretar esse texto em campos —
 * CPF, nome, data — é `photo-document-fields.ts`, e nasce como sugestão, não
 * como fato. Ver o comentário daquele módulo para a regra completa.
 */
import sharp from "sharp";
import { ApiError } from "./api-errors.ts";

const OCR_SPACE_ENDPOINT = "https://api.ocr.space/parse/image";
/** Sanidade sobre o que aceitamos como foto de entrada, antes de normalizar. */
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
/** Margem abaixo do teto de 1 MB da cota gratuita do OCR.space. */
const MAX_UPLOAD_BYTES = 900 * 1024;
const MAX_DIMENSION = 2000;

const allowedContentTypes = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

export function ocrConfigured() {
  return Boolean(String(process.env.FDP_OCR_SPACE_API_KEY ?? "").trim());
}

class PhotoOcrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PhotoOcrError";
    this.code = code;
  }
}

/**
 * Reorienta pelo EXIF, redimensiona e recomprime até caber no teto de upload.
 * Sempre devolve JPEG — o que também resolve o suporte a WebP, que o
 * OCR.space não documenta como aceito.
 */
async function normalizeForUpload(bytes: Uint8Array): Promise<Buffer> {
  let quality = 85;
  let last: Buffer | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    last = await sharp(Buffer.from(bytes))
      .rotate()
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    if (last.byteLength <= MAX_UPLOAD_BYTES) return last;
    quality -= 15;
  }
  return last as Buffer;
}

/** Envia a imagem ao OCR.space e devolve o texto que ele reconheceu. */
export async function runDocumentOcr(input: { bytes: Uint8Array; contentType: string }): Promise<string> {
  const apiKey = String(process.env.FDP_OCR_SPACE_API_KEY ?? "").trim();
  if (!apiKey) throw new PhotoOcrError("OCR_NOT_CONFIGURED", "O OCR de fotos não está configurado neste ambiente.");
  const contentType = input.contentType.trim().toLowerCase();
  if (!allowedContentTypes.has(contentType)) {
    throw new PhotoOcrError("OCR_UNSUPPORTED_TYPE", "Este tipo de arquivo não é uma foto suportada para OCR.");
  }
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_SOURCE_BYTES) {
    throw new PhotoOcrError("OCR_IMAGE_SIZE_INVALID", "A foto está vazia ou é grande demais para o OCR.");
  }

  let normalized: Buffer;
  try {
    normalized = await normalizeForUpload(input.bytes);
  } catch {
    throw new PhotoOcrError("OCR_IMAGE_UNREADABLE", "Não foi possível processar esta foto.");
  }

  const form = new FormData();
  form.set("apikey", apiKey);
  form.set("language", "por");
  form.set("OCREngine", "2");
  form.set("scale", "true");
  form.set("detectOrientation", "true");
  form.set("isOverlayRequired", "false");
  form.set("file", new Blob([new Uint8Array(normalized)], { type: "image/jpeg" }), "documento.jpg");

  const response = await fetch(OCR_SPACE_ENDPOINT, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new PhotoOcrError("OCR_HTTP_ERROR", `O OCR.space devolveu erro HTTP ${response.status}.`);
  }
  const payload = await response.json().catch(() => null) as {
    IsErroredOnProcessing?: boolean;
    ErrorMessage?: string | string[];
    ParsedResults?: Array<{ ParsedText?: string }>;
  } | null;
  if (!payload || payload.IsErroredOnProcessing) {
    const detail = Array.isArray(payload?.ErrorMessage) ? payload.ErrorMessage.join("; ") : payload?.ErrorMessage;
    throw new PhotoOcrError("OCR_PROVIDER_ERROR", detail || "O OCR.space não conseguiu ler a foto.");
  }
  return (payload.ParsedResults ?? []).map((result) => result.ParsedText ?? "").join("\n");
}

export function photoOcrError(cause: unknown) {
  if (cause instanceof PhotoOcrError) return new ApiError(422, cause.code, cause.message);
  return new ApiError(500, "OCR_UNKNOWN_ERROR", "Não foi possível concluir o OCR da foto.");
}

export { PhotoOcrError };
