# UniOver Web (PWA)

Angular 22, standalone, zoneless, signals. Builder `@angular/build` (esbuild), testes com Vitest, e2e com Playwright.
Node `^24.15.0 || ^26`. TypeScript fixado em `~6.0`.

## Comandos

| Comando                 | O que faz                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `npm start`             | `ng serve` com proxy de `/api` e `/health` para `http://localhost:5080`                           |
| `npm run build`         | build de produção em `dist/web/browser` e geração do service worker (o que a imagem Docker copia) |
| `npm run lint`          | ESLint (Angular, acessibilidade, i18n, fronteiras entre módulos) e tipos do service worker        |
| `npm test`              | testes unitários (Vitest, sem watch)                                                              |
| `npm run test:coverage` | idem, com cobertura                                                                               |
| `npm run e2e`           | Playwright: `iphone-12` (WebKit, 390x664) e `s23-fe` (Chromium, 411x800)                          |
| `npm run format:check`  | confere o Prettier                                                                                |
| `npm run audit:pwa`     | Lighthouse sobre o build (precisa de Chrome; use `CHROME_PATH` se não achar)                      |
| `npm run serve:dist`    | serve o build em `http://localhost:4300` como a API serve (CSP e nonce)                           |

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

## Casca, service worker e auditoria

- **Build do service worker.** `npm run build` roda `ng build` e depois `scripts/build-sw.mjs`: empacota `src/sw.ts`
  com esbuild e injeta a lista de arquivos da casca (`workbox-build`, `injectManifest`) em `dist/web/browser/sw.js`.
  O `index.html` cru não entra no precache, porque tem marcadores que só o servidor troca; as páginas `/`, `/tv/` e
  `/treino/` são buscadas do servidor na instalação, já com o manifest do módulo e o nonce da CSP. Um roteador de
  navegação por escopo mantém o manifest certo ao recarregar dentro de um módulo, online ou offline.
- **API fora do cache.** `/api/**` usa `NetworkOnly`; escrita offline é da fila do app, não do worker.
- **Versão nova.** O worker novo espera; o app mostra "Nova versão disponível" e só troca quando o usuário aceita
  (`SKIP_WAITING`). O registro (`core/pwa/register-sw.ts`) só acontece em produção.
- **Atualizar de verdade.** Ao tocar em "Atualizar", `PwaUpdateService` cobre a tela com um esqueleto (`update-skeleton.ts`),
  pede o `SKIP_WAITING`, **espera o `controllerchange`** (prazo de 8 s), apaga os caches de execução (todos menos o precache
  `workbox-precache*` e `exercise-art`) e só então recarrega, uma vez. Sem worker esperando, pede `registration.update()` e
  espera a instalação. Nunca desregistra o worker. Se um pedaço de código da casca antiga já não existe (deploy trocou os
  nomes), `chunk-error.ts` reconhece o erro (rota e `ErrorHandler`) e atualiza pelo mesmo caminho, uma vez por minuto no
  máximo (guarda no `sessionStorage`); depois de uma atualização, um vigia recarrega uma vez se o primeiro conteúdo não vier.
- **Teste da atualização.** `e2e/update/stale-shell.spec.ts` liga `e2e/server/two-versions-server.mjs`, que serve o build e,
  no meio do teste, uma cópia com outro hash em todos os arquivos (`next-version.mjs`), com worker lento e API lenta.
  Roda no `npm run e2e` e sozinho com `npx playwright test -c playwright.update.config.ts` (`UPDATE_E2E_DIST` aponta para
  outro build; com `UPDATE_E2E_LEGACY=1` não exige o esqueleto, para ver a falha num build anterior ao conserto).
- **CSP.** `index.html` leva `ngCspNonce="__CSP_NONCE__"` e o marcador do manifest; o servidor troca os dois.
  Nenhum `<script>` ou `<style>` em linha, e o critical CSS do Angular fica desligado (`inlineCritical: false`).
- **Servidor de teste.** `e2e/server/static-server.mjs` serve o `dist` com fallback para o `index.html`, troca o
  nonce e o manifest e envia a mesma CSP da API. Cópia manual: pode divergir da API, então o teste contra o contêiner
  real repete a checagem. O e2e falha com qualquer violação de CSP, online ou offline.
- **Auditoria.** `npm run audit:pwa` roda o Lighthouse (`lighthouserc.json`: acessibilidade >= 0,95, boas práticas
  > = 0,9, desempenho como aviso) e, quando existir, `scripts/audit-manifests.mjs`. A categoria "PWA" não existe mais
  > no Lighthouse 12+; a conferência de PWA fica por conta do e2e e do script de manifests.
- **Módulos.** `core/modules/` guarda o catálogo (`ModuleRegistry`) e as preferências da Início (`ModulePrefs`, só
  neste aparelho, em `localStorage`). Para um módulo novo com escopo próprio, acrescente o caminho em
  `core/modules/module-slugs.ts` (o service worker, o servidor de teste e o build leem a mesma lista).
- **Conexão.** `ConnectivityService` separa "sem rede" de "servidor acordando": a cortina só aparece com o navegador
  online e a requisição falhando; espera até 300 s consultando `/health/live` a cada 3 s.
