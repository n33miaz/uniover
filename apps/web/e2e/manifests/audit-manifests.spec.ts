import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '../fixtures';

type Audit = (options: { publicDir: string; snapshotFile: string }) => string[];

// O auditor é um módulo ES (.mjs) e os testes rodam como CommonJS: por isso o import dinâmico.
let auditManifests: Audit;
test.beforeAll(async () => {
  const script = join(__dirname, '..', '..', 'scripts', 'audit-manifests.mjs');
  auditManifests = ((await import(pathToFileURL(script).href)) as { auditManifests: Audit })
    .auditManifests;
});

// Teste do auditor em si (sem navegador): monta uma pasta public/ de mentira com PNGs só com cabeçalho,
// que é tudo o que o auditor lê, e quebra uma regra por vez.

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(size: number, colorType = 2): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = colorType;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(13, 0);
  return Buffer.concat([SIGNATURE, length, Buffer.from('IHDR'), header, Buffer.alloc(4)]);
}

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

function manifestFor(id: string, prefix = ''): Record<string, unknown> {
  const icon = (file: string, size: number, purpose: string): Icon => ({
    src: `${prefix}/icons/${file}`,
    sizes: `${size}x${size}`,
    type: 'image/png',
    purpose,
  });
  return {
    id,
    name: 'App',
    short_name: 'App',
    description: 'Descrição',
    start_url: id,
    scope: id,
    display: 'standalone',
    lang: 'pt-BR',
    dir: 'ltr',
    background_color: '#F2F5F1',
    theme_color: '#3B6B4B',
    icons: [
      icon('icon-192.png', 192, 'any'),
      icon('icon-512.png', 512, 'any'),
      icon('maskable-192.png', 192, 'maskable'),
      icon('maskable-512.png', 512, 'maskable'),
      icon('monochrome-512.png', 512, 'monochrome'),
    ],
  };
}

function writeFile(path: string, content: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeSet(root: string, folder: string, manifest: Record<string, unknown>): void {
  const base = join(root, folder);
  writeFile(join(base, 'manifest.webmanifest'), JSON.stringify(manifest));
  writeFile(join(base, 'apple-touch-icon.png'), png(180));
  for (const [file, size] of [
    ['icon-192.png', 192],
    ['icon-512.png', 512],
    ['maskable-192.png', 192],
    ['maskable-512.png', 512],
    ['monochrome-512.png', 512],
  ] as const) {
    writeFile(join(base, 'icons', file), png(size));
  }
}

interface Fixture {
  publicDir: string;
  snapshotFile: string;
}

function build(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'uniover-audit-'));
  const publicDir = join(root, 'public');
  writeSet(publicDir, '', manifestFor('/'));
  writeSet(publicDir, 'tv', manifestFor('/tv/', '/tv'));
  const snapshotFile = join(root, 'snapshot.json');
  writeFile(
    snapshotFile,
    JSON.stringify({
      '/manifest.webmanifest': { id: '/', scope: '/' },
      '/tv/manifest.webmanifest': { id: '/tv/', scope: '/tv/' },
    }),
  );
  return { publicDir, snapshotFile };
}

function editManifest(
  fixture: Fixture,
  folder: string,
  change: (manifest: Record<string, unknown>) => void,
): void {
  const path = join(fixture.publicDir, folder, 'manifest.webmanifest');
  const manifest = manifestFor(folder ? `/${folder}/` : '/', folder ? `/${folder}` : '');
  change(manifest);
  writeFile(path, JSON.stringify(manifest));
}

test.describe('auditoria dos manifests', () => {
  let fixture: Fixture;
  test.beforeEach(() => {
    fixture = build();
  });
  test.afterEach(() => {
    rmSync(dirname(fixture.publicDir), { recursive: true, force: true });
  });

  test('manifests corretos passam', () => {
    expect(auditManifests(fixture)).toEqual([]);
  });

  test('campo obrigatório ausente falha', () => {
    editManifest(fixture, 'tv', (m) => delete m['description']);
    expect(auditManifests(fixture)).toEqual([
      '/tv/manifest.webmanifest: campo obrigatório ausente: description',
    ]);
  });

  test('id sem barra inicial falha', () => {
    editManifest(fixture, 'tv', (m) => (m['id'] = 'tv/'));
    expect(auditManifests(fixture).join('\n')).toContain('id deve começar com "/"');
  });

  test('scope sem barra final falha', () => {
    editManifest(fixture, 'tv', (m) => (m['scope'] = '/tv'));
    expect(auditManifests(fixture).join('\n')).toContain('scope deve terminar com "/"');
  });

  test('start_url fora do scope falha', () => {
    editManifest(fixture, 'tv', (m) => (m['start_url'] = '/'));
    expect(auditManifests(fixture).join('\n')).toContain('start_url fora do scope');
  });

  test('ids repetidos falham', () => {
    editManifest(fixture, 'tv', (m) => {
      m['id'] = '/';
      m['scope'] = '/tv/';
    });
    const out = auditManifests(fixture).join('\n');
    expect(out).toContain('id "/" repetido');
  });

  test('ícone declarado que não existe falha', () => {
    rmSync(join(fixture.publicDir, 'tv', 'icons', 'maskable-512.png'));
    expect(auditManifests(fixture).join('\n')).toContain(
      'ícone não existe: /tv/icons/maskable-512.png',
    );
  });

  test('ícone com dimensão diferente da declarada falha', () => {
    writeFile(join(fixture.publicDir, 'icons', 'icon-192.png'), png(180));
    expect(auditManifests(fixture).join('\n')).toContain(
      'ícone /icons/icon-192.png tem 180x180, o manifest declara 192x192',
    );
  });

  test('falta de ícone monochrome falha', () => {
    editManifest(fixture, 'tv', (m) => {
      m['icons'] = (m['icons'] as Icon[]).filter((icon) => icon.purpose !== 'monochrome');
    });
    expect(auditManifests(fixture).join('\n')).toContain(
      'falta ícone 512x512 com purpose "monochrome"',
    );
  });

  test('apple-touch-icon com alfa ou tamanho errado falha', () => {
    writeFile(join(fixture.publicDir, 'apple-touch-icon.png'), png(180, 6));
    writeFile(join(fixture.publicDir, 'tv', 'apple-touch-icon.png'), png(192));
    const out = auditManifests(fixture).join('\n');
    expect(out).toContain('/manifest.webmanifest: apple-touch-icon.png tem canal alfa');
    expect(out).toContain(
      '/tv/manifest.webmanifest: apple-touch-icon.png tem 192x192, esperado 180x180',
    );
  });

  test('mudar id ou scope contra o snapshot falha com a mensagem de ADR', () => {
    editManifest(fixture, 'tv', (m) => {
      m['id'] = '/tv-novo/';
      m['scope'] = '/tv/';
      m['start_url'] = '/tv/';
    });
    const out = auditManifests(fixture);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('id/scope não podem mudar sem ADR');
  });

  test('manifest novo sem snapshot e manifest do snapshot que sumiu falham', () => {
    writeSet(fixture.publicDir, 'treino', manifestFor('/treino/', '/treino'));
    expect(auditManifests(fixture).join('\n')).toContain('manifest novo sem entrada');
    rmSync(join(fixture.publicDir, 'tv'), { recursive: true });
    expect(auditManifests(fixture).join('\n')).toContain('manifest do snapshot não existe mais');
  });
});
