// Auditoria dos manifests por módulo: campos, escopo, ícones (existência e dimensões), apple-touch-icon sem
// alfa e estabilidade de `id` e `scope` contra scripts/manifest-ids.snapshot.json. Uma linha por violação;
// código de saída diferente de zero se houver alguma. É chamada por `npm run audit:pwa`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));

const REQUIRED_FIELDS = [
  'id',
  'name',
  'short_name',
  'description',
  'start_url',
  'scope',
  'display',
  'lang',
  'dir',
  'background_color',
  'theme_color',
  'icons',
];

// Combinações de ícone que todo manifest precisa declarar (tamanho e finalidade).
const REQUIRED_ICONS = [
  { size: 192, purpose: 'any' },
  { size: 512, purpose: 'any' },
  { size: 512, purpose: 'maskable' },
  { size: 512, purpose: 'monochrome' },
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Lê largura, altura e tipo de cor do cabeçalho (IHDR) de um PNG. Devolve null se não for PNG. */
export function readPngHeader(buffer) {
  if (buffer.length < 26 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer[25],
  };
}

function hasAlpha(buffer, header) {
  // 4 (cinza + alfa) e 6 (RGB + alfa) têm canal alfa.
  if (header.colorType === 4 || header.colorType === 6) return true;
  // Indexado ou cinza com transparência declarada no bloco tRNS.
  return header.colorType !== 2 && buffer.includes(Buffer.from('tRNS'));
}

function listManifests(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listManifests(path));
    else if (entry.name === 'manifest.webmanifest') found.push(path);
  }
  return found.sort();
}

function isPresent(value) {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Confere todos os manifests em `publicDir`. Devolve a lista de violações (vazia = tudo certo).
 * @param {{ publicDir: string, snapshotFile: string }} options
 * @returns {string[]}
 */
export function auditManifests({ publicDir, snapshotFile }) {
  const violations = [];
  const manifests = listManifests(publicDir);
  const keyOf = (file) => '/' + relative(publicDir, file).split(sep).join('/');
  const seenIds = new Map();
  const snapshot = existsSync(snapshotFile) ? JSON.parse(readFileSync(snapshotFile, 'utf8')) : null;

  if (manifests.length === 0) violations.push(`nenhum manifest.webmanifest em ${publicDir}`);
  if (!snapshot) violations.push(`snapshot de id/scope ausente: ${snapshotFile}`);

  for (const file of manifests) {
    const key = keyOf(file);
    const fail = (message) => violations.push(`${key}: ${message}`);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      fail('JSON inválido');
      continue;
    }

    for (const field of REQUIRED_FIELDS) {
      if (!isPresent(manifest[field])) fail(`campo obrigatório ausente: ${field}`);
    }
    if (typeof manifest.id === 'string' && !manifest.id.startsWith('/')) {
      fail('id deve começar com "/"');
    }
    if (typeof manifest.scope === 'string' && !manifest.scope.endsWith('/')) {
      fail('scope deve terminar com "/"');
    }
    // O start_url precisa estar dentro do escopo; o iOS abre exatamente o start_url.
    if (typeof manifest.start_url === 'string' && typeof manifest.scope === 'string') {
      if (!manifest.start_url.startsWith(manifest.scope)) fail('start_url fora do scope');
    }
    if (isPresent(manifest.display) && manifest.display !== 'standalone') {
      fail('display deve ser "standalone"');
    }

    if (typeof manifest.id === 'string') {
      const other = seenIds.get(manifest.id);
      if (other) fail(`id "${manifest.id}" repetido (também em ${other})`);
      else seenIds.set(manifest.id, key);
    }

    // Ícones: existem e têm as dimensões do `sizes`.
    const declared = Array.isArray(manifest.icons) ? manifest.icons : [];
    for (const icon of declared) {
      if (typeof icon.src !== 'string' || !icon.src.startsWith('/')) {
        fail(`ícone com src inválido (use caminho absoluto): ${icon.src}`);
        continue;
      }
      const target = resolve(publicDir, '.' + icon.src);
      if (!existsSync(target)) {
        fail(`ícone não existe: ${icon.src}`);
        continue;
      }
      const header = readPngHeader(readFileSync(target));
      if (!header) {
        fail(`ícone não é PNG: ${icon.src}`);
        continue;
      }
      const expected = String(icon.sizes ?? '');
      if (expected !== `${header.width}x${header.height}`) {
        fail(
          `ícone ${icon.src} tem ${header.width}x${header.height}, o manifest declara ${expected}`,
        );
      }
    }
    for (const { size, purpose } of REQUIRED_ICONS) {
      const present = declared.some(
        (icon) =>
          icon.sizes === `${size}x${size}` &&
          (icon.purpose ?? 'any').split(/\s+/).includes(purpose),
      );
      if (!present) fail(`falta ícone ${size}x${size} com purpose "${purpose}"`);
    }

    // apple-touch-icon na mesma pasta do manifest: 180x180 e sem canal alfa (o iOS pinta a transparência de preto).
    const touch = join(dirname(file), 'apple-touch-icon.png');
    if (!existsSync(touch)) {
      fail('falta apple-touch-icon.png ao lado do manifest');
    } else {
      const buffer = readFileSync(touch);
      const header = readPngHeader(buffer);
      if (!header) {
        fail('apple-touch-icon.png não é PNG');
      } else {
        if (header.width !== 180 || header.height !== 180) {
          fail(`apple-touch-icon.png tem ${header.width}x${header.height}, esperado 180x180`);
        }
        if (hasAlpha(buffer, header)) fail('apple-touch-icon.png tem canal alfa');
      }
    }

    // Estabilidade: id e scope entram na identidade do app instalado e não podem mudar sem uma decisão.
    if (snapshot) {
      const saved = snapshot[key];
      if (!saved) {
        fail(
          'manifest novo sem entrada em scripts/manifest-ids.snapshot.json (registre id e scope)',
        );
      } else if (saved.id !== manifest.id || saved.scope !== manifest.scope) {
        fail(
          `id/scope não podem mudar sem ADR (snapshot: id "${saved.id}", scope "${saved.scope}"; ` +
            `manifest: id "${manifest.id}", scope "${manifest.scope}")`,
        );
      }
    }
  }

  if (snapshot) {
    const present = new Set(manifests.map(keyOf));
    for (const key of Object.keys(snapshot)) {
      if (!present.has(key)) {
        violations.push(
          `${key}: manifest do snapshot não existe mais (id/scope não podem mudar sem ADR)`,
        );
      }
    }
  }
  return violations;
}

// Execução direta: node scripts/audit-manifests.mjs
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = auditManifests({
    publicDir: join(webRoot, 'public'),
    snapshotFile: join(webRoot, 'scripts', 'manifest-ids.snapshot.json'),
  });
  if (violations.length > 0) {
    for (const line of violations) console.error(`[manifests] ${line}`);
    process.exit(1);
  }
  console.log('[manifests] ok: manifests, ícones e estabilidade de id/scope conferidos');
}
