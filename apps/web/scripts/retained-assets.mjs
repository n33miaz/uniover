// Retenção dos arquivos com hash do PWA entre versões.
//
// Depois de um deploy, uma página aberta (ou um aparelho sem service worker ativo) ainda pede os pedaços de código da versão
// que ela carregou; se a imagem nova não os tem mais, o pedido dá 404 e a tela quebra. Para isso não acontecer, cada versão
// publica os seus arquivos com hash como um artefato do Release (`web-assets-<versão>.tar.gz`) e a imagem seguinte copia para
// o `wwwroot` os das últimas versões, ao lado dos próprios.
//
// Quatro usos, todos pelo Node (sem dependências):
//   node retained-assets.mjs pack <pasta-do-build> <saida.tar.gz>      monta o artefato (e grava <saida>.sha256)
//   node retained-assets.mjs covers <artefato.tar.gz> <pagina.html>    confere que o artefato tem o que a página no ar usa
//   node retained-assets.mjs fetch --repo dono/nome --out <pasta> [--count 3] [--current 1.2.3] [--strict]
//                                                                      baixa os artefatos das últimas versões para <pasta>
//   node retained-assets.mjs check-live --repo dono/nome --url https://endereco [--count 3] [--current 1.2.3]
//                                                                      confere no ar que a imagem reteve os das versões anteriores
//
// O `fetch` é só de melhor esforço, por escolha: a publicação não pode depender da disponibilidade do GitHub. Em troca a falha
// sai bem visível (prefixo AVISO e uma faixa no fim do log) e o `check-live` a confirma depois de publicar. Sem rede, com limite
// de requisições, sem Release ou com artefato inválido ele registra o
// motivo e sai com 0 (uma imagem sem as versões antigas é a de antes, nunca um build quebrado). `--strict` o torna rígido.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * O nome exato que o build do Angular gera, só na raiz do build: `main`, `polyfills` e `styles` com 8 letras maiúsculas ou
 * dígitos, e `chunk` com 8 caracteres de base64 de URL. É a MESMA regra de `PwaCachePolicy.HashedAsset` na API: o que a
 * imagem retém é exatamente o que ela serve como imutável. Nunca `index.html`, `sw.js`, manifestos nem `boot-skeleton.js`.
 */
export const HASHED_ASSET =
  /^(?:(?:main|polyfills|styles)-[A-Z0-9]{8}|chunk-[A-Za-z0-9_-]{8})\.(?:js|css)$/;

/** Referências a arquivos com hash dentro de uma página (para conferir o que ela usa). */
const REFERENCE =
  /(?:main|polyfills|styles)-[A-Z0-9]{8}\.(?:js|css)|chunk-[A-Za-z0-9_-]{8}\.(?:js|css)/g;

export const DEFAULT_COUNT = 3;
/** Teto do artefato baixado (compactado) e de arquivos dentro dele: nada que fuja disso é de um build do PWA. */
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_FILES = 2000;
export const REQUEST_TIMEOUT_MS = 30_000;

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export function assetName(version) {
  return `web-assets-${version}.tar.gz`;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function parseTag(tag) {
  const match = TAG.exec(tag ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Escolhe, entre os Releases do GitHub, as últimas `count` versões (maiores primeiro) que têm o artefato. Rascunhos, pré-
 * lançamentos, tags que não são `vX.Y.Z` e a própria versão que está sendo construída ficam de fora.
 */
export function pickReleases(releases, { count = DEFAULT_COUNT, current = null } = {}) {
  const picked = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft || release.prerelease) continue;
    const parts = parseTag(release.tag_name);
    if (!parts) continue;
    const version = parts.join('.');
    if (version === current) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const archive = assets.find((asset) => asset?.name === assetName(version));
    const checksum = assets.find((asset) => asset?.name === `${assetName(version)}.sha256`);
    if (!archive?.browser_download_url || !checksum?.browser_download_url) continue;
    picked.push({
      version,
      parts,
      archiveUrl: archive.browser_download_url,
      checksumUrl: checksum.browser_download_url,
    });
  }
  picked.sort((a, b) => compareVersions(b.parts, a.parts));
  return picked.slice(0, Math.max(0, count));
}

/** Os nomes dentro de um `.tar.gz` e se todos são arquivos comuns (nada de link, pasta ou dispositivo). */
export function inspectArchive(file, { tar = defaultTar } = {}) {
  const names = tar(['-tzf', file]).split(/\r?\n/).filter(Boolean);
  const detailed = tar(['-tvzf', file]).split(/\r?\n/).filter(Boolean);
  const regularOnly = detailed.every((line) => line.startsWith('-'));
  return { names, regularOnly };
}

/**
 * No Windows com o tar do GNU (o do Git Bash), um caminho com `C:` é lido como "máquina:arquivo"; `--force-local` o trata como
 * arquivo. O tar do Windows (bsdtar) e o do Linux não precisam disso.
 */
const LOCAL_FLAG = (() => {
  if (process.platform !== 'win32') return [];
  try {
    return /GNU tar/.test(execFileSync('tar', ['--version'], { encoding: 'utf8' }))
      ? ['--force-local']
      : [];
  } catch {
    return [];
  }
})();

export function defaultTar(args) {
  return execFileSync('tar', [...LOCAL_FLAG, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

const bare = (name) => name.replace(/^\.\//, '');

/** O artefato só vale se tiver apenas arquivos comuns, na raiz, com nome de arquivo com hash do build. */
export function validateArchive(file, options) {
  const { names, regularOnly } = inspectArchive(file, options);
  if (names.length === 0) return 'artefato vazio';
  if (names.length > MAX_FILES) return `arquivos demais (${names.length})`;
  if (!regularOnly) return 'há entrada que não é arquivo comum';
  const bad = names.find((name) => !HASHED_ASSET.test(bare(name)));
  return bad ? `nome fora do padrão dos arquivos com hash: ${bad}` : null;
}

/** Monta o artefato com os arquivos com hash da raiz de `distDir` e grava `<saída>.sha256`. Devolve os nomes incluídos. */
export function packAssets(distDir, outFile, { tar = defaultTar } = {}) {
  const files = readdirSync(distDir)
    .filter((name) => HASHED_ASSET.test(name) && lstatSync(join(distDir, name)).isFile())
    .sort();
  if (!files.some((name) => name.startsWith('main-'))) {
    throw new Error(`nenhum main-*.js com hash em ${distDir}: o build está completo?`);
  }
  const out = resolve(outFile);
  tar(['-czf', out, '-C', resolve(distDir), ...files]);
  const sum = createHash('sha256').update(readFileSync(out)).digest('hex');
  writeFileSync(`${out}.sha256`, `${sum}  ${basename(out)}\n`);
  return files;
}

/** Os arquivos com hash que a página usa e que o artefato NÃO tem (vazio quando está tudo lá). */
export function missingFromArchive(html, names) {
  const have = new Set(names.map(bare));
  return [...new Set(html.match(REFERENCE) ?? [])].filter((name) => !have.has(name)).sort();
}

async function download(fetchImpl, url, { maxBytes, timeoutMs }) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'uniover-image-build', Accept: 'application/octet-stream' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('arquivo grande demais');
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxBytes) throw new Error('arquivo grande demais');
  return body;
}

/** Lista os Releases do repositório (a API pública do GitHub; com `token`, no limite maior de quem se identifica). */
async function listReleases({ repo, fetchImpl, token, timeoutMs }) {
  const headers = { 'User-Agent': 'uniover-image-build', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** Baixa o artefato de um Release para `work`, confere a soma e o conteúdo; devolve o caminho do `.tar.gz` ou lança. */
async function loadArchive(release, { work, fetchImpl, tar, timeoutMs }) {
  const archive = join(work, assetName(release.version));
  const body = await download(fetchImpl, release.archiveUrl, {
    maxBytes: MAX_ARCHIVE_BYTES,
    timeoutMs,
  });
  const expected = (await download(fetchImpl, release.checksumUrl, { maxBytes: 4096, timeoutMs }))
    .toString('utf8')
    .trim()
    .split(/\s+/)[0]
    ?.toLowerCase();
  const actual = createHash('sha256').update(body).digest('hex');
  if (expected !== actual) throw new Error('soma de verificação não confere');
  writeFileSync(archive, body);
  const invalid = validateArchive(archive, { tar });
  if (invalid) throw new Error(invalid);
  return archive;
}

/**
 * Baixa o artefato das últimas versões e copia para `outDir` os arquivos com hash que ainda não existem lá. Nunca lança por
 * falha de uma versão (registra e segue); com `strict`, qualquer falha vira o resultado `ok: false`. Falha não passa em
 * silêncio: cada uma sai com o prefixo `AVISO` e, no fim, uma faixa avisa que a imagem só tem a versão atual.
 */
export async function retain({
  repo,
  outDir,
  count = DEFAULT_COUNT,
  current = null,
  fetchImpl = globalThis.fetch,
  tar = defaultTar,
  log = console.log,
  timeoutMs = REQUEST_TIMEOUT_MS,
  token = process.env.GITHUB_TOKEN,
}) {
  const result = { ok: true, versions: [], files: 0 };
  if (!(count > 0)) {
    log('Retenção desligada (contagem 0): o wwwroot leva só a versão atual.');
    return result;
  }
  const fail = (message) => {
    log(`AVISO retenção: ${message}`);
    result.ok = false;
  };
  const banner = () => {
    if (!result.ok)
      log(
        '=== AVISO: a retenção dos arquivos das versões anteriores NÃO foi concluída; esta imagem só tem os da versão atual. ===',
      );
    return result;
  };

  let releases;
  try {
    releases = await listReleases({ repo, fetchImpl, token, timeoutMs });
  } catch (error) {
    fail(
      `não consegui listar os Releases de ${repo} (${error?.message ?? error}); seguindo só com a versão atual.`,
    );
    return banner();
  }

  mkdirSync(outDir, { recursive: true });
  const candidates = pickReleases(releases, { count, current });
  if (candidates.length === 0)
    fail('nenhum Release anterior com o artefato web-assets; seguindo só com a versão atual.');

  for (const release of candidates) {
    const work = mkdtempSync(join(tmpdir(), 'uniover-retain-'));
    try {
      const archive = await loadArchive(release, { work, fetchImpl, tar, timeoutMs });

      const extracted = join(work, 'out');
      mkdirSync(extracted);
      tar(['-xzf', archive, '-C', extracted, '--no-same-owner']);
      let copied = 0;
      for (const name of readdirSync(extracted)) {
        const source = join(extracted, name);
        // Confere de novo depois de extrair: só arquivo comum, com nome de arquivo com hash, e nunca por cima de um existente.
        if (!HASHED_ASSET.test(name) || !lstatSync(source).isFile()) continue;
        const target = join(outDir, name);
        if (existsSync(target)) continue;
        copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
        copied++;
      }
      result.versions.push(release.version);
      result.files += copied;
      log(`Retenção: v${release.version}: ${copied} arquivo(s) copiado(s).`);
    } catch (error) {
      fail(`v${release.version} ignorada (${error?.message ?? error}).`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return banner();
}

/**
 * Confere, no PWA no ar, que a imagem reteve de fato os arquivos das versões anteriores: para cada uma das últimas `count`
 * versões com artefato, o `main-*.js` e uma amostra de até `sample` arquivos com hash precisam responder 200. Devolve o que
 * faltou; no CLI cada falta vira um `::warning::` do GitHub Actions (a publicação já aconteceu e não é desfeita por isto).
 */
export async function checkLive({
  repo,
  url,
  count = DEFAULT_COUNT,
  current = null,
  sample = 8,
  fetchImpl = globalThis.fetch,
  tar = defaultTar,
  log = console.log,
  timeoutMs = REQUEST_TIMEOUT_MS,
  token = process.env.GITHUB_TOKEN,
}) {
  const result = { checked: 0, missing: [], problems: [] };
  if (!(count > 0)) return result;
  let releases;
  try {
    releases = await listReleases({ repo, fetchImpl, token, timeoutMs });
  } catch (error) {
    result.problems.push(`não consegui listar os Releases de ${repo} (${error?.message ?? error})`);
    return result;
  }
  const candidates = pickReleases(releases, { count, current });
  if (candidates.length === 0) {
    result.problems.push(
      'nenhum Release anterior com o artefato web-assets: não há o que reter ainda',
    );
    return result;
  }
  const base = url.replace(/\/+$/, '');
  for (const release of candidates) {
    const work = mkdtempSync(join(tmpdir(), 'uniover-check-'));
    try {
      const archive = await loadArchive(release, { work, fetchImpl, tar, timeoutMs });
      const names = inspectArchive(archive, { tar }).names.map(bare).sort();
      const mains = names.filter((name) => name.startsWith('main-'));
      const others = names.filter((name) => !name.startsWith('main-'));
      const step = Math.max(1, Math.floor(others.length / Math.max(1, sample)));
      const picked = [
        ...mains,
        ...others.filter((_, index) => index % step === 0).slice(0, sample),
      ];
      for (const name of picked) {
        result.checked++;
        let status = 0;
        try {
          const response = await fetchImpl(`${base}/${name}`, {
            method: 'HEAD',
            headers: { 'User-Agent': 'uniover-image-check' },
            signal: AbortSignal.timeout(timeoutMs),
          });
          status = response.status;
        } catch {
          status = 0;
        }
        if (status !== 200)
          result.missing.push(`v${release.version}: ${name} (HTTP ${status || 'sem resposta'})`);
      }
      log(`Conferência: v${release.version}: ${picked.length} arquivo(s) amostrado(s).`);
    } catch (error) {
      result.problems.push(
        `v${release.version} não pôde ser conferida (${error?.message ?? error})`,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return result;
}

function parseOptions(args) {
  const options = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--strict') options.strict = true;
    else if (arg.startsWith('--')) options[arg.slice(2)] = args[++i];
    else options._.push(arg);
  }
  return options;
}

/** Ponto de entrada de linha de comando; devolve o código de saída. */
export async function main(argv, { log = console.log, errorLog = console.error } = {}) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  try {
    if (command === 'pack') {
      const [dist, out] = options._;
      if (!dist || !out) throw new Error('uso: pack <pasta-do-build> <saida.tar.gz>');
      const files = packAssets(dist, out);
      log(`Artefato ${out}: ${files.length} arquivo(s) com hash.`);
      return 0;
    }
    if (command === 'covers') {
      const [archive, page] = options._;
      if (!archive || !page) throw new Error('uso: covers <artefato.tar.gz> <pagina.html>');
      const { names } = inspectArchive(archive);
      const missing = missingFromArchive(readFileSync(page, 'utf8'), names);
      if (missing.length > 0) {
        errorLog(`O artefato não tem o que a página no ar usa: ${missing.join(', ')}.`);
        return 1;
      }
      log('O artefato tem todos os arquivos com hash que a página no ar usa.');
      return 0;
    }
    if (command === 'fetch') {
      if (!options.repo || !options.out)
        throw new Error('uso: fetch --repo dono/nome --out <pasta>');
      const count = options.count === undefined ? DEFAULT_COUNT : Number(options.count);
      if (!Number.isInteger(count) || count < 0)
        throw new Error('--count precisa de um inteiro de 0 para cima');
      const result = await retain({
        repo: options.repo,
        outDir: options.out,
        count,
        current: options.current?.trim() || null,
        log,
      });
      return options.strict && !result.ok ? 1 : 0;
    }
    if (command === 'check-live') {
      if (!options.repo || !options.url)
        throw new Error(
          'uso: check-live --repo dono/nome --url https://endereco [--count 3] [--current 1.2.3]',
        );
      const result = await checkLive({
        repo: options.repo,
        url: options.url,
        count: options.count === undefined ? DEFAULT_COUNT : Number(options.count),
        current: options.current?.trim() || null,
        sample: options.sample === undefined ? undefined : Number(options.sample),
        log,
      });
      for (const line of result.missing)
        log(`::warning::A imagem no ar não reteve um arquivo de versão anterior: ${line}.`);
      for (const line of result.problems) log(`::warning::Retenção sem conferência: ${line}.`);
      if (result.missing.length === 0 && result.problems.length === 0)
        log(
          `A imagem no ar reteve os arquivos das versões anteriores (${result.checked} conferido(s)).`,
        );
      return options.strict && (result.missing.length > 0 || result.problems.length > 0) ? 1 : 0;
    }
    throw new Error('comando desconhecido (pack, covers, fetch ou check-live)');
  } catch (error) {
    errorLog(error?.message ?? String(error));
    // O `fetch` é de melhor esforço: um erro de uso ou inesperado também não derruba o build, a menos que seja rígido.
    return command === 'fetch' && !options.strict ? 0 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
