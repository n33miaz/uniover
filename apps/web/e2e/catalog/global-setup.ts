import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { CATALOG_DIR, FRAMES_DIR, ROUTES_JSON } from './catalog-paths';
import { inventoryRoutes } from './route-inventory';

/**
 * Cada execução parte do zero: o catálogo é sempre o retrato do código de agora, nunca uma mistura de rodadas. Grava o
 * inventário de rotas lido dos arquivos de rotas do app, de onde o montador do HTML tira a cobertura.
 */
export default function globalSetup(): void {
  // CATALOG_KEEP=1 mantém as capturas da rodada anterior (para depurar um arquivo só; o HTML sai com as duas rodadas).
  if (!process.env['CATALOG_KEEP']) rmSync(CATALOG_DIR, { recursive: true, force: true });
  mkdirSync(FRAMES_DIR, { recursive: true });
  writeFileSync(ROUTES_JSON, JSON.stringify(inventoryRoutes(), null, 2));
}
