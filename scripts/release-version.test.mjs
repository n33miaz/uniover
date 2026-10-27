import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  baseRevision,
  bumpVersion,
  changelogSection,
  compareVersions,
  highestTag,
  prepare,
  run,
  verify,
} from './release-version.mjs';

const GIT = ['-c', 'user.name=teste', '-c', 'user.email=teste@exemplo.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];

function git(root, ...args) {
  return execFileSync('git', [...GIT, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function put(root, path, contents) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf8');
}

function read(root, path) {
  return readFileSync(join(root, path), 'utf8');
}

/** Escreve a versão em todos os arquivos que a repetem, como o repositório de verdade. */
function writeVersions(root, version) {
  put(root, 'VERSION', `${version}\n`);
  put(root, 'apps/web/package.json', `{\n  "name": "web",\n  "version": "${version}",\n  "scripts": {}\n}\n`);
  put(
    root,
    'apps/web/package-lock.json',
    `{\n  "name": "web",\n  "version": "${version}",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "web",\n      "version": "${version}",\n      "dependencies": {}\n    }\n  }\n}\n`,
  );
  put(root, 'apps/agent/pyproject.toml', `[project]\nname = "uniover-agent"\nversion = "${version}"\n`);
  put(
    root,
    'apps/agent/uv.lock',
    `version = 1\n\n[[package]]\nname = "outro"\nversion = "9.9.9"\n\n[[package]]\nname = "uniover-agent"\nversion = "${version}"\nsource = { editable = "." }\n`,
  );
  put(root, 'apps/api/Directory.Build.props', `<Project>\n  <PropertyGroup>\n    <Version>${version}</Version>\n  </PropertyGroup>\n</Project>\n`);
}

function commit(root, subject) {
  git(root, 'commit', '--allow-empty', '-q', '-m', subject);
  return git(root, 'rev-parse', 'HEAD');
}

/** Repositório de teste: v0.4.0 numa base, depois VERSION em `version`. */
function fixture(version = '0.4.0') {
  const root = mkdtempSync(join(tmpdir(), 'release-version-'));
  git(root, 'init', '-q', '-b', 'develop');
  put(root, 'CHANGELOG.md', '# Changelog\n\n## [0.4.0](x) (2026-10-01)\n\n\n### Features\n\n* **web:** antigo\n\n');
  writeVersions(root, version);
  git(root, 'add', '-A');
  commit(root, 'chore: base');
  return root;
}

function withFixture(version, body) {
  const root = fixture(version);
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('SemVer: compara e sobe versões', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(bumpVersion('0.4.3', 'patch'), '0.4.4');
  assert.equal(bumpVersion('0.4.3', 'minor'), '0.5.0');
  assert.equal(bumpVersion('0.4.3', 'major'), '1.0.0');
  assert.throws(() => compareVersions('0.5', '0.4.0'), /SemVer/);
  assert.throws(() => bumpVersion('0.4.3', 'huge'), /desconhecido/);
});

test('verify aceita uma versão maior que a maior tag', () =>
  withFixture('0.5.0', (root) => {
    git(root, 'tag', 'v0.4.0');
    git(root, 'tag', 'v0.4.3');
    git(root, 'tag', 'v0.4.10'); // a ordem é numérica, não de texto
    assert.match(verify(root), /0\.5\.0/);
  }));

test('verify aceita versão sem nenhuma tag', () =>
  withFixture('0.1.0', (root) => {
    assert.match(verify(root), /ainda não há tags/);
  }));

test('verify aceita versão igual à maior tag quando a tag aponta para este commit (redeploy)', () =>
  withFixture('0.5.0', (root) => {
    git(root, 'tag', '-a', 'v0.5.0', '-m', 'Release 0.5.0'); // anotada: a conferência olha o commit
    assert.match(verify(root), /0\.5\.0/);
  }));

test('verify recusa versão igual à maior tag quando o commit é outro', () =>
  withFixture('0.5.0', (root) => {
    git(root, 'tag', 'v0.5.0');
    commit(root, 'fix(web): depois da tag');
    assert.throws(() => verify(root), /igual à tag v0\.5\.0.*outro commit/s);
  }));

test('verify recusa versão menor que a maior tag', () =>
  withFixture('0.4.0', (root) => {
    git(root, 'tag', 'v0.4.3');
    assert.throws(() => verify(root), /menor que a última tag v0\.4\.3/);
  }));

test('verify ignora tags que não são SemVer puro', () =>
  withFixture('0.5.0', (root) => {
    git(root, 'tag', 'v0.4.0');
    git(root, 'tag', 'v9.9.9-rc.1');
    git(root, 'tag', 'v-nada');
    assert.equal(highestTag(root), 'v0.4.0');
    assert.match(verify(root), /0\.5\.0/);
  }));

test('verify recusa VERSION que não é SemVer', () =>
  withFixture('0.5.0', (root) => {
    put(root, 'VERSION', 'v0.5\n');
    assert.throws(() => verify(root), /SemVer/);
    put(root, 'VERSION', '0.5.0-rc.1\n');
    assert.throws(() => verify(root), /SemVer/);
  }));

test('verify recusa package.json diferente de VERSION', () =>
  withFixture('0.5.0', (root) => {
    put(root, 'apps/web/package.json', '{\n  "name": "web",\n  "version": "0.4.3"\n}\n');
    assert.throws(() => verify(root), /apps\/web\/package\.json está em 0\.4\.3, mas VERSION é 0\.5\.0/);
  }));

test('verify recusa lock, pyproject, uv.lock ou props diferentes de VERSION', () => {
  const cases = [
    ['apps/web/package-lock.json', /"version": "0\.5\.0"/g, '"version": "0.4.0"', /package-lock/],
    ['apps/agent/pyproject.toml', /0\.5\.0/, '0.4.0', /pyproject/],
    ['apps/agent/uv.lock', /(uniover-agent"\nversion = ")0\.5\.0/, '$10.4.0', /uv\.lock/],
    ['apps/api/Directory.Build.props', /0\.5\.0/, '0.4.0', /Directory\.Build\.props/],
  ];
  for (const [path, pattern, replacement, expected] of cases) {
    withFixture('0.5.0', (root) => {
      put(root, path, read(root, path).replace(pattern, replacement));
      assert.throws(() => verify(root), expected, path);
    });
  }
});

test('prepare patch sobe todos os arquivos e escreve a entrada só com feat, fix e perf', () =>
  withFixture('0.4.0', (root) => {
    git(root, 'tag', 'v0.4.0');
    const feat = commit(root, 'feat(web): mostrar a versão');
    const fix = commit(root, 'fix(api): devolver o commit');
    const perf = commit(root, 'perf: cortar o bundle');
    commit(root, 'chore: ferramentas');
    commit(root, 'docs: processo');

    assert.match(prepare(root, 'patch', '2026-10-28'), /0\.4\.1/);

    assert.equal(read(root, 'VERSION'), '0.4.1\n');
    assert.match(read(root, 'apps/web/package.json'), /"version": "0\.4\.1"/);
    const lock = read(root, 'apps/web/package-lock.json');
    assert.equal(lock.match(/"version": "0\.4\.1"/g).length, 2);
    assert.match(read(root, 'apps/agent/pyproject.toml'), /version = "0\.4\.1"/);
    assert.match(read(root, 'apps/agent/uv.lock'), /name = "uniover-agent"\nversion = "0\.4\.1"/);
    assert.match(read(root, 'apps/agent/uv.lock'), /name = "outro"\nversion = "9\.9\.9"/);
    assert.match(read(root, 'apps/api/Directory.Build.props'), /<Version>0\.4\.1<\/Version>/);

    const changelog = read(root, 'CHANGELOG.md');
    assert.ok(
      changelog.startsWith(
        '# Changelog\n\n## [0.4.1](https://github.com/n33miaz/uniover/compare/v0.4.0...v0.4.1) (2026-10-28)\n\n\n### Features\n\n',
      ),
    );
    assert.match(changelog, /### Features\n\n\* \*\*web:\*\* mostrar a versão\n/);
    assert.match(changelog, /### Bug Fixes\n\n\* \*\*api:\*\* devolver o commit\n/);
    assert.match(changelog, /### Performance Improvements\n\n\* cortar o bundle\n/);
    assert.doesNotMatch(changelog.split('## [0.4.0]')[0], /ferramentas|processo/);
    assert.ok(changelog.includes('## [0.4.0](x) (2026-10-01)'), 'a entrada antiga continua embaixo');
    assert.equal(changelog.indexOf('## [0.4.1]') < changelog.indexOf('## [0.4.0]'), true);

    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'chore: release 0.4.1');
    assert.match(verify(root), /0\.4\.1/);
  }));

test('prepare mantém o fim de linha CRLF do CHANGELOG', () =>
  withFixture('0.4.0', (root) => {
    git(root, 'tag', 'v0.4.0');
    commit(root, 'feat: algo');
    put(root, 'CHANGELOG.md', read(root, 'CHANGELOG.md').replace(/\n/g, '\r\n'));
    prepare(root, 'patch', '2026-10-28');
    const changelog = read(root, 'CHANGELOG.md');
    assert.ok(changelog.startsWith('# Changelog\r\n\r\n## [0.4.1]'));
    assert.equal(changelog.replace(/\r\n/g, '').includes('\n'), false, 'nenhum LF solto');
  }));

test('prepare minor e major zeram o que vem depois', () => {
  withFixture('0.4.7', (root) => {
    git(root, 'tag', 'v0.4.7');
    commit(root, 'feat: algo');
    prepare(root, 'minor', '2026-10-28');
    assert.equal(read(root, 'VERSION'), '0.5.0\n');
  });
  withFixture('0.4.7', (root) => {
    git(root, 'tag', 'v0.4.7');
    commit(root, 'feat: algo');
    prepare(root, 'major', '2026-10-28');
    assert.equal(read(root, 'VERSION'), '1.0.0\n');
  });
});

test('prepare conta só os commits depois da última tag', () =>
  withFixture('0.4.0', (root) => {
    commit(root, 'feat(web): ja publicado');
    git(root, 'tag', 'v0.4.0');
    commit(root, 'fix(web): novo');
    prepare(root, 'patch', '2026-10-28');
    const top = read(root, 'CHANGELOG.md').split('## [0.4.0]')[0];
    assert.match(top, /novo/);
    assert.doesNotMatch(top, /ja publicado/);
  }));

test('prepare sem feat, fix ou perf ainda escreve notas para a Release', () =>
  withFixture('0.4.0', (root) => {
    git(root, 'tag', 'v0.4.0');
    commit(root, 'chore: so manutencao');
    prepare(root, 'patch', '2026-10-28');
    assert.match(read(root, 'CHANGELOG.md'), /### Maintenance\n\n\* no user-facing changes/);
  }));

test('prepare parte da maior tag quando VERSION ficou para trás', () =>
  withFixture('0.4.0', (root) => {
    git(root, 'tag', 'v0.4.3');
    commit(root, 'fix: algo');
    prepare(root, 'patch', '2026-10-28');
    assert.equal(read(root, 'VERSION'), '0.4.4\n');
    assert.match(read(root, 'CHANGELOG.md'), /compare\/v0\.4\.3\.\.\.v0\.4\.4/);
  }));

test('tag fora da história: a base é o último commit que mexeu em VERSION', () =>
  withFixture('0.4.0', (root) => {
    const versionCommit = git(root, 'rev-parse', 'HEAD');
    commit(root, 'feat(web): depois da versao');
    // A tag mora numa história paralela (cópia publicada), que não é ancestral de HEAD.
    git(root, 'checkout', '-q', '--orphan', 'publicado');
    commit(root, 'chore: copia publicada');
    git(root, 'tag', 'v0.4.3');
    git(root, 'checkout', '-q', '-f', 'develop');
    commit(root, 'fix(api): depois da copia');

    assert.equal(highestTag(root), 'v0.4.3');
    assert.equal(baseRevision(root, 'v0.4.3'), versionCommit);

    prepare(root, 'patch', '2026-10-28');
    assert.equal(read(root, 'VERSION'), '0.4.4\n');
    const top = read(root, 'CHANGELOG.md').split('## [0.4.0]')[0];
    assert.match(top, /compare\/v0\.4\.3\.\.\.v0\.4\.4/);
    assert.match(top, /depois da versao/);
    assert.match(top, /depois da copia/);
  }));

test('sem tag e sem commit em VERSION a base não existe', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-version-'));
  try {
    git(root, 'init', '-q', '-b', 'develop');
    commit(root, 'chore: vazio');
    assert.throws(() => baseRevision(root, null), /não achei de onde contar/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('o manifest antigo do release-please serve de base quando VERSION nunca mudou', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-version-'));
  try {
    git(root, 'init', '-q', '-b', 'develop');
    put(root, '.release-please-manifest.json', '{ ".": "0.4.3" }\n');
    git(root, 'add', '-A');
    const marker = commit(root, 'chore: release 0.4.3');
    commit(root, 'feat: depois');
    assert.equal(baseRevision(root, 'v0.4.3'), marker); // a tag não existe: cai no manifest
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a entrada do changelog sai no formato das existentes', () => {
  const section = changelogSection(
    '0.5.0',
    '0.4.3',
    [
      { sha: 'a'.repeat(40), subject: 'feat(web): show the version' },
      { sha: 'b'.repeat(40), subject: 'chore: update tooling' },
    ],
    '2026-10-27',
  );
  assert.equal(
    section,
    `## [0.5.0](https://github.com/n33miaz/uniover/compare/v0.4.3...v0.5.0) (2026-10-27)\n\n\n### Features\n\n* **web:** show the version\n\n`,
  );
});

test('a linha de comando recusa argumentos inválidos', () =>
  withFixture('0.5.0', (root) => {
    assert.throws(() => run([], root), /uso:/);
    assert.throws(() => run(['--prepare', 'huge'], root), /patch\|minor\|major/);
    assert.throws(() => run(['--prepare', 'patch', '--date', '27/10/2026'], root), /data inválida/);
    assert.throws(() => run(['--prepare', 'patch', '--nada'], root), /uso:/);
    assert.match(run(['--verify'], root), /0\.5\.0/);
  }));
