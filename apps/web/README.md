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
- **Versão nova.** O worker novo espera; o app mostra "Nova versão disponível". A troca (`SKIP_WAITING`) acontece por três
  caminhos, sem derrubar o uso: o toque no aviso; o primeiro momento seguro (a próxima navegação concluída ou a aba indo
  para segundo plano), sem esperar a pessoa parar nem um intervalo mínimo; e a próxima abertura a frio (o worker que espera
  ativa sozinho quando a última página dele fecha). Os dois primeiros só valem com a tela limpa (`UnsavedWork`: editor
  sujo, escrita em voo, treino aberto na tela do dia ou do exercício, fila offline enviando) e com as outras abas conferidas
  por `BroadcastChannel` (`tab-busy.ts`, pergunta estrita). A troca automática só acontece com o app aberto numa janela só
  (uma outra janela que dissesse "livre" poderia começar um treino antes da ativação); com mais de uma, fica o aviso. Quantas existem vem do worker que espera (`sw-clients.ts`: `clients.matchAll` com `includeUncontrolled`, a lista
  autoritativa, que enxerga até a janela de uma versão anterior sem o bloqueio de abas); o bloqueio compartilhado só soma.
  Ocupada, silêncio, worker que não responde à lista, janela de quem pergunta fora dela, falta de `BroadcastChannel` ou de
  `MessageChannel` contam como ocupado e a troca espera, com o aviso à vista (o toque no aviso segue como sempre: quem não
  responde conta como livre). Uma troca automática que
  não pega não vira laço (guarda de 2 min no `sessionStorage`). O worker só toma as páginas abertas (`clients.claim`) na
  primeira instalação ou depois desse pedido (`core/pwa/sw-claim.ts`), nunca por conta própria no meio de uma operação. A aba
  à vista busca versão nova a cada 15 min. O registro (`core/pwa/register-sw.ts`) só acontece em produção.
- **Arquivos com hash de versões anteriores.** Uma página aberta de antes do deploy ainda pede os pedaços da versão que
  carregou. A API responde 404 (nunca o `index.html`) a caminho com extensão que não existe e envia
  `Cache-Control: immutable` nos arquivos com hash (`PwaCachePolicy`); e a imagem retém os das últimas 3 versões no
  `wwwroot`. O workflow `web-assets.yml` (chamado pelo job `web-assets` do `deploy.yml` depois de cada publicação)
  anexa ao Release o artefato `web-assets-<versão>.tar.gz` (só `main`, `polyfills`, `styles` e `chunk` com hash, nunca
  `index.html` nem `sw.js`), e a etapa `retained` do `Dockerfile` baixa os anteriores com `scripts/retained-assets.mjs`
  (`RETAIN_RELEASES=0` desliga). Teste: `node --test scripts/retained-assets.test.mjs`.
  - **Rodar antes da primeira publicação com retenção.** A imagem só retém o que já está anexado a um Release, e o primeiro
    artefato só nasce depois da primeira publicação. Para a versão que está no ar não ficar sem arquivos retidos, rode
    manualmente o workflow `web-assets.yml` (`workflow_dispatch`) com a tag dela (ex.: `v0.54.0`) ANTES de publicar. Ele
    monta o PWA com o Dockerfile e o script do ramo sobre o código da tag, confere contra a página no ar e anexa ao Release.
  - **Melhor esforço, de propósito.** Se o GitHub estiver fora (ou com limite de requisições) durante o build da imagem, a
    publicação segue só com os arquivos da versão atual: não se trava a publicação por isso. A falha não passa em silêncio:
    o log do build mostra linhas `AVISO retenção:` e uma faixa final, e depois de publicar o `web-assets.yml` confere no ar
    (`check-live`: o `main` de cada versão anterior e uma amostra dos demais respondem 200) e emite `::warning::` do
    GitHub Actions se algum faltar.
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
  O único estilo em linha é a base mínima do esqueleto de abertura, sempre com esse nonce, para pintar antes da folha
  externa; não há script em linha, e o critical CSS do Angular fica desligado (`inlineCritical: false`).
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
