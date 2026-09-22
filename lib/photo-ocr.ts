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
 * ## O teto de tamanho é do próprio arquivo, sem redimensionar
 *
 * A cota gratuita do OCR.space limita o arquivo a 1 MB — bem abaixo do que
 * uma foto de celular normalmente pesa. Uma primeira versão deste módulo
 * usava `sharp` para reorientar e recomprimir a foto antes de enviar, mas o
 * binário nativo dele não carrega no runtime serverless da Vercel
 * (`ERR_DLOPEN_FAILED`) — e como este módulo é importado pela mesma rota que
 * lê a ficha em PDF, a falha de carregamento derrubava a ficha inteira, não
 * só a leitura da foto. A foto grande demais agora é recusada com uma
 * mensagem clara, em vez de arriscar quebrar o resto da rota.
 *
 * ## O que NÃO acontece aqui
 *
 * Este módulo só devolve texto bruto. Interpretar esse texto em campos —
 * CPF, nome, data — é `photo-document-fields.ts`, e nasce como sugestão, não
 * como fato. Ver o comentário daquele módulo para a regra completa.
 */
import { ApiError } from "./api-errors.ts";

const OCR_SPACE_ENDPOINT = "https://api.ocr.space/parse/image";
/** Teto real da cota gratuita do OCR.space — não há redimensionamento para caber nele. */
const MAX_IMAGE_BYTES = 1024 * 1024;

const allowedContentTypes = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
const extensionByContentType: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp",
};

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

/** Envia a imagem ao OCR.space e devolve o texto que ele reconheceu. */
export async function runDocumentOcr(input: { bytes: Uint8Array; contentType: string }): Promise<string> {
  const apiKey = String(process.env.FDP_OCR_SPACE_API_KEY ?? "").trim();
  if (!apiKey) throw new PhotoOcrError("OCR_NOT_CONFIGURED", "O OCR de fotos não está configurado neste ambiente.");
  const contentType = input.contentType.trim().toLowerCase();
  if (!allowedContentTypes.has(contentType)) {
    throw new PhotoOcrError("OCR_UNSUPPORTED_TYPE", "Este tipo de arquivo não é uma foto suportada para OCR.");
  }
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new PhotoOcrError("OCR_IMAGE_SIZE_INVALID",
      "A foto está vazia ou passa de 1 MB — o teto da cota gratuita do OCR.space. Reduza o tamanho e anexe de novo.");
  }

  const form = new FormData();
  form.set("apikey", apiKey);
  form.set("language", "por");
  form.set("OCREngine", "2");
  form.set("scale", "true");
  form.set("detectOrientation", "true");
  form.set("isOverlayRequired", "false");
  form.set("file", new Blob([new Uint8Array(input.bytes)], { type: contentType }),
    `documento.${extensionByContentType[contentType]}`);

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
