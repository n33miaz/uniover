// Monta o catálogo de telas: lê as capturas e os metadados que `catalog.spec.ts` deixou em `test-results-catalog` e escreve UM
// arquivo HTML autocontido (imagens como WebP embutido), agrupado por módulo, com filtro, ampliação e anotações.
//
//   node e2e/catalog/build-catalog.mjs            (roda sozinho ao fim de `npm run catalog`)
//
// Saída: `CATALOG_OUT`, ou `~/Desktop/uniover-catalogo-telas.html` quando a Desktop existe, ou
// `test-results-catalog/catalogo-telas.html`. Orçamento: ~24 MB (`CATALOG_BUDGET_MB`).
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const DIR = process.env.CATALOG_DIR ?? 'test-results-catalog';
const FRAMES_DIR = join(DIR, 'frames');
const BUDGET = Number(process.env.CATALOG_BUDGET_MB ?? 24) * 1024 * 1024;

function readLines(name) {
  const file = join(DIR, name);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function outputPath() {
  if (process.env.CATALOG_OUT) return process.env.CATALOG_OUT;
  const desktop = join(homedir(), 'Desktop');
  return existsSync(desktop)
    ? join(desktop, 'uniover-catalogo-telas.html')
    : join(DIR, 'catalogo-telas.html');
}

const esc = (text) =>
  String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const frames = readLines('frames.jsonl');
const failures = readLines('failures.jsonl');
const gaps = readLines('gaps.jsonl');
const inventory = existsSync(join(DIR, 'routes.json'))
  ? JSON.parse(readFileSync(join(DIR, 'routes.json'), 'utf8'))
  : [];

if (frames.length === 0) {
  console.error('Nenhuma captura em', FRAMES_DIR, '- nada a montar.');
  process.exit(1);
}

// ---- Imagens: WebP embutido, baixando a qualidade se o conjunto passar do orçamento. ----
const sources = await Promise.all(
  frames.map((frame) => sharp(join(FRAMES_DIR, frame.file)).toBuffer()),
);
let quality = 70;
let encoded = [];
for (;;) {
  encoded = await Promise.all(sources.map((buffer) => sharp(buffer).webp({ quality }).toBuffer()));
  const total = encoded.reduce((sum, buffer) => sum + buffer.length, 0) * (4 / 3);
  if (total <= BUDGET * 0.92 || quality <= 35) break;
  quality -= 7;
}

// ---- Cobertura: toda rota do inventário contra o que foi capturado. ----
const byRoute = new Map();
for (const frame of frames) {
  if (!byRoute.has(frame.route)) byRoute.set(frame.route, []);
  byRoute.get(frame.route).push(frame);
}
const screens = inventory.filter((route) => route.kind === 'screen');
const redirects = inventory.filter((route) => route.kind === 'redirect');
const uncovered = screens.filter((route) => !byRoute.has(route.path));
const known = new Set(inventory.map((route) => route.path));
const extra = [...byRoute.keys()].filter((route) => !known.has(route));
const statesOf = (route) => [...new Set((byRoute.get(route) ?? []).map((f) => f.state))];

const ORDER = ['Entrada', 'Início', 'TV', 'Treino', 'PC', 'Ajustes'];
const modules = [...new Set(frames.map((frame) => frame.module))].sort(
  (a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99),
);
const kinds = [...new Set(frames.map((frame) => frame.kind))];

function figure(frame, index) {
  const meta = [
    `<span class="chip scheme-${frame.scheme}">${frame.scheme === 'dark' ? 'escuro' : 'claro'}</span>`,
    `<span class="chip kind">${esc(frame.kind)}</span>`,
    frame.note ? `<span class="chip note">${esc(frame.note)}</span>` : '',
  ].join('');
  return `<figure class="frame" data-i="${index}" data-module="${esc(frame.module)}" data-kind="${esc(frame.kind)}" data-scheme="${frame.scheme}" data-search="${esc(`${frame.route} ${frame.url} ${frame.state} ${frame.module}`.toLowerCase())}">
  <button class="shot" type="button" aria-label="Ampliar: ${esc(frame.route)} - ${esc(frame.state)}"><img loading="lazy" decoding="async" alt="${esc(`${frame.route}, ${frame.state}`)}" src="data:image/webp;base64,${encoded[index].toString('base64')}"></button>
  <figcaption>
    <code>${esc(frame.route)}</code>
    <strong>${esc(frame.state)}</strong>
    <span class="chips">${meta}</span>
    <label class="mark"><input type="checkbox" data-id="${frame.id}"> Não gostei</label>
    <input class="comment" type="text" data-id="${frame.id}" placeholder="O que mudar (opcional)" aria-label="Comentário sobre ${esc(frame.route)}">
  </figcaption>
</figure>`;
}

const sections = modules
  .map((module) => {
    const items = frames
      .map((frame, index) => ({ frame, index }))
      .filter(({ frame }) => frame.module === module);
    return `<section class="module" data-module="${esc(module)}">
<h2>${esc(module)} <small>${items.length} capturas</small></h2>
<div class="grid">${items.map(({ frame, index }) => figure(frame, index)).join('\n')}</div>
</section>`;
  })
  .join('\n');

const coverageRows = [
  ...screens.map((route) => {
    const list = byRoute.get(route.path) ?? [];
    return `<tr class="${list.length ? 'ok' : 'miss'}"><td><code>${esc(route.path)}</code></td><td>${list.length}</td><td>${esc(statesOf(route.path).join(' · ') || 'sem captura')}</td></tr>`;
  }),
  ...redirects.map(
    (route) =>
      `<tr class="redirect"><td><code>${esc(route.path)}</code></td><td>-</td><td>redireciona (a tela de destino está acima)</td></tr>`,
  ),
].join('\n');

const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UniOver - catálogo de telas</title>
<style>
:root { color-scheme: light dark; --bg:#f6f7f6; --fg:#1b1f1d; --muted:#5d6762; --card:#fff; --line:#d9dedb; --accent:#2f6b4f; --warn:#a15c00; --bad:#a32020; }
@media (prefers-color-scheme: dark) { :root { --bg:#101412; --fg:#e6ebe8; --muted:#9aa5a0; --card:#181d1a; --line:#2b332f; --accent:#7fc4a0; --warn:#e0a340; --bad:#f08080; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header.top { position:sticky; top:0; z-index:5; background:var(--bg); border-bottom:1px solid var(--line); padding:12px 20px; }
h1 { margin:0 0 4px; font-size:20px; }
.sub { color:var(--muted); margin:0 0 10px; font-size:13px; }
.bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.bar input[type=search], .bar select { padding:7px 10px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--fg); font:inherit; }
.bar input[type=search] { min-width:220px; flex:1; max-width:380px; }
.pill { border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:999px; padding:5px 12px; font:inherit; cursor:pointer; }
.pill[aria-pressed=true] { background:var(--accent); color:#fff; border-color:var(--accent); }
.count { color:var(--muted); font-size:13px; margin-left:auto; }
main { padding:16px 20px 60px; }
details.cov { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px 14px; margin-bottom:22px; }
details.cov summary { cursor:pointer; font-weight:600; }
table { border-collapse:collapse; width:100%; margin-top:10px; font-size:13px; }
th, td { text-align:left; padding:5px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
tr.miss td { color:var(--bad); font-weight:600; } tr.redirect td { color:var(--muted); }
.module h2 { margin:26px 0 10px; font-size:18px; } .module h2 small { color:var(--muted); font-weight:400; font-size:13px; margin-left:8px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(210px, 1fr)); gap:14px; align-items:start; }
.frame { margin:0; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:8px; }
.frame.marked { border-color:var(--bad); box-shadow:0 0 0 2px color-mix(in srgb, var(--bad) 35%, transparent); }
.shot { display:block; width:100%; padding:0; border:0; background:none; cursor:zoom-in; }
.shot img { display:block; width:100%; height:auto; border-radius:8px; border:1px solid var(--line); background:#888; }
figcaption { display:grid; gap:4px; margin-top:8px; font-size:12.5px; }
figcaption code { color:var(--muted); word-break:break-all; font-size:12px; } figcaption strong { font-size:13.5px; }
.chips { display:flex; flex-wrap:wrap; gap:4px; } .chip { font-size:11px; padding:1px 7px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
.chip.scheme-dark { background:#222; color:#ddd; border-color:#222; } .chip.note { color:var(--warn); }
.mark { display:flex; gap:6px; align-items:center; color:var(--muted); cursor:pointer; } .comment { width:100%; padding:5px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); font:inherit; font-size:12px; }
.hidden { display:none !important; }
dialog { border:0; padding:0; background:transparent; max-width:100vw; max-height:100vh; width:100vw; height:100vh; }
dialog::backdrop { background:rgba(0,0,0,.82); }
.lb { height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:12px; color:#fff; }
.lb img { max-height:calc(100vh - 110px); max-width:94vw; height:auto; width:auto; border-radius:10px; }
.lb .cap { text-align:center; font-size:14px; } .lb .cap code { color:#cfd8d3; }
.lb .nav { display:flex; gap:10px; } .lb button { padding:8px 16px; border-radius:8px; border:1px solid #666; background:#222; color:#fff; font:inherit; cursor:pointer; }
#export-dialog { background:var(--card); color:var(--fg); border-radius:12px; width:min(720px, 94vw); height:auto; max-height:88vh; margin:auto; }
#export-dialog .inner { padding:16px; display:grid; gap:10px; } #export-dialog textarea { width:100%; height:42vh; font:12.5px/1.4 ui-monospace, Consolas, monospace; padding:8px; background:var(--bg); color:var(--fg); border:1px solid var(--line); border-radius:8px; }
</style>
</head>
<body>
<header class="top">
  <h1>UniOver - catálogo de telas</h1>
  <p class="sub">iPhone 12 no Safari (390 x 664 úteis), gerado em ${esc(new Date().toLocaleString('pt-BR'))} a partir do app rodando com a API simulada do e2e. ${frames.length} capturas, ${screens.length - uncovered.length} de ${screens.length} telas.</p>
  <div class="bar">
    <input type="search" id="q" placeholder="Buscar rota ou estado" aria-label="Buscar rota ou estado">
    ${modules.map((m) => `<button class="pill mod" type="button" aria-pressed="false" data-module="${esc(m)}">${esc(m)}</button>`).join('\n    ')}
    <select id="kind" aria-label="Tipo de estado"><option value="">Todos os estados</option>${kinds.map((k) => `<option>${esc(k)}</option>`).join('')}</select>
    <select id="scheme" aria-label="Tema"><option value="">Claro e escuro</option><option value="light">Só claro</option><option value="dark">Só escuro</option></select>
    <button class="pill" type="button" id="only-marked" aria-pressed="false">Só marcados</button>
    <button class="pill" type="button" id="export">Exportar anotações</button>
    <span class="count" id="count" aria-live="polite"></span>
  </div>
</header>
<main>
<details class="cov"${uncovered.length || failures.length ? ' open' : ''}>
  <summary>Cobertura: ${screens.length - uncovered.length} de ${screens.length} telas capturadas${uncovered.length ? `, ${uncovered.length} sem captura` : ''}; ${failures.length} estados que não abriram; ${gaps.length} lacunas conhecidas</summary>
  <table><thead><tr><th>Rota</th><th>Capturas</th><th>Estados</th></tr></thead><tbody>${coverageRows}</tbody></table>
  ${extra.length ? `<p>Capturas de rotas fora do inventário: ${extra.map((r) => `<code>${esc(r)}</code>`).join(', ')}</p>` : ''}
  ${failures.length ? `<h3>Estados que não abriram</h3><table><thead><tr><th>Módulo</th><th>Rota</th><th>Estado</th><th>Erro</th></tr></thead><tbody>${failures.map((f) => `<tr><td>${esc(f.module)}</td><td><code>${esc(f.route)}</code></td><td>${esc(f.state)}</td><td>${esc(f.error)}</td></tr>`).join('')}</tbody></table>` : ''}
  ${gaps.length ? `<h3>O que a simulação não alcança</h3><table><thead><tr><th>Módulo</th><th>Rota</th><th>Estado</th><th>Por quê</th></tr></thead><tbody>${gaps.map((g) => `<tr><td>${esc(g.module)}</td><td><code>${esc(g.route)}</code></td><td>${esc(g.state)}</td><td>${esc(g.reason)}</td></tr>`).join('')}</tbody></table>` : ''}
</details>
${sections}
</main>
<dialog id="lb"><div class="lb"><img id="lb-img" alt=""><div class="cap" id="lb-cap"></div><div class="nav"><button type="button" id="prev">Anterior</button><button type="button" id="next">Próxima</button><button type="button" id="close">Fechar</button></div></div></dialog>
<dialog id="export-dialog"><div class="inner"><strong>Anotações em Markdown</strong><textarea id="export-text" readonly></textarea><div class="bar"><button class="pill" type="button" id="copy">Copiar</button><button class="pill" type="button" id="export-close">Fechar</button><span id="copied" class="count"></span></div></div></dialog>
<script>
(function () {
  var KEY = 'uniover-catalogo-notas';
  var notes = {};
  try { notes = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { notes = {}; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(notes)); } catch (e) { /* sem armazenamento: as notas valem só nesta aba */ } }
  var frames = Array.prototype.slice.call(document.querySelectorAll('.frame'));
  var state = { q: '', mods: {}, kind: '', scheme: '', marked: false };
  var count = document.getElementById('count');

  function apply() {
    var shown = 0;
    frames.forEach(function (f) {
      var id = f.querySelector('input[type=checkbox]').getAttribute('data-id');
      var modsOn = Object.keys(state.mods).filter(function (m) { return state.mods[m]; });
      var ok = (!state.q || f.getAttribute('data-search').indexOf(state.q) >= 0) &&
        (!modsOn.length || modsOn.indexOf(f.getAttribute('data-module')) >= 0) &&
        (!state.kind || f.getAttribute('data-kind') === state.kind) &&
        (!state.scheme || f.getAttribute('data-scheme') === state.scheme) &&
        (!state.marked || (notes[id] && notes[id].mark));
      f.classList.toggle('hidden', !ok);
      if (ok) shown++;
    });
    document.querySelectorAll('.module').forEach(function (s) {
      s.classList.toggle('hidden', !s.querySelector('.frame:not(.hidden)'));
    });
    var marked = Object.keys(notes).filter(function (k) { return notes[k].mark; }).length;
    count.textContent = shown + ' de ' + frames.length + ' capturas' + (marked ? ' · ' + marked + ' marcadas' : '');
  }

  document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value.trim().toLowerCase(); apply(); });
  document.getElementById('kind').addEventListener('change', function (e) { state.kind = e.target.value; apply(); });
  document.getElementById('scheme').addEventListener('change', function (e) { state.scheme = e.target.value; apply(); });
  document.querySelectorAll('.pill.mod').forEach(function (b) {
    b.addEventListener('click', function () {
      var m = b.getAttribute('data-module'); state.mods[m] = !state.mods[m];
      b.setAttribute('aria-pressed', String(!!state.mods[m])); apply();
    });
  });
  var onlyMarked = document.getElementById('only-marked');
  onlyMarked.addEventListener('click', function () { state.marked = !state.marked; onlyMarked.setAttribute('aria-pressed', String(state.marked)); apply(); });

  // Anotações: marcar e comentar cada captura; ficam neste navegador.
  frames.forEach(function (f) {
    var box = f.querySelector('input[type=checkbox]'); var text = f.querySelector('.comment');
    var id = box.getAttribute('data-id'); var n = notes[id] || {};
    box.checked = !!n.mark; text.value = n.text || ''; f.classList.toggle('marked', !!n.mark);
    function update() {
      notes[id] = { mark: box.checked, text: text.value };
      if (!box.checked && !text.value) delete notes[id];
      f.classList.toggle('marked', box.checked); save(); apply();
    }
    box.addEventListener('change', update); text.addEventListener('input', update);
  });

  // Ampliar: o mesmo arquivo da miniatura, em tela cheia, com setas e Esc.
  var lb = document.getElementById('lb'); var lbImg = document.getElementById('lb-img'); var lbCap = document.getElementById('lb-cap'); var cur = -1;
  function visible() { return frames.filter(function (f) { return !f.classList.contains('hidden'); }); }
  function show(frame) {
    cur = frames.indexOf(frame);
    lbImg.src = frame.querySelector('img').src;
    lbCap.innerHTML = '';
    var code = document.createElement('code'); code.textContent = frame.querySelector('code').textContent;
    lbCap.appendChild(code); lbCap.appendChild(document.createTextNode(' - ' + frame.querySelector('strong').textContent + ' (' + frame.querySelector('.scheme-light, .scheme-dark').textContent + ')'));
  }
  function step(d) { var list = visible(); var i = list.indexOf(frames[cur]); if (i < 0) i = 0; show(list[(i + d + list.length) % list.length]); }
  frames.forEach(function (f) { f.querySelector('.shot').addEventListener('click', function () { show(f); lb.showModal(); }); });
  document.getElementById('prev').addEventListener('click', function () { step(-1); });
  document.getElementById('next').addEventListener('click', function () { step(1); });
  document.getElementById('close').addEventListener('click', function () { lb.close(); });
  lb.addEventListener('click', function (e) { if (e.target === lb || e.target.classList.contains('lb')) lb.close(); });
  document.addEventListener('keydown', function (e) { if (!lb.open) return; if (e.key === 'ArrowRight') step(1); if (e.key === 'ArrowLeft') step(-1); });

  // Exportar em Markdown o que foi marcado ou comentado.
  var dlg = document.getElementById('export-dialog'); var out = document.getElementById('export-text');
  document.getElementById('export').addEventListener('click', function () {
    var lines = ['# Anotações do catálogo de telas', ''];
    frames.forEach(function (f) {
      var id = f.querySelector('input[type=checkbox]').getAttribute('data-id'); var n = notes[id];
      if (!n) return;
      lines.push('- ' + (n.mark ? '[não gostei] ' : '') + f.querySelector('code').textContent + ' - ' + f.querySelector('strong').textContent + ' (' + f.querySelector('.scheme-light, .scheme-dark').textContent + ')' + (n.text ? ': ' + n.text : ''));
    });
    if (lines.length === 2) lines.push('(nada marcado)');
    out.value = lines.join('\\n'); document.getElementById('copied').textContent = ''; dlg.showModal();
  });
  document.getElementById('export-close').addEventListener('click', function () { dlg.close(); });
  document.getElementById('copy').addEventListener('click', function () {
    out.select();
    var done = function () { document.getElementById('copied').textContent = 'Copiado.'; };
    if (navigator.clipboard) navigator.clipboard.writeText(out.value).then(done, function () { document.execCommand('copy'); done(); });
    else { document.execCommand('copy'); done(); }
  });
  apply();
})();
</script>
</body>
</html>`;

const target = outputPath();
writeFileSync(target, html);
const size = statSync(target).size;
const stateCount = new Set(frames.map((f) => `${f.route}|${f.state}|${f.scheme}`)).size;

console.log('\n=== Catálogo de telas ===');
console.log(`Arquivo:      ${target} (${(size / 1024 / 1024).toFixed(1)} MB, WebP q${quality})`);
console.log(`Capturas:     ${frames.length} (${stateCount} combinações rota/estado/tema)`);
console.log(
  `Telas:        ${screens.length - uncovered.length} de ${screens.length} capturadas; ${redirects.length} redirecionamentos`,
);
if (uncovered.length) console.log(`Sem captura:  ${uncovered.map((r) => r.path).join(', ')}`);
if (extra.length) console.log(`Fora do inventário: ${extra.join(', ')}`);
console.log(`Falhas:       ${failures.length}`);
for (const f of failures) console.log(`  - [${f.module}] ${f.route} / ${f.state}: ${f.error}`);
console.log(`Lacunas:      ${gaps.length}`);
for (const g of gaps) console.log(`  - [${g.module}] ${g.route} / ${g.state}: ${g.reason}`);
console.log('Estados por tela:');
for (const route of screens)
  console.log(
    `  ${route.path}: ${statesOf(route.path).length} estados, ${(byRoute.get(route.path) ?? []).length} capturas`,
  );
if (size > BUDGET)
  console.warn(`AVISO: o arquivo passou do orçamento de ${BUDGET / 1024 / 1024} MB.`);
