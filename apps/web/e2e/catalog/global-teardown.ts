import { spawnSync } from 'node:child_process';

/**
 * Monta o HTML ao fim da execução, passe ou falhe algum teste: uma captura que não abriu vira linha no quadro de cobertura,
 * não motivo para perder as outras.
 */
export default function globalTeardown(): void {
  const result = spawnSync(process.execPath, ['e2e/catalog/build-catalog.mjs'], {
    stdio: 'inherit',
  });
  if (result.status !== 0) console.error('O catálogo não foi montado (veja acima).');
}
