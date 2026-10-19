#!/usr/bin/env bash
# Gera UM migration bundle por módulo que tenha Persistence/ com ModuleDesignTimeFactory.
# Uso (a partir de apps/api): scripts/build-bundles.sh
# Sai com erro se qualquer módulo falhar. Os bundles vão para artifacts/bundles/<modulo>.
set -euo pipefail

api_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$api_root"

# O dotnet ef só instancia a fábrica de design; esta conexão nunca é usada para gerar o bundle.
export UNIOVER_MIGRATIONS_CONNECTION="${UNIOVER_MIGRATIONS_CONNECTION:-Host=localhost;Database=unused;Username=unused;Password=unused}"

built=0
for module_dir in src/Modules/*/; do
  module="$(basename "$module_dir")"
  project="${module_dir}UniOver.Modules.${module}/UniOver.Modules.${module}.csproj"
  persistence="${module_dir}UniOver.Modules.${module}/Persistence"

  [ -f "$project" ] || continue
  [ -d "$persistence" ] || continue
  grep -rqs "ModuleDesignTimeFactory" "$persistence" || continue

  echo "==> bundle de ${module}"
  dotnet ef migrations bundle \
    --project "$project" --startup-project "$project" \
    --self-contained -r linux-x64 \
    -o "artifacts/bundles/$(echo "$module" | tr '[:upper:]' '[:lower:]')/efbundle" \
    --force
  built=$((built + 1))
done

echo "bundles gerados: ${built}"
