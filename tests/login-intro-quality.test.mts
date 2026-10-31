import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * A entrada no sistema não tem mais abertura animada.
 *
 * Primeiro foi um MP4 comprimido, depois uma revelação do logotipo em CSS de
 * 2,4s. As duas tinham o mesmo defeito, que nenhum ajuste de qualidade
 * resolvia: ficavam entre quem acabou de digitar a senha e o sistema. Login é
 * ação de todo dia; animação de todo dia vira espera. Estes testes impedem a
 * abertura de voltar por qualquer um dos dois caminhos.
 */

test("o login navega direto, sem tela de abertura", async () => {
  const form = await readFile(new URL("../app/login/LoginForm.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(form, /LoginIntro|Abrindo o Vinculato/u, "a abertura voltou ao formulário de login");
  assert.match(form, /window\.location\.assign\(payload\.redirectTo \|\| "\/painel\?modulos=1"\)/u);

  await assert.rejects(
    access(new URL("../app/components/LoginIntroMotion.tsx", import.meta.url)),
    "o componente da abertura continua no repositório",
  );
  await assert.rejects(
    access(new URL("../public/brand/vinculato-intro-dark.mp4", import.meta.url)),
    "o vídeo da abertura continua publicado em public/brand",
  );
});

test("a folha de acesso não carrega mais a animação da abertura", async () => {
  const css = await readFile(new URL("../app/access.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /vin-intro/u, "sobrou regra da abertura em access.css");
});

test("a marca deixou de ser reencodada com perdas nas demais telas", async () => {
  const [config, logo] = await Promise.all([
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/VinculatoLogo.tsx", import.meta.url), "utf8"),
  ]);
  // A qualidade padrão do otimizador é 75, e é ela que franjava o logotipo na
  // barra lateral e no próprio login. Pedir 100 exige a lista no config: sem
  // ela o Next recusa o valor e a imagem nem chega a ser servida.
  assert.match(logo, /const BRAND_IMAGE_QUALITY = 100;/u);
  assert.match(config, /qualities:\s*\[75,\s*100\]/u);
  const quality = logo.match(/quality=\{BRAND_IMAGE_QUALITY\}/gu) ?? [];
  assert.equal(quality.length, 2, "o símbolo e o logotipo horizontal precisam pedir a qualidade da marca");
});
