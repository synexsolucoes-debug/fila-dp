/**
 * Configuração do cartão de compartilhamento, sem efeito colateral.
 *
 * Existe separado do gerador por um motivo aprendido na CI: a primeira versão
 * deixava estas constantes dentro de `generate-og-image.mjs`, e o teste as
 * importava de lá. Só que aquele arquivo **executa ao ser importado** — abre o
 * Chromium, lê o build, grava a imagem. Localmente passava, porque o build e o
 * navegador estavam ali. Na CI os testes rodam antes do build, e o import
 * derrubou a suíte inteira.
 *
 * Um módulo de configuração não pode fazer nada ao ser carregado. Este não faz.
 */

/** Onde o cartão é gravado. O layout aponta para cá; o teste confere os dois. */
export const SAIDA = "public/og-vinculato.jpg";

/**
 * Teto de peso. O cartão anterior tinha 1,4 MB — acima do que aplicativo de
 * mensagem aceita para montar a pré-visualização rica, que é justamente onde um
 * link de produto de DP circula no Brasil.
 */
export const LIMITE_BYTES = 300 * 1024;

/** 1200×630 é a proporção que WhatsApp, LinkedIn, Slack e X recortam sem cortar. */
export const LARGURA = 1200;
export const ALTURA = 630;
