import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  HASHED_ASSET,
  MAX_ARCHIVE_BYTES,
  assetName,
  checkLive,
  defaultTar,
  inspectArchive,
  main,
  missingFromArchive,
  packAssets,
  pickReleases,
  retain,
  validateArchive,
} from './retained-assets.mjs';

const tmp = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'uniover-retained-test-'));
  tmp.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tmp) rmSync(dir, { recursive: true, force: true });
});

const quiet = () => undefined;

/** Uma pasta de build com o que o Angular gera na raiz (e o que nunca deve entrar no artefato). */
function fakeDist(hashed) {
  const dist = scratch();
  writeFileSync(join(dist, 'index.html'), '<html></html>');
  writeFileSync(join(dist, 'sw.js'), 'self.skipWaiting();');
  writeFileSync(join(dist, 'manifest.webmanifest'), '{}');
  writeFileSync(join(dist, 'boot-skeleton.js'), 'x');
  writeFileSync(join(dist, 'main-legacy.js'), 'não tem hash');
  writeFileSync(join(dist, 'chunk-ABCD1234.js.map'), '{}');
  mkdirSync(join(dist, 'exercise-art'));
  writeFileSync(join(dist, 'exercise-art', 'chunk-ZZ99zz99.js'), 'dentro de pasta');
  for (const [name, body] of Object.entries(hashed)) writeFileSync(join(dist, name), body);
  return dist;
}

/** Monta o artefato de uma versão e devolve o conteúdo dele, a soma e o nome. */
function archiveOf(version, hashed) {
  const out = join(scratch(), assetName(version));
  packAssets(fakeDist(hashed), out);
  return { bytes: readFileSync(out), sum: readFileSync(`${out}.sha256`, 'utf8'), out };
}

function release(version, extra = {}) {
  const name = assetName(version);
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name, browser_download_url: `https://download.test/${name}` },
      { name: `${name}.sha256`, browser_download_url: `https://download.test/${name}.sha256` },
    ],
    ...extra,
  };
}

/** `fetch` falso: a lista de Releases da API e os downloads por endereço. */
function fakeFetch({ releases, files = new Map(), apiStatus = 200 }) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://api.github.com/repos/')) {
      return apiStatus === 200
        ? new Response(JSON.stringify(releases), { status: 200 })
        : new Response('limite', { status: apiStatus });
    }
    const body = files.get(String(url));
    return body === undefined
      ? new Response('nada', { status: 404 })
      : new Response(body, { status: 200 });
  };
  impl.calls = calls;
  return impl;
}

function serve(files, version, hashed) {
  const { bytes, sum } = archiveOf(version, hashed);
  files.set(`https://download.test/${assetName(version)}`, bytes);
  files.set(`https://download.test/${assetName(version)}.sha256`, sum);
  return bytes;
}

test('HASHED_ASSET is the same rule the API uses to send the immutable header', () => {
  for (const name of [
    'main-JH3CJE5L.js',
    'polyfills-4OKWE6V5.js',
    'styles-ZU5HTQMD.css',
    'chunk-27CGJwsf.js',
    'chunk-B-ZYueZf.js',
    'chunk-B2_sHuAz.js',
  ]) {
    assert.ok(HASHED_ASSET.test(name), name);
  }
  for (const name of [
    'index.html',
    'sw.js',
    'boot-skeleton.js',
    'manifest.webmanifest',
    'main-legacy.js',
    'main-abcd1234.js',
    'styles-legacy.css',
    'chunk-curto.js',
    'chunk-ABCD1234.js.map',
    '../chunk-ABCD1234.js',
    'treino/chunk-ABCD1234.js',
    'chunk-ABCD1234.js ',
  ]) {
    assert.ok(!HASHED_ASSET.test(name), name);
  }
});

test('pickReleases keeps the newest versions that have the artifact and its checksum', () => {
  const releases = [
    release('0.54.0'),
    release('0.52.1'),
    release('0.53.0'),
    release('0.51.0'),
    release('0.55.0', { prerelease: true }),
    release('0.56.0', { draft: true }),
    { ...release('0.50.0'), assets: [] },
    release('0.49.0', { tag_name: 'nightly' }),
    { ...release('0.48.0'), assets: [release('0.48.0').assets[0]] },
  ];
  assert.deepEqual(
    pickReleases(releases, { count: 3 }).map((entry) => entry.version),
    ['0.54.0', '0.53.0', '0.52.1'],
  );
  assert.deepEqual(
    pickReleases(releases, { count: 2, current: '0.54.0' }).map((entry) => entry.version),
    ['0.53.0', '0.52.1'],
  );
  assert.deepEqual(pickReleases(releases, { count: 0 }), []);
  assert.deepEqual(pickReleases(null, { count: 3 }), []);
});

test('pickReleases orders by version number, not by text', () => {
  const releases = [release('0.9.0'), release('0.10.0'), release('0.100.0')];
  assert.deepEqual(
    pickReleases(releases, { count: 3 }).map((entry) => entry.version),
    ['0.100.0', '0.10.0', '0.9.0'],
  );
});

test('packAssets takes only the hashed files at the root, never the index, the service worker or the manifests', () => {
  const dist = fakeDist({
    'main-AAAA1111.js': 'm',
    'chunk-BBBB2222.js': 'c',
    'styles-CCCC3333.css': 's',
  });
  const out = join(scratch(), 'web-assets-1.0.0.tar.gz');
  const files = packAssets(dist, out);

  assert.deepEqual(files, ['chunk-BBBB2222.js', 'main-AAAA1111.js', 'styles-CCCC3333.css']);
  assert.deepEqual(inspectArchive(out).names.sort(), files);
  assert.equal(validateArchive(out), null);
  const sum = createHash('sha256').update(readFileSync(out)).digest('hex');
  assert.equal(readFileSync(`${out}.sha256`, 'utf8'), `${sum}  web-assets-1.0.0.tar.gz\n`);
});

test('packAssets refuses a build without a hashed main file', () => {
  assert.throws(
    () => packAssets(fakeDist({ 'chunk-BBBB2222.js': 'c' }), join(scratch(), 'x.tar.gz')),
    /main-/,
  );
});

test('validateArchive rejects names outside the hashed pattern, subfolders and non-regular entries', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  const bad = join(scratch(), 'bad.tar.gz');
  defaultTar(['-czf', bad, '-C', dir, 'index.html']);
  assert.match(validateArchive(bad), /fora do padrão/);

  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'chunk-ABCD1234.js'), 'x');
  const nested = join(scratch(), 'nested.tar.gz');
  defaultTar(['-czf', nested, '-C', dir, 'sub']);
  assert.ok(validateArchive(nested));

  let linked = true;
  try {
    symlinkSync('/etc/passwd', join(dir, 'chunk-LINK1234.js'));
  } catch {
    linked = false; // sem permissão para criar link neste sistema
  }
  if (linked) {
    const link = join(scratch(), 'link.tar.gz');
    defaultTar(['-czf', link, '-C', dir, 'chunk-LINK1234.js']);
    assert.match(validateArchive(link), /não é arquivo comum/);
  }
});

test('missingFromArchive lists what the live page uses and the artifact lacks', () => {
  const html =
    '<link rel="modulepreload" href="chunk-AAAA1111.js"><script src="main-BBBB2222.js"></script>' +
    '<link rel="stylesheet" href="styles-CCCC3333.css"><script src="boot-skeleton.js"></script>';
  assert.deepEqual(missingFromArchive(html, ['main-BBBB2222.js', 'styles-CCCC3333.css']), [
    'chunk-AAAA1111.js',
  ]);
  assert.deepEqual(
    missingFromArchive(html, [
      './chunk-AAAA1111.js',
      './main-BBBB2222.js',
      './styles-CCCC3333.css',
    ]),
    [],
  );
});

test('retain copies the hashed files of the last versions and the newer copy wins over the older', async () => {
  const files = new Map();
  serve(files, '0.53.0', { 'main-AAAA1111.js': 'v53', 'chunk-SHARED11.js': 'comum' });
  serve(files, '0.52.0', { 'main-OLDOLD11.js': 'v52', 'chunk-SHARED11.js': 'comum' });
  serve(files, '0.51.0', { 'main-OLDEST11.js': 'v51' });
  const outDir = join(scratch(), 'retained');
  const fetchImpl = fakeFetch({
    releases: [release('0.53.0'), release('0.52.0'), release('0.51.0')],
    files,
  });

  const result = await retain({ repo: 'dono/projeto', outDir, count: 2, fetchImpl, log: quiet });

  assert.equal(result.ok, true);
  assert.deepEqual(result.versions, ['0.53.0', '0.52.0']);
  assert.deepEqual(readdirSync(outDir).sort(), [
    'chunk-SHARED11.js',
    'main-AAAA1111.js',
    'main-OLDOLD11.js',
  ]);
  assert.ok(fetchImpl.calls[0].startsWith('https://api.github.com/repos/dono/projeto/releases'));
  assert.ok(
    !fetchImpl.calls.some((url) => url.includes('0.51.0')),
    'a terceira versão nem é baixada',
  );
});

test('retain never overwrites a file that is already there', async () => {
  const files = new Map();
  serve(files, '0.53.0', { 'main-AAAA1111.js': 'do artefato' });
  const outDir = join(scratch(), 'retained');
  mkdirSync(outDir);
  writeFileSync(join(outDir, 'main-AAAA1111.js'), 'já existia');

  await retain({
    repo: 'dono/projeto',
    outDir,
    fetchImpl: fakeFetch({ releases: [release('0.53.0')], files }),
    log: quiet,
  });
  assert.equal(readFileSync(join(outDir, 'main-AAAA1111.js'), 'utf8'), 'já existia');
});

test('retain skips the version being built and a version whose checksum does not match, and goes on with the others', async () => {
  const files = new Map();
  serve(files, '0.54.0', { 'main-CURRENT1.js': 'atual' });
  serve(files, '0.53.0', { 'main-AAAA1111.js': 'v53' });
  serve(files, '0.52.0', { 'main-BBBB2222.js': 'v52' });
  files.set(
    `https://download.test/${assetName('0.53.0')}.sha256`,
    `${'0'.repeat(64)}  ${assetName('0.53.0')}\n`,
  );
  const logs = [];
  const outDir = join(scratch(), 'retained');

  const result = await retain({
    repo: 'dono/projeto',
    outDir,
    current: '0.54.0',
    fetchImpl: fakeFetch({
      releases: [release('0.54.0'), release('0.53.0'), release('0.52.0')],
      files,
    }),
    log: (line) => logs.push(line),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.versions, ['0.52.0']);
  assert.deepEqual(readdirSync(outDir), ['main-BBBB2222.js']);
  assert.ok(
    logs.some((line) => line.includes('v0.53.0 ignorada') && line.includes('soma de verificação')),
  );
});

test('retain rejects an artifact with a file outside the hashed pattern', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  writeFileSync(join(dir, 'main-AAAA1111.js'), 'x');
  const archive = join(scratch(), assetName('0.53.0'));
  defaultTar(['-czf', archive, '-C', dir, 'index.html', 'main-AAAA1111.js']);
  const bytes = readFileSync(archive);
  const files = new Map([
    [`https://download.test/${assetName('0.53.0')}`, bytes],
    [
      `https://download.test/${assetName('0.53.0')}.sha256`,
      `${createHash('sha256').update(bytes).digest('hex')}  ${assetName('0.53.0')}\n`,
    ],
  ]);
  const outDir = join(scratch(), 'retained');

  const result = await retain({
    repo: 'dono/projeto',
    outDir,
    fetchImpl: fakeFetch({ releases: [release('0.53.0')], files }),
    log: quiet,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(readdirSync(outDir), [], 'nada de um artefato inválido chega ao wwwroot');
});

test('retain is best effort: no network, a rate limit or a missing download never throws', async () => {
  const outDir = join(scratch(), 'retained');
  const rateLimited = await retain({
    repo: 'dono/projeto',
    outDir,
    fetchImpl: fakeFetch({ releases: [], apiStatus: 403 }),
    log: quiet,
  });
  assert.equal(rateLimited.ok, false);

  const offline = await retain({
    repo: 'dono/projeto',
    outDir,
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
    log: quiet,
  });
  assert.equal(offline.ok, false);

  const missing = await retain({
    repo: 'dono/projeto',
    outDir,
    fetchImpl: fakeFetch({ releases: [release('0.53.0')], files: new Map() }),
    log: quiet,
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(readdirSync(outDir), []);
});

test('retain does nothing when switched off with a count of zero', async () => {
  const fetchImpl = fakeFetch({ releases: [release('0.53.0')] });
  const outDir = join(scratch(), 'retained');
  const result = await retain({ repo: 'dono/projeto', outDir, count: 0, fetchImpl, log: quiet });
  assert.equal(result.ok, true);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(existsSync(outDir), false);
});

test('retain refuses an artifact above the size ceiling', async () => {
  const bytes = Buffer.alloc(MAX_ARCHIVE_BYTES + 1, 1);
  const files = new Map([
    [`https://download.test/${assetName('0.53.0')}`, bytes],
    [
      `https://download.test/${assetName('0.53.0')}.sha256`,
      `${createHash('sha256').update(bytes).digest('hex')}  ${assetName('0.53.0')}
`,
    ],
  ]);
  const logs = [];
  const outDir = join(scratch(), 'retained');
  const result = await retain({
    repo: 'dono/projeto',
    outDir,
    fetchImpl: fakeFetch({ releases: [release('0.53.0')], files }),
    log: (line) => logs.push(line),
  });
  assert.equal(result.ok, false);
  assert.ok(logs.some((line) => line.includes('grande demais')));
  assert.deepEqual(readdirSync(outDir), []);
});

test('main: pack, covers and fetch exit codes (fetch is lenient unless strict)', async () => {
  const dist = fakeDist({ 'main-AAAA1111.js': 'm', 'chunk-BBBB2222.js': 'c' });
  const out = join(scratch(), 'web-assets-1.0.0.tar.gz');
  const logs = [];
  const errors = [];
  const io = { log: (line) => logs.push(line), errorLog: (line) => errors.push(line) };

  assert.equal(await main(['pack', dist, out], io), 0);
  assert.equal(await main(['pack'], io), 1);

  const page = join(scratch(), 'index.html');
  writeFileSync(page, '<script src="main-AAAA1111.js"></script><link href="chunk-BBBB2222.js">');
  assert.equal(await main(['covers', out, page], io), 0);
  writeFileSync(page, '<script src="main-ZZZZ9999.js"></script>');
  assert.equal(await main(['covers', out, page], io), 1);
  assert.ok(errors.some((line) => line.includes('main-ZZZZ9999.js')));

  // Argumento inválido no fetch: não derruba o build, a menos que seja rígido.
  assert.equal(await main(['fetch', '--repo', 'a/b'], io), 0);
  assert.equal(await main(['fetch', '--repo', 'a/b', '--strict'], io), 1);
  assert.equal(await main(['desconhecido'], io), 1);
  assert.equal(
    await main(['fetch', '--repo', 'a/b', '--out', join(scratch(), 'o'), '--count', '0'], io),
    0,
  );
});

test('retain makes a failure loud: AVISO lines and a closing banner, and still never throws', async () => {
  const logs = [];
  const result = await retain({
    repo: 'dono/projeto',
    outDir: join(scratch(), 'retained'),
    fetchImpl: fakeFetch({ releases: [], apiStatus: 403 }),
    log: (line) => logs.push(line),
  });
  assert.equal(result.ok, false);
  assert.ok(logs.some((line) => line.startsWith('AVISO retenção:')));
  assert.ok(logs.at(-1).startsWith('=== AVISO: a retenção'));
});

test('retain warns when there is no earlier artifact at all (the first publication before the manual bootstrap)', async () => {
  const logs = [];
  const result = await retain({
    repo: 'dono/projeto',
    outDir: join(scratch(), 'retained'),
    fetchImpl: fakeFetch({ releases: [{ ...release('0.54.0'), assets: [] }] }),
    log: (line) => logs.push(line),
  });
  assert.equal(result.ok, false);
  assert.ok(logs.some((line) => line.includes('nenhum Release anterior com o artefato')));
});

test('retain stays quiet (no banner) when everything was retained', async () => {
  const files = new Map();
  serve(files, '0.53.0', { 'main-AAAA1111.js': 'v53' });
  const logs = [];
  await retain({
    repo: 'dono/projeto',
    outDir: join(scratch(), 'retained'),
    fetchImpl: fakeFetch({ releases: [release('0.53.0')], files }),
    log: (line) => logs.push(line),
  });
  assert.ok(!logs.some((line) => line.includes('AVISO')));
});

/** Um PWA "no ar" que responde 200 só para os arquivos dados. */
function liveFetch(base, live, inner) {
  return async (url, init) => {
    if (String(url).startsWith(`${base}/`)) {
      const name = String(url).slice(base.length + 1);
      return new Response(null, { status: live.has(name) ? 200 : 404 });
    }
    return inner(url, init);
  };
}

test('checkLive finds nothing missing when the live image kept the earlier versions', async () => {
  const files = new Map();
  serve(files, '0.53.0', { 'main-AAAA1111.js': 'a', 'chunk-BBBB2222.js': 'b' });
  serve(files, '0.52.0', { 'main-CCCC3333.js': 'c' });
  const live = new Set(['main-AAAA1111.js', 'chunk-BBBB2222.js', 'main-CCCC3333.js']);
  const api = fakeFetch({ releases: [release('0.53.0'), release('0.52.0')], files });

  const result = await checkLive({
    repo: 'dono/projeto',
    url: 'https://app.test/',
    current: '0.54.0',
    fetchImpl: liveFetch('https://app.test', live, api),
    log: quiet,
  });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.problems, []);
  assert.equal(result.checked, 3);
});

test('checkLive reports each earlier file that the live image does not serve', async () => {
  const files = new Map();
  serve(files, '0.53.0', { 'main-AAAA1111.js': 'a', 'chunk-BBBB2222.js': 'b' });
  const live = new Set(['main-AAAA1111.js']);
  const api = fakeFetch({ releases: [release('0.53.0')], files });

  const result = await checkLive({
    repo: 'dono/projeto',
    url: 'https://app.test',
    fetchImpl: liveFetch('https://app.test', live, api),
    log: quiet,
  });
  assert.deepEqual(result.missing, ['v0.53.0: chunk-BBBB2222.js (HTTP 404)']);
});

test('checkLive samples a few files per version instead of asking for every one', async () => {
  const hashed = { 'main-AAAA1111.js': 'm' };
  for (let i = 0; i < 40; i++) hashed[`chunk-${String(i).padStart(8, 'X')}.js`] = `c${i}`;
  const files = new Map();
  serve(files, '0.53.0', hashed);
  const live = new Set(Object.keys(hashed));
  const api = fakeFetch({ releases: [release('0.53.0')], files });

  const result = await checkLive({
    repo: 'dono/projeto',
    url: 'https://app.test',
    sample: 5,
    fetchImpl: liveFetch('https://app.test', live, api),
    log: quiet,
  });
  assert.equal(result.missing.length, 0);
  assert.ok(result.checked <= 6 && result.checked >= 2, `conferidos: ${result.checked}`);
});

test('checkLive reports a problem (not a crash) with no earlier artifact, a rate limit or a bad download', async () => {
  const none = await checkLive({
    repo: 'dono/projeto',
    url: 'https://app.test',
    fetchImpl: fakeFetch({ releases: [] }),
    log: quiet,
  });
  assert.equal(none.problems.length, 1);

  const limited = await checkLive({
    repo: 'dono/projeto',
    url: 'https://app.test',
    fetchImpl: fakeFetch({ releases: [], apiStatus: 403 }),
    log: quiet,
  });
  assert.match(limited.problems[0], /não consegui listar/);

  const broken = await checkLive({
    repo: 'dono/projeto',
    url: 'https://app.test',
    fetchImpl: fakeFetch({ releases: [release('0.53.0')], files: new Map() }),
    log: quiet,
  });
  assert.match(broken.problems[0], /v0\.53\.0 não pôde ser conferida/);
});

test('main check-live prints GitHub warnings and exits 0 unless strict', async () => {
  const logs = [];
  const io = { log: (line) => logs.push(line), errorLog: quiet };
  // Retenção desligada (contagem 0): nada a conferir e nenhuma chamada de rede.
  const code = await main(
    ['check-live', '--repo', 'a/b', '--url', 'https://app.invalid', '--count', '0'],
    io,
  );
  assert.equal(code, 0);
  assert.equal(await main(['check-live', '--repo', 'a/b'], io), 1);
});
