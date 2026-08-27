# Origem das skills

Skills copiadas de repositórios externos. Não edite os arquivos diretamente:
para atualizar, recopie do upstream e registre a mudança aqui.

| Skill | Origem | Licença |
|---|---|---|
| `frontend-design` | [anthropics/claude-code](https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design/skills/frontend-design) | `frontend-design/LICENSE.txt` |
| `animate` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT — `LICENSE.emilkowalski-skills.txt` |
| `animate-expo` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT — `LICENSE.emilkowalski-skills.txt` |
| `animation-vocabulary` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT — `LICENSE.emilkowalski-skills.txt` |
| `apple-design` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT — `LICENSE.emilkowalski-skills.txt` |
| `ask-sonner` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT — `LICENSE.emilkowalski-skills.txt` |
| `emil-design-eng` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT — `LICENSE.emilkowalski-skills.txt` |
| `find-animation-opportunities` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT — `LICENSE.emilkowalski-skills.txt` |
| `improve-animations` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT — `LICENSE.emilkowalski-skills.txt` |
| `pick-ui-library` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT — `LICENSE.emilkowalski-skills.txt` |
| `prototype` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT — `LICENSE.emilkowalski-skills.txt` |
| `review-animations` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT — `LICENSE.emilkowalski-skills.txt` |
| `write-swift` | [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT — `LICENSE.emilkowalski-skills.txt` |

## Skills carregadas como plugin

Não estão neste diretório: são declaradas em `../settings.json` e o Claude Code
baixa cada uma do repositório de origem.

| Plugin | Origem | Skills | Licença |
|---|---|---|---|
| `ui-ux-pro-max@ui-ux-pro-max-skill` | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `ui-ux-pro-max` | MIT |
| `taste-skill@taste-skill` | [leonxlnx/taste-skill](https://github.com/leonxlnx/taste-skill) | `design-taste-frontend`, `design-taste-frontend-v1`, `industrial-brutalist-ui`, `minimalist-ui`, `high-end-visual-design`, `redesign-existing-projects`, `stitch-design-taste`, `gpt-taste`, `image-to-code`, `imagegen-frontend-web`, `imagegen-frontend-mobile`, `brandkit`, `full-output-enforcement` | MIT |

Nenhum dos dois está fixado em `ref`/`sha`, então ambos acompanham o branch
padrão do upstream.

## Skills fora do stack deste projeto

`animate-expo` (React Native/Expo) e `write-swift` (Swift/SwiftUI) vieram junto no
repositório de origem, mas não se aplicam a este projeto (Next.js + React + Tailwind).
`ask-sonner` só passa a valer se o projeto adotar o [Sonner](https://sonner.emilkowal.ski).
