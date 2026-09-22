/**
 * OCR de uma foto de documento, via Google Cloud Vision.
 *
 * ## Por que um serviço de nuvem, e não um motor local
 *
 * Decisão do DP: a precisão importa mais do que manter a foto dentro do
 * próprio servidor — fotos de celular vêm tortas, com reflexo e má
 * iluminação, e um motor local (Tesseract) erra muito mais nessas condições.
 * A implicação é real e deliberada: a foto do documento (RG, CPF, CTPS) sai
 * do Vinculato e vai para o Google processar. Nenhuma outra chamada deste
 * módulo depende de mais nada do Google — só esta.
 *
 * ## O que NÃO acontece aqui
 *
 * Este módulo só devolve texto bruto. Interpretar esse texto em campos —
 * CPF, nome, data — é `photo-document-fields.ts`, e nasce como sugestão, não
 * como fato. Ver o comentário daquele módulo para a regra completa.
 */
import { ApiError } from "./api-errors.ts";

const VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const allowedContentTypes = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

export function ocrConfigured() {
  return Boolean(String(process.env.FDP_OCR_GOOGLE_VISION_API_KEY ?? "").trim());
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
 * Envia a imagem ao Google Vision e devolve o texto que ele reconheceu.
 *
 * `DOCUMENT_TEXT_DETECTION` é o modo do Vision voltado a documento denso
 * (em vez de `TEXT_DETECTION`, pensado para poucas palavras numa cena) — é
 * o que a documentação do Google recomenda para digitalização de formulário
 * e documento de identidade.
 */
export async function runDocumentOcr(input: { bytes: Uint8Array; contentType: string }): Promise<string> {
  const apiKey = String(process.env.FDP_OCR_GOOGLE_VISION_API_KEY ?? "").trim();
  if (!apiKey) throw new PhotoOcrError("OCR_NOT_CONFIGURED", "O OCR de fotos não está configurado neste ambiente.");
  const contentType = input.contentType.trim().toLowerCase();
  if (!allowedContentTypes.has(contentType)) {
    throw new PhotoOcrError("OCR_UNSUPPORTED_TYPE", "Este tipo de arquivo não é uma foto suportada para OCR.");
  }
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new PhotoOcrError("OCR_IMAGE_SIZE_INVALID", "A foto está vazia ou é grande demais para o OCR.");
  }

  const body = {
    requests: [{
      image: { content: Buffer.from(input.bytes).toString("base64") },
      features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
      imageContext: { languageHints: ["pt"] },
    }],
  };

  const response = await fetch(`${VISION_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new PhotoOcrError("OCR_HTTP_ERROR", `O Google Vision devolveu erro HTTP ${response.status}.`);
  }
  const payload = await response.json().catch(() => null) as {
    responses?: Array<{ fullTextAnnotation?: { text?: string }; error?: { message?: string } }>;
  } | null;
  const first = payload?.responses?.[0];
  if (first?.error) throw new PhotoOcrError("OCR_VISION_ERROR", first.error.message || "O Google Vision não conseguiu ler a foto.");
  return String(first?.fullTextAnnotation?.text ?? "");
}

export function photoOcrError(cause: unknown) {
  if (cause instanceof PhotoOcrError) return new ApiError(422, cause.code, cause.message);
  return new ApiError(500, "OCR_UNKNOWN_ERROR", "Não foi possível concluir o OCR da foto.");
}

export { PhotoOcrError };
