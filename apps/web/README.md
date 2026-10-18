# UniOver Web (PWA)

Angular 22, standalone, zoneless, signals. Builder `@angular/build` (esbuild), testes com Vitest, e2e com Playwright.
Node `^24.15.0 || ^26`. TypeScript fixado em `~6.0`.

## Comandos

| Comando                 | O que faz                                                                    |
| ----------------------- | ---------------------------------------------------------------------------- |
| `npm start`             | `ng serve` com proxy de `/api` e `/health` para `http://localhost:5080`      |
| `npm run build`         | build de produção em `dist/web/browser` (o que a imagem Docker copia)        |
| `npm run lint`          | ESLint: Angular, acessibilidade de template, i18n e fronteiras entre módulos |
| `npm test`              | testes unitários (Vitest, sem watch)                                         |
| `npm run test:coverage` | idem, com cobertura                                                          |
| `npm run e2e`           | Playwright: `iphone-12` (WebKit, 390x664) e `s23-fe` (Chromium, 411x800)     |
| `npm run format:check`  | confere o Prettier                                                           |

Primeira vez: `npm ci` e `npx playwright install chromium webkit`. Os prints do e2e ficam em `test-results/` (não versionados).

## Estrutura

```
src/app/
  core/        tema, configuração (depois: autenticação, interceptadores, fila offline)
  shared/ui/   componentes visuais sem regra de negócio
  modules/
    home/      rota /       grade de módulos
    tv/        rota /tv
    training/  rota /treino
```

Cada módulo é uma rota preguiçosa declarada em `app.routes.ts` (`loadChildren`).

## Regra de fronteira

`modules/a` nunca importa de `modules/b`; só de `core/` e `shared/`. Imposto por `eslint-plugin-boundaries`
(`boundaries/dependencies` em `eslint.config.js`). Vale também para `import()` dinâmico.

## i18n

Idioma-fonte `pt-BR`. Texto em template leva o atributo `i18n` (id estável `@@modulo.chave`); texto em código usa
`` $localize`:@@id:Texto` ``. A regra `@angular-eslint/template/i18n` falha o lint para texto fixo.
O aviso "Locale data for 'pt-BR' cannot be found" do build é esperado: o Angular usa os dados da locale `pt`.

## Tema

Paleta p2 (verde-sálvia), claro e escuro, em `src/styles.css`. `ThemeService` segue `prefers-color-scheme` e grava
`data-theme` em `<html>`.
