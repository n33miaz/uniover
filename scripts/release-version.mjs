#!/usr/bin/env node
// Versão a cada publicação. O arquivo VERSION na raiz é a única fonte de verdade; os demais lugares são escritos
// por --prepare e conferidos por --verify (que o deploy roda antes de migrar e publicar).
//
//   node scripts/release-version.mjs --verify
//   node scripts/release-version.mjs --prepare <patch|minor|major> [--date AAAA-MM-DD]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'https://github.com/n33miaz/uniover';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CONVENTIONAL = /^(feat|fix|perf)(?:\(([^)!]+)\))?(!)?: (.+)$/;
const KINDS = ['patch', 'minor', 'major'];

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

export function changelogSection(version, previousVersion, commits, date) {
  const groups = { feat: [], fix: [], perf: [] };
  for (const commit of commits) {
    const parsed = conventionalCommit(commit.subject);
    if (parsed) groups[parsed.type].push(parsed);
  }

  const headings = { feat: 'Features', fix: 'Bug Fixes', perf: 'Performance Improvements' };
  const sections = Object.entries(groups)
    .filter(([, entries]) => entries.length > 0)
    .map(([type, entries]) => {
      // Sem link de commit: o PR entra na develop por rebase e os SHAs mudam, então um link escrito antes não valeria.
      const lines = entries.map(({ scope, title }) => `* ${scope ? `**${scope}:** ` : ''}${title}`);
      return `### ${headings[type]}\n\n${lines.join('\n')}`;
    });
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

function commitsSince(root, base) {
  const output = git(root, ['log', `${base}..HEAD`, '--no-merges', '--reverse', '--format=%H%x1f%s%x1e']);
  return output
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, subject] = record.split('\x1f');
      return { sha, subject };
    });
}

/** Sobe VERSION e os arquivos que a repetem, e escreve a entrada no topo do CHANGELOG. */
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

  writeText(root, 'VERSION', `${next}\n`);
  for (const file of VERSION_FILES) {
    const text = readText(root, file.path);
    if (file.read(text) === undefined) throw new Error(`não encontrei a versão em ${file.path}`);
    writeText(root, file.path, file.write(text, next));
  }

  const raw = readText(root, 'CHANGELOG.md');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'; // mantém o fim de linha que o arquivo já tinha
  const changelog = raw.replace(/\r\n/g, '\n');
  if (!changelog.startsWith('# Changelog\n\n')) throw new Error('cabeçalho inesperado no CHANGELOG.md');
  const section = changelogSection(next, from, commits, date);
  const updated = changelog.replace('# Changelog\n\n', `# Changelog\n\n${section}`);
  writeText(root, 'CHANGELOG.md', eol === '\n' ? updated : updated.replace(/\n/g, eol));
  return `Versão ${next} preparada (de ${from}, ${commits.length} commit(s) desde ${baseRev.slice(0, 12)}).`;
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
