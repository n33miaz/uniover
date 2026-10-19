#!/usr/bin/env bash
# Aplica cada bundle com a conexão DIRETA do papel dono, em ordem alfabética de módulo.
# É o que a esteira chama. UNIOVER_MIGRATIONS_CONNECTION nunca fica no Render.
set -euo pipefail

: "${UNIOVER_MIGRATIONS_CONNECTION:?Defina UNIOVER_MIGRATIONS_CONNECTION (conexão direta, papel dono).}"

api_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$api_root"

applied=0
for bundle_dir in $(ls -d artifacts/bundles/*/ 2>/dev/null | sort); do
  bundle="${bundle_dir}efbundle"
  [ -x "$bundle" ] || { echo "bundle ausente ou sem permissão de execução: $bundle" >&2; exit 1; }
  echo "==> migrando $(basename "$bundle_dir")"
  "$bundle" --connection "$UNIOVER_MIGRATIONS_CONNECTION"
  applied=$((applied + 1))
done

echo "módulos migrados: ${applied}"
