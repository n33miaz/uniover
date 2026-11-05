import { join } from 'node:path';

/** Onde as capturas e os metadados ficam entre a captura e a montagem do HTML (sem importar nada: serve a todos). */
export const CATALOG_DIR = process.env['CATALOG_DIR'] ?? 'test-results-catalog';
export const FRAMES_DIR = join(CATALOG_DIR, 'frames');
export const FRAMES_LOG = join(CATALOG_DIR, 'frames.jsonl');
export const FAILURES_LOG = join(CATALOG_DIR, 'failures.jsonl');
export const GAPS_LOG = join(CATALOG_DIR, 'gaps.jsonl');
export const ROUTES_JSON = join(CATALOG_DIR, 'routes.json');
