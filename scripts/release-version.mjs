#!/usr/bin/env node
// Versão a cada publicação. O arquivo VERSION na raiz é a única fonte de verdade; os demais lugares são escritos
// por --prepare e conferidos por --verify (que o deploy roda antes de migrar e publicar).
//
//   node scripts/release-version.mjs --verify
//   node scripts/release-version.mjs --prepare <patch|minor|major> [--date AAAA-MM-DD]
//
// Além da versão do app, o modules.json guarda uma versão informativa por módulo (o deploy segue sendo um serviço só).
// --prepare sobe só os módulos cujos arquivos mudaram desde a última publicação; --verify confere que o arquivo é válido.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'https://github.com/n33miaz/uniover';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CONVENTIONAL = /^(feat|fix|perf)(?:\(([^)!]+)\))?(!)?: (.+)$/;
const KINDS = ['patch', 'minor', 'major'];
const MODULES_FILE = 'modules.json';
const BREAKING_SUBJECT = /^\w+(?:\([^)]*\))?!:/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

// Os módulos versionados, na ordem em que aparecem no modules.json e no CHANGELOG. As chaves são as do arquivo.
export const MODULE_NAMES = ['identity', 'devices', 'tv', 'training', 'web', 'agent'];
const MODULE_LABELS = { identity: 'Identity', devices: 'Devices', tv: 'TV', training: 'Training', web: 'Web', agent: 'Agent' };

// Os caminhos de cada módulo (prefixos, com a barra final nas pastas). O módulo de API traz a pasta inteira (o projeto,
// os Contracts e o transporte), a pasta de tela com o mesmo assunto e as mensagens do agente que ele atende. Testes não
// contam: não mudam o que é publicado. `web` é o app Angular menos as pastas de módulo acima (evita subir duas vezes).
const MODULE_PATHS = {
  identity: ['apps/api/src/Modules/Identity/', 'apps/web/src/app/modules/settings/'],
  devices: [
    'apps/api/src/Modules/Devices/',
    'apps/web/src/app/modules/devices/',
    'apps/web/src/app/modules/pc/',
    'contracts/agent/messages/pc.',
    'contracts/agent/messages/agent.',
    'contracts/agent/messages/api.',
    'contracts/agent/messages/command.',
  ],
  tv: ['apps/api/src/Modules/Tv/', 'apps/web/src/app/modules/tv/', 'contracts/agent/messages/tv.'],
  training: ['apps/api/src/Modules/Training/', 'apps/web/src/app/modules/training/'],
  agent: ['apps/agent/'],
};
const WEB_PREFIX = 'apps/web/';

// Cada lugar onde a versão aparece além de VERSION: como ler, e como trocar.
const VERSION_FILES = [
  {
    path: 'apps/web/package.json',
    read: (text) => /^\s*"version": "([^"]+)"/m.exec(text)?.[1],
    write: (text, version) => text.replace(/^(\s*"version": ")[^"]+"/m, `$1${version}"`),
  },
  {
    path: 'apps/web/package-lock.json',
    read: (text) => /^\s*"version": "([^"]+)"/m.exec(text)?.[1],
    write: (text, version) => text.replace(/^(\s*"version": ")[^"]+"/m, `$1${version}"`),
  },
  {
    path: 'apps/web/package-lock.json',
    label: 'apps/web/package-lock.json (pacote raiz)',
    read: (text) => /"packages": \{\s+"": \{\s+"name": "web",\s+"version": "([^"]+)"/.exec(text)?.[1],
    write: (text, version) =>
      text.replace(/("packages": \{\s+"": \{\s+"name": "web",\s+"version": ")[^"]+"/, `$1${version}"`),
  },
  {
    path: 'apps/agent/pyproject.toml',
    read: (text) => /^version = "([^"]+)"/m.exec(text)?.[1],
    write: (text, version) => text.replace(/^version = "[^"]+"/m, `version = "${version}"`),
  },
  {
    path: 'apps/agent/uv.lock',
    read: (text) => /name = "uniover-agent"\r?\nversion = "([^"]+)"/.exec(text)?.[1],
    write: (text, version) =>
      text.replace(/(name = "uniover-agent"\r?\nversion = ")[^"]+"/, `$1${version}"`),
  },
  {
    path: 'apps/api/Directory.Build.props',
    read: (text) => /<Version>([^<]+)<\/Version>/.exec(text)?.[1],
    write: (text, version) => text.replace(/<Version>[^<]+<\/Version>/, `<Version>${version}</Version>`),
  },
];

export function parseVersion(value) {
  const match = SEMVER.exec(String(value).trim());
  if (!match) throw new Error(`versão SemVer inválida: '${value}'`);
  return match.slice(1).map(Number);
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function bumpVersion(version, kind) {
  const [major, minor, patch] = parseVersion(version);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`tipo de versão desconhecido '${kind}'; use ${KINDS.join(', ')}`);
}

export function conventionalCommit(subject) {
  const match = CONVENTIONAL.exec(subject.trim());
  if (!match) return null;
  const [, type, scope, , title] = match;
  return { type, scope: scope ?? null, title };
}

/**
 * O quanto um commit pesa na versão de um módulo que ele tocou: `!` no assunto (qualquer tipo) ou `BREAKING CHANGE:` no
 * corpo é major, feat é minor, fix e perf são patch. Qualquer outro tipo (chore, refactor, docs...) que mexeu nos
 * arquivos do módulo também é patch: o arquivo mudou, então a versão sobe.
 */
export function commitLevel(subject, body = '') {
  if (BREAKING_SUBJECT.test(subject.trim()) || BREAKING_FOOTER.test(body)) return 'major';
  return conventionalCommit(subject)?.type === 'feat' ? 'minor' : 'patch';
}

/** Os módulos a que um arquivo (caminho relativo à raiz, com `/`) pertence. Pode ser mais de um, ou nenhum. */
export function modulesForFile(file) {
  const found = new Set();
  for (const [name, prefixes] of Object.entries(MODULE_PATHS)) {
    if (prefixes.some((prefix) => file.startsWith(prefix))) found.add(name);
  }
  // O app web é o que sobra de apps/web/ depois das pastas de módulo: se algum módulo o reivindicou, o web não sobe.
  if (file.startsWith(WEB_PREFIX) && found.size === 0) found.add('web');
  return MODULE_NAMES.filter((name) => found.has(name));
}

/** Os módulos tocados por um commit, na ordem de MODULE_NAMES. */
export function commitModules(files) {
  const found = new Set(files.flatMap(modulesForFile));
  return MODULE_NAMES.filter((name) => found.has(name));
}

const LEVEL_ORDER = { patch: 0, minor: 1, major: 2 };

/** O tipo de subida de cada módulo tocado: o maior entre os commits que o tocaram. Módulo sem commit não aparece. */
export function moduleBumps(commits) {
  const bumps = new Map();
  for (const commit of commits) {
    const level = commitLevel(commit.subject, commit.body ?? '');
    for (const name of commit.modules ?? []) {
      const current = bumps.get(name);
      if (current === undefined || LEVEL_ORDER[level] > LEVEL_ORDER[current]) bumps.set(name, level);
    }
  }
  return bumps;
}

const TYPE_HEADINGS = { feat: 'Features', fix: 'Bug Fixes', perf: 'Performance Improvements' };

/** As entradas feat/fix/perf dos commits, uma seção por tipo, no nível de título pedido. Vazio se não houver nenhuma. */
function typeSections(commits, level) {
  const groups = { feat: [], fix: [], perf: [] };
  for (const commit of commits) {
    const parsed = conventionalCommit(commit.subject);
    if (parsed) groups[parsed.type].push(parsed);
  }
  return Object.entries(groups)
    .filter(([, entries]) => entries.length > 0)
    .map(([type, entries]) => {
      // Sem link de commit: o PR entra na develop por rebase e os SHAs mudam, então um link escrito antes não valeria.
      const lines = entries.map(({ scope, title }) => `* ${scope ? `**${scope}:** ` : ''}${title}`);
      return `${level} ${TYPE_HEADINGS[type]}\n\n${lines.join('\n')}`;
    });
}

/**
 * A entrada de uma publicação. `moduleReleases` (`[{ name, version }]`, na ordem do modules.json) são os módulos que
 * subiram: cada um ganha um título `### <módulo> <versão>` com as entradas dos commits que o tocaram (`commit.modules`),
 * e um commit que tocou dois módulos aparece nos dois. As entradas de commits sem módulo ficam no formato de sempre, no
 * topo. O título de módulo é `###` e os tipos dentro dele `####`: o job de release corta a nota no próximo `## `.
 */
export function changelogSection(version, previousVersion, commits, date, moduleReleases = []) {
  const unowned = commits.filter((commit) => (commit.modules ?? []).length === 0);
  const sections = typeSections(moduleReleases.length === 0 ? commits : unowned, '###');

  for (const { name, version: moduleVersion } of moduleReleases) {
    const touched = commits.filter((commit) => (commit.modules ?? []).includes(name));
    const inner = typeSections(touched, '####');
    // Módulo que subiu só por manutenção (chore, refactor, docs...) também diz que não há mudança visível.
    if (inner.length === 0) inner.push('#### Maintenance\n\n* no user-facing changes');
    sections.push(`### ${MODULE_LABELS[name] ?? name} ${moduleVersion}\n\n${inner.join('\n\n')}`);
  }
  // A Release precisa de notas: uma publicação sem feat/fix/perf (só manutenção) ganha uma linha que o diz.
  if (sections.length === 0) sections.push('### Maintenance\n\n* no user-facing changes');

  const heading = `## [${version}](${REPOSITORY}/compare/v${previousVersion}...v${version}) (${date})`;
  return `${heading}\n\n\n${sections.join('\n\n\n')}\n\n`;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitSucceeds(root, args) {
  try {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readText(root, path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function writeText(root, path, contents) {
  writeFileSync(resolve(root, path), contents, 'utf8');
}

/** Lê o VERSION e exige SemVer puro (sem prefixo `v`, sem pré-lançamento). */
export function readVersion(root) {
  return parseVersion(readText(root, 'VERSION').trim()).join('.');
}

/**
 * Lê o modules.json (um objeto módulo -> SemVer, com exatamente as chaves de MODULE_NAMES). Devolve `{ modules, problems }`:
 * `modules` é o que deu para ler, `problems` o que está errado (arquivo ausente, JSON inválido, chave faltando ou sobrando,
 * versão que não é SemVer).
 */
export function readModules(root) {
  let raw;
  try {
    raw = readText(root, MODULES_FILE);
  } catch {
    return { modules: null, problems: [`${MODULES_FILE} não existe`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { modules: null, problems: [`${MODULES_FILE} não é um JSON válido`] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { modules: null, problems: [`${MODULES_FILE} deve ser um objeto módulo -> versão`] };
  }
  const problems = [];
  const modules = {};
  for (const name of MODULE_NAMES) {
    if (!(name in parsed)) problems.push(`${MODULES_FILE} não tem o módulo '${name}'`);
    else if (typeof parsed[name] !== 'string' || !SEMVER.test(parsed[name])) {
      problems.push(`${MODULES_FILE}: a versão de '${name}' não é SemVer: ${JSON.stringify(parsed[name])}`);
    } else modules[name] = parsed[name];
  }
  for (const name of Object.keys(parsed)) {
    if (!MODULE_NAMES.includes(name)) problems.push(`${MODULES_FILE} tem um módulo desconhecido '${name}'`);
  }
  return { modules, problems };
}

/** O modules.json que a tag publicou, ou null se a tag não o tinha (a primeira publicação com versões por módulo). */
function taggedModules(root, tag) {
  if (tag === null) return null;
  try {
    const parsed = JSON.parse(git(root, ['show', `${tag}:${MODULES_FILE}`]));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Escreve o modules.json com chaves na ordem de MODULE_NAMES, recuo de 2 espaços e LF final. */
function writeModules(root, modules) {
  const ordered = Object.fromEntries(MODULE_NAMES.map((name) => [name, modules[name]]));
  writeText(root, MODULES_FILE, `${JSON.stringify(ordered, null, 2)}\n`);
}

/** A maior tag `v<SemVer>` do repositório, ou null. Tags que não seguem o padrão são ignoradas. */
export function highestTag(root) {
  const tags = git(root, ['tag', '--list', 'v*', '--sort=-v:refname'])
    .split(/\r?\n/)
    .filter((tag) => TAG.test(tag));
  if (tags.length === 0) return null;
  return tags.reduce((best, tag) => (compareVersions(tag.slice(1), best.slice(1)) > 0 ? tag : best));
}

function tagCommit(root, tag) {
  return git(root, ['rev-parse', `${tag}^{commit}`]);
}

/** Falha (lançando Error) se VERSION não puder ser publicada agora. */
export function verify(root) {
  const version = readVersion(root);
  const problems = [];

  for (const file of VERSION_FILES) {
    const label = file.label ?? file.path;
    const found = file.read(readText(root, file.path));
    if (found !== version) problems.push(`${label} está em ${found ?? 'sem versão'}, mas VERSION é ${version}`);
  }

  const tag = highestTag(root);

  const { modules, problems: moduleProblems } = readModules(root);
  problems.push(...moduleProblems);
  // Uma versão de módulo nunca anda para trás em relação à que a última tag publicou.
  const published = taggedModules(root, tag);
  if (modules !== null && published !== null) {
    for (const name of MODULE_NAMES) {
      if (SEMVER.test(String(published[name])) && name in modules && compareVersions(modules[name], published[name]) < 0) {
        problems.push(`${MODULES_FILE}: '${name}' está em ${modules[name]}, menor que ${published[name]} da tag ${tag}`);
      }
    }
  }

  if (tag !== null) {
    const order = compareVersions(version, tag.slice(1));
    if (order < 0) {
      problems.push(`VERSION ${version} é menor que a última tag ${tag}`);
    } else if (order === 0 && tagCommit(root, tag) !== git(root, ['rev-parse', 'HEAD'])) {
      problems.push(`VERSION ${version} é igual à tag ${tag}, que aponta para outro commit: suba a versão`);
    }
  }

  if (problems.length > 0) throw new Error(problems.join('\n'));
  return tag === null
    ? `Versão ${version} pronta para publicar (ainda não há tags).`
    : `Versão ${version} pronta para publicar (última tag ${tag}).`;
}

/**
 * De onde começam os commits da próxima entrada: a maior tag, se ela está na história; senão o último commit que
 * mexeu em VERSION; senão o último que mexeu no manifest antigo do release-please.
 */
export function baseRevision(root, tag) {
  if (tag !== null && gitSucceeds(root, ['merge-base', '--is-ancestor', tag, 'HEAD'])) return tag;
  for (const path of ['VERSION', '.release-please-manifest.json']) {
    const sha = git(root, ['log', '-1', '--format=%H', '--', path]);
    if (sha) return sha;
  }
  throw new Error('não achei de onde contar os commits: nenhuma tag na história e nenhum commit em VERSION');
}

/** Os commits depois de `base`, cada um com o corpo, os arquivos que tocou e os módulos a que eles pertencem. */
function commitsSince(root, base) {
  // Depois do último \x1f vêm os nomes dos arquivos do commit (--name-only), um por linha.
  const output = git(root, [
    '-c',
    'core.quotepath=off',
    'log',
    `${base}..HEAD`,
    '--no-merges',
    '--reverse',
    '--name-only',
    '--format=%x1e%H%x1f%s%x1f%b%x1f',
  ]);
  return output
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, body, names] = record.split('\x1f');
      const files = names.split(/\r?\n/).filter(Boolean);
      return { sha, subject, body: body.trim(), files, modules: commitModules(files) };
    });
}

/**
 * As versões novas dos módulos tocados pelos commits: cada um sobe pelo maior tipo entre os commits que o tocaram, a partir
 * do maior entre o modules.json e o da última tag. Devolve `{ next, releases }` (`releases` na ordem de MODULE_NAMES).
 */
function bumpModules(root, tag, commits) {
  const { modules, problems } = readModules(root);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  const published = taggedModules(root, tag);
  const bumps = moduleBumps(commits);
  const next = { ...modules };
  const releases = [];
  for (const name of MODULE_NAMES) {
    const kind = bumps.get(name);
    if (kind === undefined) continue;
    const behind = published !== null && SEMVER.test(String(published[name])) && compareVersions(published[name], modules[name]) > 0;
    next[name] = bumpVersion(behind ? published[name] : modules[name], kind);
    releases.push({ name, version: next[name] });
  }
  return { next, releases };
}

/** Sobe VERSION e os arquivos que a repetem, escreve o modules.json e a entrada no topo do CHANGELOG. */
export function prepare(root, kind, date) {
  if (!KINDS.includes(kind)) throw new Error(`use --prepare ${KINDS.join('|')}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('data inválida; use AAAA-MM-DD');

  const tag = highestTag(root);
  const current = readVersion(root);
  // A nova versão sempre passa a maior entre VERSION e a última tag, qualquer que seja o que ficou para trás.
  const from = tag !== null && compareVersions(tag.slice(1), current) > 0 ? tag.slice(1) : current;
  const next = bumpVersion(from, kind);
  const baseRev = baseRevision(root, tag);
  const commits = commitsSince(root, baseRev);
  const moduleVersions = bumpModules(root, tag, commits);

  writeText(root, 'VERSION', `${next}\n`);
  writeModules(root, moduleVersions.next);
  for (const file of VERSION_FILES) {
    const text = readText(root, file.path);
    if (file.read(text) === undefined) throw new Error(`não encontrei a versão em ${file.path}`);
    writeText(root, file.path, file.write(text, next));
  }

  const raw = readText(root, 'CHANGELOG.md');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'; // mantém o fim de linha que o arquivo já tinha
  const changelog = raw.replace(/\r\n/g, '\n');
  if (!changelog.startsWith('# Changelog\n\n')) throw new Error('cabeçalho inesperado no CHANGELOG.md');
  const section = changelogSection(next, from, commits, date, moduleVersions.releases);
  const updated = changelog.replace('# Changelog\n\n', `# Changelog\n\n${section}`);
  writeText(root, 'CHANGELOG.md', eol === '\n' ? updated : updated.replace(/\n/g, eol));
  const bumped = moduleVersions.releases.map(({ name, version }) => `${name} ${version}`).join(', ');
  return `Versão ${next} preparada (de ${from}, ${commits.length} commit(s) desde ${baseRev.slice(0, 12)}). Módulos: ${bumped || 'nenhum subiu'}.`;
}

export function run(argv, root) {
  const [command, ...rest] = argv;
  if (command === '--verify' && rest.length === 0) return verify(root);

  if (command === '--prepare') {
    const kind = rest[0];
    let date = new Date().toISOString().slice(0, 10);
    const option = rest.slice(1);
    if (option.length === 2 && option[0] === '--date') date = option[1];
    else if (option.length !== 0) throw new Error('uso: --prepare <patch|minor|major> [--date AAAA-MM-DD]');
    return prepare(root, kind, date);
  }

  throw new Error('uso: --verify | --prepare <patch|minor|major> [--date AAAA-MM-DD]');
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === here) {
  try {
    console.log(run(process.argv.slice(2), resolve(here, '..', '..')));
  } catch (error) {
    if (process.env.GITHUB_ACTIONS) console.error(`::error::${error.message.split('\n').join('%0A')}`);
    else console.error(error.message);
    process.exitCode = 1;
  }
}
