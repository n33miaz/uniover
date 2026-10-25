// Guarda de variáveis CSS: falha quando um `var(--x)` SEM fallback usa uma custom property que nunca é definida.
// Sem a guarda, um erro de digitação (`--a-surface2` em vez de `--a-surface-2`) não quebra o build: o navegador
// descarta a declaração e a tela renderiza com fundo transparente e cantos retos, sem ninguém perceber.
//
// Conta como definição: `--x:` em qualquer CSS/estilo de componente/HTML, `[style.--x]` (binding de template, que
// cobre os valores vindos de sinal, como --level, --i, --w, --x, --progress, --key-scale e --kb-inset) e
// `setProperty('--x', ...)` (JS, como --shift). Não há allowlist: esses três padrões bastam.
// É chamada por `npm run lint`; uma linha por violação (arquivo:linha), saída diferente de zero se houver alguma.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const srcRoot = join(webRoot, 'src');

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(css|ts|html)$/.test(entry.name)) yield full;
  }
}

// Comentários de bloco saem, mas as quebras de linha ficam para o número da linha continuar certo.
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

const DEFINITIONS = [
  /(--[\w-]+)\s*:/g,
  /\[style\.(--[\w-]+)\]/g,
  /setProperty\(\s*['"`](--[\w-]+)/g,
];
const USAGE = /var\(\s*(--[\w-]+)\s*\)/g;

const defined = new Set();
const uses = [];

for (const file of walk(srcRoot)) {
  const text = stripComments(readFileSync(file, 'utf8'));
  for (const pattern of DEFINITIONS) {
    for (const match of text.matchAll(pattern)) defined.add(match[1]);
  }
  for (const match of text.matchAll(USAGE)) {
    const line = text.slice(0, match.index).split('\n').length;
    uses.push({ file: relative(webRoot, file).split(sep).join('/'), line, name: match[1] });
  }
}

const violations = uses.filter((use) => !defined.has(use.name));
for (const v of violations)
  console.error(`${v.file}:${v.line}  var(${v.name}) sem fallback e nunca definida`);

if (violations.length > 0) {
  console.error(`\ncheck-css-vars: ${violations.length} uso(s) de variável CSS inexistente.`);
  process.exit(1);
}
console.log(
  `check-css-vars: ok (${uses.length} usos sem fallback, ${defined.size} variáveis definidas).`,
);
