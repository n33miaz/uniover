import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  MODULE_NAMES,
  baseRevision,
  bumpVersion,
  changelogSection,
  commitLevel,
  commitModules,
  compareVersions,
  highestTag,
  moduleBumps,
  modulesForFile,
  prepare,
  readModules,
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

/** O modules.json com a mesma versão em todos os módulos, ou com as trocas pedidas. */
function modulesJson(version, overrides = {}) {
  const modules = Object.fromEntries(MODULE_NAMES.map((name) => [name, overrides[name] ?? version]));
  return `${JSON.stringify(modules, null, 2)}\n`;
}

/** Escreve a versão em todos os arquivos que a repetem, como o repositório de verdade. */
function writeVersions(root, version) {
  put(root, 'VERSION', `${version}\n`);
  put(root, 'modules.json', modulesJson(version));
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

/** Um commit que de fato mexe em arquivos (os caminhos decidem quais módulos sobem). */
function commitFiles(root, subject, ...paths) {
  for (const path of paths) put(root, path, `${path} ${subject}\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', subject);
  return git(root, 'rev-parse', 'HEAD');
}

const API = 'apps/api/src/Modules';

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

test('cada arquivo pertence ao módulo dos seus caminhos', () => {
  assert.deepEqual(modulesForFile(`${API}/Tv/UniOver.Modules.Tv/TvModule.cs`), ['tv']);
  assert.deepEqual(modulesForFile(`${API}/Tv/UniOver.Modules.Tv.Contracts/ITvModule.cs`), ['tv']);
  assert.deepEqual(modulesForFile(`${API}/Devices/UniOver.Modules.Devices.Transport.WebSocket/Hub.cs`), ['devices']);
  assert.deepEqual(modulesForFile(`${API}/Identity/UniOver.Modules.Identity/IdentityModule.cs`), ['identity']);
  assert.deepEqual(modulesForFile(`${API}/Training/UniOver.Modules.Training/X.cs`), ['training']);
  assert.deepEqual(modulesForFile(`${API}/Shopping/UniOver.Modules.Shopping/X.cs`), ['shopping']);
  assert.deepEqual(modulesForFile('apps/web/src/app/modules/shopping/shopping.page.ts'), ['shopping']);
  assert.deepEqual(modulesForFile('apps/web/src/app/modules/tv/tv.page.ts'), ['tv']);
  assert.deepEqual(modulesForFile('apps/web/src/app/modules/settings/profile.page.ts'), ['identity']);
  assert.deepEqual(modulesForFile('apps/web/src/app/modules/pc/pc-page.ts'), ['devices']);
  assert.deepEqual(modulesForFile('apps/web/src/app/modules/training/x.ts'), ['training']);
  assert.deepEqual(modulesForFile('contracts/agent/messages/tv.key.v3.schema.json'), ['tv']);
  assert.deepEqual(modulesForFile('contracts/agent/messages/pc.key.v1.schema.json'), ['devices']);
  assert.deepEqual(modulesForFile('contracts/agent/messages/agent.hello.v1.schema.json'), ['devices']);
  assert.deepEqual(modulesForFile('apps/agent/src/uniover_agent/main.py'), ['agent']);
});

test('o web é o app menos as pastas de módulo; o que não tem dono não conta', () => {
  assert.deepEqual(modulesForFile('apps/web/src/app/core/auth/auth-api.ts'), ['web']);
  assert.deepEqual(modulesForFile('apps/web/src/app/modules/home/home.page.ts'), ['web']);
  assert.deepEqual(modulesForFile('apps/web/package.json'), ['web']);
  for (const free of [
    'apps/api/src/UniOver.Host/Program.cs',
    'apps/api/src/UniOver.BuildingBlocks.Web/X.cs',
    'apps/api/tests/UniOver.Modules.Tv.Tests/X.cs',
    'modules.json',
    'CHANGELOG.md',
    'VERSION',
    'scripts/release-version.mjs',
    'contracts/http/openapi.json',
  ]) {
    assert.deepEqual(modulesForFile(free), [], free);
  }
});

test('um commit com arquivos de dois módulos conta nos dois, na ordem do modules.json', () => {
  assert.deepEqual(
    commitModules(['apps/agent/a.py', 'apps/web/src/app/modules/tv/a.ts', `${API}/Tv/UniOver.Modules.Tv/a.cs`]),
    ['tv', 'agent'],
  );
  assert.deepEqual(commitModules([]), []);
});

test('o tipo do commit decide o quanto o módulo sobe', () => {
  assert.equal(commitLevel('feat(web): algo'), 'minor');
  assert.equal(commitLevel('fix(api): algo'), 'patch');
  assert.equal(commitLevel('perf: algo'), 'patch');
  assert.equal(commitLevel('chore: algo'), 'patch', 'arquivo do módulo mudou: sobe o patch');
  assert.equal(commitLevel('mensagem sem tipo'), 'patch');
  assert.equal(commitLevel('feat(api)!: muda o contrato'), 'major');
  assert.equal(commitLevel('refactor!: troca tudo'), 'major');
  assert.equal(commitLevel('fix: algo', 'detalhe\n\nBREAKING CHANGE: remove o campo'), 'major');
  assert.equal(commitLevel('fix: algo', 'BREAKING-CHANGE: remove o campo'), 'major');
  assert.equal(commitLevel('fix: algo', 'isto não é BREAKING CHANGE: no meio da linha'), 'patch');
});

test('cada módulo sobe pelo maior tipo entre os commits que o tocaram', () => {
  const bumps = moduleBumps([
    { subject: 'fix(api): a', body: '', modules: ['tv'] },
    { subject: 'feat(web): b', body: '', modules: ['tv', 'web'] },
    { subject: 'chore: c', body: '', modules: ['agent'] },
    { subject: 'feat: sem arquivos de módulo', body: '', modules: [] },
    { subject: 'fix(api)!: d', body: '', modules: ['devices'] },
  ]);
  assert.deepEqual(
    [...bumps],
    [
      ['tv', 'minor'],
      ['web', 'minor'],
      ['agent', 'patch'],
      ['devices', 'major'],
    ],
  );
});

test('readModules aceita o arquivo certo e descreve o que está errado', () =>
  withFixture('0.5.0', (root) => {
    assert.deepEqual(readModules(root).problems, []);
    put(root, 'modules.json', '{ nao e json');
    assert.match(readModules(root).problems[0], /JSON válido/);
    put(root, 'modules.json', '[]\n');
    assert.match(readModules(root).problems[0], /objeto/);
    put(root, 'modules.json', JSON.stringify({ tv: '0.5', web: 5, devices: '0.5.0', extra: '1.0.0' }));
    const problems = readModules(root).problems.join('\n');
    assert.match(problems, /não tem o módulo 'identity'/);
    assert.match(problems, /'tv' não é SemVer/);
    assert.match(problems, /'web' não é SemVer/);
    assert.match(problems, /desconhecido 'extra'/);
    rmSync(join(root, 'modules.json'));
    assert.match(readModules(root).problems[0], /não existe/);
  }));

test('verify recusa modules.json ausente, inválido ou com módulo atrás da tag', () => {
  withFixture('0.5.0', (root) => {
    rmSync(join(root, 'modules.json'));
    assert.throws(() => verify(root), /modules\.json não existe/);
  });
  withFixture('0.5.0', (root) => {
    put(root, 'modules.json', modulesJson('0.5.0', { tv: 'x' }));
    assert.throws(() => verify(root), /'tv' não é SemVer/);
  });
  withFixture('0.5.0', (root) => {
    put(root, 'modules.json', modulesJson('0.5.0', { tv: '0.6.0' }));
    git(root, 'add', '-A');
    commit(root, 'chore: modulos');
    git(root, 'tag', 'v0.5.0');
    put(root, 'VERSION', '0.5.1\n');
    put(root, 'modules.json', modulesJson('0.5.0', { tv: '0.5.9' }));
    assert.throws(() => verify(root), /'tv' está em 0\.5\.9, menor que 0\.6\.0 da tag v0\.5\.0/);
  });
});

test('verify aceita módulos iguais ou maiores que os da tag, e tag sem modules.json', () => {
  withFixture('0.5.0', (root) => {
    git(root, 'tag', 'v0.4.0'); // o arquivo já existia na tag e não mudou
    assert.match(verify(root), /0\.5\.0/);
    put(root, 'modules.json', modulesJson('0.5.0', { tv: '0.5.4' })); // maior que o da tag
    assert.match(verify(root), /0\.5\.0/);
  });
  withFixture('0.5.0', (root) => {
    git(root, 'rm', '-q', 'modules.json');
    commit(root, 'chore: sem modules.json');
    git(root, 'tag', 'v0.4.0'); // tag antiga, de antes das versões por módulo
    put(root, 'modules.json', modulesJson('0.5.0'));
    assert.match(verify(root), /0\.5\.0/);
  });
});

test('prepare sobe só os módulos cujos arquivos mudaram, pelo tipo dos commits', () =>
  withFixture('0.4.0', (root) => {
    git(root, 'tag', 'v0.4.0');
    commitFiles(root, 'feat(api): nova tecla', `${API}/Tv/UniOver.Modules.Tv/Keys.cs`, 'contracts/agent/messages/tv.key.v9.schema.json');
    commitFiles(root, 'fix(web): tela da tv', 'apps/web/src/app/modules/tv/tv.page.ts');
    commitFiles(root, 'fix(agent): reabrir a sessão', 'apps/agent/src/uniover_agent/session.py');
    commitFiles(root, 'chore: so o host', 'apps/api/src/UniOver.Host/Program.cs');
    commitFiles(root, 'feat(api)!: muda o treino', `${API}/Training/UniOver.Modules.Training/Plan.cs`);

    const message = prepare(root, 'patch', '2026-10-28');

    assert.deepEqual(JSON.parse(read(root, 'modules.json')), {
      identity: '0.4.0',
      devices: '0.4.0',
      tv: '0.5.0',
      training: '1.0.0',
      shopping: '0.4.0',
      web: '0.4.0',
      agent: '0.4.1',
    });
    assert.match(message, /tv 0\.5\.0, training 1\.0\.0, agent 0\.4\.1/);
    assert.equal(read(root, 'VERSION'), '0.4.1\n', 'o app segue o tipo pedido na linha de comando');
    assert.ok(read(root, 'modules.json').endsWith('}\n'));

    const top = read(root, 'CHANGELOG.md').split('## [0.4.0]')[0];
    assert.match(top, /### TV 0\.5\.0\n\n#### Features\n\n\* \*\*api:\*\* nova tecla\n\n#### Bug Fixes\n\n\* \*\*web:\*\* tela da tv\n/);
    assert.match(top, /### Training 1\.0\.0\n\n#### Features\n\n\* \*\*api:\*\* muda o treino\n/);
    assert.match(top, /### Agent 0\.4\.1\n\n#### Bug Fixes\n\n\* \*\*agent:\*\* reabrir a sessão\n/);
    assert.doesNotMatch(top, /### (Identity|Devices|Web) /);
    assert.equal((top.match(/^## /gm) ?? []).length, 1, 'nenhum ## dentro da entrada: o release corta nele');

    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'chore: release 0.4.1');
    assert.match(verify(root), /0\.4\.1/);
  }));

test('prepare: commit que toca dois módulos aparece nos dois; módulo só de manutenção ganha a linha', () =>
  withFixture('0.4.0', (root) => {
    git(root, 'tag', 'v0.4.0');
    commitFiles(root, 'feat: em dois', 'apps/agent/a.py', 'apps/web/src/app/core/a.ts');
    commitFiles(root, 'docs: so a pasta do identity', `${API}/Identity/UniOver.Modules.Identity/README.md`);
    commitFiles(root, 'feat: sem dono', 'scripts/algo.mjs');

    prepare(root, 'patch', '2026-10-28');

    const top = read(root, 'CHANGELOG.md').split('## [0.4.0]')[0];
    assert.match(top, /### Features\n\n\* sem dono\n\n\n### Identity 0\.4\.1\n\n#### Maintenance\n\n\* no user-facing changes/);
    assert.match(top, /### Web 0\.5\.0\n\n#### Features\n\n\* em dois\n/);
    assert.match(top, /### Agent 0\.5\.0\n\n#### Features\n\n\* em dois\n/);
    assert.ok(top.indexOf('### Identity') < top.indexOf('### Web') && top.indexOf('### Web') < top.indexOf('### Agent'));
  }));

test('prepare não mexe em módulo que nada tocou, e parte da versão da tag se o arquivo ficou para trás', () => {
  withFixture('0.4.0', (root) => {
    git(root, 'tag', 'v0.4.0');
    commit(root, 'feat: sem arquivos');
    prepare(root, 'patch', '2026-10-28');
    assert.equal(read(root, 'modules.json'), modulesJson('0.4.0'));
  });
  withFixture('0.4.0', (root) => {
    put(root, 'modules.json', modulesJson('0.4.0', { tv: '0.9.0' }));
    git(root, 'add', '-A');
    commit(root, 'chore: tv adiantado');
    git(root, 'tag', 'v0.4.3');
    put(root, 'modules.json', modulesJson('0.4.0')); // o arquivo voltou atrás da tag
    git(root, 'add', '-A');
    commit(root, 'chore: arquivo atrasado');
    commitFiles(root, 'fix(api): tv', `${API}/Tv/UniOver.Modules.Tv/X.cs`);
    prepare(root, 'patch', '2026-10-28');
    assert.equal(JSON.parse(read(root, 'modules.json')).tv, '0.9.1');
  });
});

test('prepare recusa modules.json inválido antes de mexer em qualquer arquivo', () =>
  withFixture('0.4.0', (root) => {
    git(root, 'tag', 'v0.4.0');
    commit(root, 'feat: algo');
    put(root, 'modules.json', '{}');
    assert.throws(() => prepare(root, 'patch', '2026-10-28'), /não tem o módulo 'identity'/);
    assert.equal(read(root, 'VERSION'), '0.4.0\n');
  }));

test('a entrada do changelog traz os módulos que subiram, em ### com tipos em ####', () => {
  const commits = [
    { sha: 'a'.repeat(40), subject: 'feat(web): show the version', modules: ['web'] },
    { sha: 'b'.repeat(40), subject: 'fix(api): keep the TV on', modules: ['tv', 'agent'] },
  ];
  const section = changelogSection('0.5.0', '0.4.3', commits, '2026-10-27', [
    { name: 'tv', version: '0.4.4' },
    { name: 'web', version: '0.5.0' },
    { name: 'agent', version: '0.4.4' },
  ]);
  assert.equal(
    section,
    '## [0.5.0](https://github.com/n33miaz/uniover/compare/v0.4.3...v0.5.0) (2026-10-27)\n\n\n' +
      '### TV 0.4.4\n\n#### Bug Fixes\n\n* **api:** keep the TV on\n\n\n' +
      '### Web 0.5.0\n\n#### Features\n\n* **web:** show the version\n\n\n' +
      '### Agent 0.4.4\n\n#### Bug Fixes\n\n* **api:** keep the TV on\n\n',
  );
});

test('settings: só os arquivos de conta são do identity; o resto da pasta é do web', () => {
  const settings = 'apps/web/src/app/modules/settings/';
  for (const file of [
    'profile.page.ts',
    'password-section.ts',
    'sessions-section.html',
    'security-section.ts',
    'security.page.ts',
    'totp-section.ts',
    'recovery-code-section.ts',
    'guests-section.ts',
    'people-api.ts',
    'people-permissions-sheet.css',
    'people.page.ts',
  ]) {
    assert.deepEqual(modulesForFile(settings + file), ['identity'], file);
  }
  for (const file of [
    'system.page.ts',
    'system-health-section.ts',
    'system-api.ts',
    'audit.page.ts',
    'siri.page.ts',
    'appearance.page.ts',
    'about.page.ts',
    'settings.page.ts',
    'agent-diagnostics.ts',
  ]) {
    assert.deepEqual(modulesForFile(settings + file), ['web'], file);
  }
});

test('o launcher da TV é do tv; o envelope é do devices; as mensagens do agente em si são do agent', () => {
  assert.deepEqual(modulesForFile('apps/tv-launcher/app/src/Main.kt'), ['tv']);
  assert.deepEqual(modulesForFile('contracts/tv-launcher/config.v1.schema.json'), ['tv']);
  assert.deepEqual(modulesForFile('contracts/agent/envelope.schema.json'), ['devices']);
  assert.deepEqual(modulesForFile('contracts/agent/messages/agent.update.status.v1.schema.json'), ['agent']);
  assert.deepEqual(modulesForFile('contracts/agent/messages/agent.diagnostics.v1.schema.json'), ['agent']);
  assert.deepEqual(modulesForFile('contracts/agent/messages/agent.hello.v1.schema.json'), ['devices']);
  assert.deepEqual(modulesForFile('contracts/agent/messages/agent.logs.v1.schema.json'), ['devices']);
});

test('prepare conta o commit de corpo com BREAKING CHANGE lido do git de verdade', () =>
  withFixture('0.4.0', (root) => {
    git(root, 'tag', 'v0.4.0');
    put(root, `${API}/Training/UniOver.Modules.Training/Plan.cs`, 'x\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'fix(api): troca o plano', '-m', 'BREAKING CHANGE: o plano muda de forma');
    prepare(root, 'patch', '2026-10-28');
    assert.equal(JSON.parse(read(root, 'modules.json')).training, '1.0.0');
  }));

test('prepare conta os dois lados de uma renomeação', () =>
  withFixture('0.4.0', (root) => {
    commitFiles(root, 'feat(api): arquivo da tv', `${API}/Tv/UniOver.Modules.Tv/Moved.cs`);
    git(root, 'tag', 'v0.4.0');
    mkdirSync(join(root, 'apps/api/src/UniOver.Host'), { recursive: true });
    git(root, 'mv', `${API}/Tv/UniOver.Modules.Tv/Moved.cs`, 'apps/api/src/UniOver.Host/Moved.cs');
    git(root, 'commit', '-q', '-m', 'refactor: move para o host');

    prepare(root, 'patch', '2026-10-28');

    // O host não é de módulo nenhum; o tv perdeu o arquivo e sobe.
    assert.deepEqual(JSON.parse(read(root, 'modules.json')), {
      ...JSON.parse(modulesJson('0.4.0')),
      tv: '0.4.1',
    });
  }));

test('prepare conta a resolução de conflito de um merge, e ignora um merge limpo', () => {
  withFixture('0.4.0', (root) => {
    const conflict = `${API}/Tv/UniOver.Modules.Tv/Conflict.cs`;
    commitFiles(root, 'chore: base do tv', conflict);
    git(root, 'tag', 'v0.4.0');
    git(root, 'checkout', '-q', '-b', 'lado');
    put(root, conflict, 'lado\n');
    git(root, 'commit', '-q', '-am', 'chore: lado');
    git(root, 'checkout', '-q', 'develop');
    put(root, conflict, 'develop\n');
    git(root, 'commit', '-q', '-am', 'chore: develop');
    assert.throws(() => git(root, 'merge', '--no-ff', 'lado'));
    put(root, conflict, 'resolvido\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'Merge branch lado');

    prepare(root, 'patch', '2026-10-28');

    const modules = JSON.parse(read(root, 'modules.json'));
    assert.equal(modules.tv, '0.4.1');
    assert.equal(modules.agent, '0.4.0');
  });
  withFixture('0.4.0', (root) => {
    git(root, 'tag', 'v0.4.0');
    git(root, 'checkout', '-q', '-b', 'lado');
    commit(root, 'chore: lado sem arquivos');
    git(root, 'checkout', '-q', 'develop');
    commit(root, 'chore: develop sem arquivos');
    git(root, 'merge', '--no-ff', '-q', '-m', 'Merge branch lado', 'lado');
    prepare(root, 'patch', '2026-10-28');
    assert.equal(read(root, 'modules.json'), modulesJson('0.4.0'));
  });
});

test('prepare aguenta um log grande (maxBuffer)', () =>
  withFixture('0.4.0', (root) => {
    git(root, 'tag', 'v0.4.0');
    for (let i = 0; i < 600; i += 1) put(root, `apps/agent/src/${'d'.repeat(120)}/arquivo-${i}.py`, 'x\n');
    git(root, 'add', '-A');
    const message = join(tmpdir(), `release-version-msg-${process.pid}.txt`);
    writeFileSync(message, `feat(agent): muitos arquivos

${'corpo '.repeat(200000)}
`, 'utf8');
    git(root, 'commit', '-q', '-F', message);
    rmSync(message, { force: true });
    prepare(root, 'patch', '2026-10-28');
    assert.equal(JSON.parse(read(root, 'modules.json')).agent, '0.5.0');
  }));
