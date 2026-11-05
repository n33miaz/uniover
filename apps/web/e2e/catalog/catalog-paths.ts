import { isAbsolute, join, normalize, sep } from 'node:path';

/**
 * Onde as capturas e os metadados ficam entre a captura e a montagem do HTML (sem importar nada: serve a todos). O setup
 * apaga esta pasta a cada rodada, então ela só pode ser uma pasta relativa dentro de `apps/web` com `test-results` no nome.
 */
function catalogDir(): string {
  const dir = normalize(process.env['CATALOG_DIR'] ?? 'test-results-catalog');
  if (isAbsolute(dir) || dir.split(sep).includes('..') || !dir.startsWith('test-results')) {
    throw new Error(
      `CATALOG_DIR inválido (${dir}): use uma pasta relativa que comece com test-results`,
    );
  }
  return dir;
}

export const CATALOG_DIR = catalogDir();
export const FRAMES_DIR = join(CATALOG_DIR, 'frames');
export const FRAMES_LOG = join(CATALOG_DIR, 'frames.jsonl');
export const FAILURES_LOG = join(CATALOG_DIR, 'failures.jsonl');
export const GAPS_LOG = join(CATALOG_DIR, 'gaps.jsonl');
export const ROUTES_JSON = join(CATALOG_DIR, 'routes.json');
