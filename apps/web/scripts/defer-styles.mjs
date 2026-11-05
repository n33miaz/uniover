// Põe o esqueleto estático na primeira pintura. O Angular emite um <link rel="stylesheet"> comum, que bloqueia a
// renderização, e as formas do esqueleto vivem nessa mesma folha externa: o HTML chega com os ossos, mas nada aparece
// até a folha inteira (50 kB) chegar, ~0,6 s depois numa conexão lenta. Este passo, depois do `ng build` e antes do
// build-sw.mjs (a revisão do service worker vem do index.html final):
//   1. copia para um <style> do próprio HTML só o que o esqueleto usa (base do styles.css + boot-skeleton.css,
//      minificados), com o nonce que o servidor troca, e então ele pinta junto com o HTML;
//   2. marca a folha principal com media="print": o navegador a baixa sem bloquear a pintura. O boot-skeleton.js
//      (arquivo próprio: a CSP não admite código em linha nem onload) a liga ao carregar e avisa o app.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const indexFile = join(webRoot, 'dist', 'web', 'browser', 'index.html');

/**
 * O começo do styles.css (paleta, escalas, sombras, base de html/body e a calha da barra de rolagem de quem tem mouse)
 * vai até a primeira regra de tipografia. Com a base completa, quando a folha externa chega nada do esqueleto muda de
 * tamanho nem de lugar.
 */
const BASE_END = '\nh1,\nh2 {';
/**
 * Do resto do styles.css, só o que o esqueleto e o aviso de falha usam: o brilho (`ui-skeleton` e `ui-wait`, com os
 * quadros-chave e o movimento reduzido), o aviso (`ui-notice`), o botão (`ui-btn`) e o texto só para leitor de tela.
 * Vão no mesmo <style>, antes da folha externa, que repete as mesmas regras e por isso nunca perde na cascata.
 */
const KEPT_SELECTOR =
  /^(\.ui-skeleton|\.ui-wait|html\.has-boot-skeleton|\.ui-notice|\.ui-btn|\.ui-visually-hidden)(\.[\w-]+)*$/;
const KEPT_KEYFRAMES = /^@keyframes ui-(shimmer|pulse|wait-in)$/;

/** As regras do primeiro nível de um CSS (sem comentários): prelúdio e texto inteiro de cada uma. */
function topLevelRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let depth = 0;
  let start = 0;
  let open = -1;
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (char === '{') {
      if (depth === 0) open = i;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        rules.push({
          prelude: clean.slice(start, open).trim().replace(/\s+/g, ' '),
          text: clean.slice(start, i + 1),
        });
        start = i + 1;
      }
    }
  }
  return rules;
}

function keptRules(css) {
  return topLevelRules(css)
    .filter(
      ({ prelude, text }) =>
        KEPT_SELECTOR.test(prelude) ||
        KEPT_KEYFRAMES.test(prelude) ||
        (prelude === '@media (prefers-reduced-motion: reduce)' && text.includes('.ui-skeleton')),
    )
    .map(({ text }) => text)
    .join('\n');
}
const SCRIPT_MARK = '<script src="boot-skeleton.js" defer';
const CRITICAL_MARK = 'data-boot-critical';

const html = await readFile(indexFile, 'utf8');
if (html.includes(CRITICAL_MARK)) {
  console.log('[styles] index.html já tem o esqueleto na primeira pintura');
  process.exit(0);
}

const styles = await readFile(join(webRoot, 'src', 'styles.css'), 'utf8');
const end = styles.indexOf(BASE_END);
if (end < 0) throw new Error('[styles] não achei o fim da base em src/styles.css');
const skeleton = await readFile(join(webRoot, 'src', 'boot-skeleton.css'), 'utf8');
const extra = keptRules(styles.slice(end));
if (!extra.includes('ui-shimmer') || !extra.includes('.ui-notice')) {
  throw new Error('[styles] não achei o brilho ou o aviso no styles.css');
}
const { code } = await transform(styles.slice(0, end) + extra + skeleton, {
  loader: 'css',
  minify: true,
});

const links = [...html.matchAll(/<link rel="stylesheet" href="(styles-[\w-]+\.css)"([^>]*)>/g)];
if (links.length !== 1) {
  throw new Error(
    `[styles] esperava exatamente um <link> de styles-*.css no index.html, achei ${links.length}`,
  );
}
const [tag, href, rest] = links[0];
// O preload mantém a prioridade alta (folha com media que não casa desce para a prioridade mais baixa).
const deferred =
  `<link rel="preload" as="style" href="${href}"${rest}>` +
  `<link rel="stylesheet" href="${href}" media="print" data-boot-styles${rest}>`;
const critical = `<style nonce="__CSP_NONCE__" ${CRITICAL_MARK}>${code}</style>`;

if (!html.includes(SCRIPT_MARK))
  throw new Error('[styles] não achei o <script> do boot-skeleton.js');
// A página já nasce com "folha pendente": se o boot-skeleton.js não rodar, o app assume (adoptBootStyles) em vez de
// o esqueleto sair deixando a folha em media="print". Sem o <html>, o build quebra aqui.
if (!/<html[^>]*>/.test(html)) throw new Error('[styles] não achei a tag <html>');
const out = html
  .replace(/<html([^>]*)>/, (_, attributes) => `<html${attributes} data-styles="pending">`)
  .replace(tag, () => deferred)
  .replace(SCRIPT_MARK, () => critical + SCRIPT_MARK);
await writeFile(indexFile, out);
console.log(
  `[styles] esqueleto inline (${(code.length / 1024).toFixed(1)} kB) e ${href} sem bloquear a pintura`,
);
