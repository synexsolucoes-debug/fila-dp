# Vinculato Campo — app Expo (iPhone e Android)

App nativo de controle de EPI para o SESMT e o almoxarifado. Usa as mesmas
rotas e permissões do painel; nada novo no banco.

| Operação | SESMT |
|---|---|
| Entregar EPI (assinatura com o dedo, leitor de crachá/código) | Vencimentos e trocas (quadros que filtram, entrega já preenchida) |
| Receber devolução (destino calculado antes de gravar) | Estoque (saldo do local, entrada, transferência) |
| Registrar dano (foto da câmera) | Higienização e descarte |
| Consultar colaborador | Pendências de envio (fila sem rede) |

## Rodar

```bash
cd mobile
npm install
npx expo start            # mesma rede Wi-Fi do celular
npx expo start --tunnel   # celular em outra rede (precisa de `npm i -g @expo/ngrok`)
```

Leia o QR code com o **Expo Go** (iPhone: câmera do sistema; Android: o
próprio Expo Go). No iPhone, o Expo Go e o `expo start` precisam estar logados
na **mesma conta Expo** (`npx expo login`).

> **Atenção — iPhone.** A documentação atual do Expo diz que, para instalar o
> Expo Go num iPhone, é preciso uma assinatura do Apple Developer Program
> (o Expo Go é gerado com `npx eas-cli@latest go` e instalado pelo TestFlight).
> Distribuir à equipe sem a conta Apple paga não é um caminho garantido. Com a
> conta (US$ 99/ano), o mesmo código vira um app próprio no TestFlight
> (`npx eas-cli@latest build -p ios`), sem reescrever nada.

## Login e servidor

E-mail e senha do Vinculato. O endereço padrão é `https://vinculato.vercel.app`
(`app.json` › `extra.defaultServer`) e pode ser trocado na tela de login em
"Outro endereço do Vinculato" — útil para testar uma prévia da Vercel.

O login usa `POST /api/auth/login` com `client: "app"`: as mesmas verificações
do site, com o token na resposta em vez de cookie. O token fica no chaveiro do
iPhone (SecureStore), vai em `Authorization: Bearer` e aparece no painel em
**Sessões** como "Vinculato Campo · app", de onde pode ser encerrado.

## Como está organizado

- `src/app/` — telas (Expo Router). `_layout.tsx` separa login e telas de trabalho.
- `src/lib/api.ts` — cliente da API (token + cabeçalho `x-vinculato-client`).
- `src/lib/queue.ts` — fila sem rede com chave de idempotência; anexo depois do registro.
- `src/lib/png.ts` — codificador PNG próprio para a assinatura (sem módulo nativo).
- `src/lib/*.web.ts` — armazenamento da prévia web; no aparelho valem os arquivos sem `.web`.

As regras **não são copiadas**: `lib/epi.ts`, `lib/epi-compliance.ts`,
`app/campo/sesmt.logic.ts` e os normalizadores do painel vêm da raiz do
repositório pelo apelido `@/` (`tsconfig.json` + `metro.config.js`).

## Verificar

```bash
npm run typecheck           # tsc
npm test                    # PNG decodificado pelo zlib do Node
npm run export:ios          # empacota para iOS: pega import quebrado sem precisar de aparelho
npx expo export --platform web --output-dir dist-web   # prévia web das telas
```
