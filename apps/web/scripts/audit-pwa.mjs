// Auditoria de PWA: Lighthouse (acessibilidade, boas práticas, desempenho) e, quando existir, o script que
// confere os manifests por módulo. Roda sobre o dist gerado por `npm run build`.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));

// Chama o node direto (sem shell) para funcionar igual no Windows e no Linux.
function run(command, args) {
  const result = spawnSync(command, args, { cwd: webRoot, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, ['node_modules/@lhci/cli/src/cli.js', 'autorun']);

if (existsSync(new URL('./audit-manifests.mjs', import.meta.url))) {
  run(process.execPath, ['scripts/audit-manifests.mjs']);
} else {
  console.log(
    '[audit] scripts/audit-manifests.mjs ainda não existe: conferência dos manifests adiada.',
  );
}
