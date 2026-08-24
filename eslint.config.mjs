import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    /* Linha gigante (§48).
     *
     * Algumas rotas de Processos tinham a lógica inteira em uma única linha de
     * 2.800 caracteres. Isso não é estilo: um diff de uma linha esconde a
     * mudança e torna a revisão impossível de fazer de verdade.
     *
     * O limite é folgado de propósito e ignora justamente o que legitimamente
     * fica longo — SQL, URL, mensagem ao usuário, expressão regular. O alvo é
     * código encadeado sem quebra, não texto comprido.
     */
    files: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}", "db/**/*.ts", "worker/**/*.ts"],
    rules: {
      "max-len": ["error", {
        code: 400,
        tabWidth: 2,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreRegExpLiterals: true,
        ignoreUrls: true,
        ignoreComments: true,
      }],
    },
  },
]);

export default eslintConfig;
