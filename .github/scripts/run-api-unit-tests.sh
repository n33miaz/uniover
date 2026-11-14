#!/usr/bin/env bash
# Roda os testes da API que não precisam de Docker: todos os projetos de teste menos o de integração (que sobe um
# Postgres e roda na rodada noturna, ver nightly.yml). Uso: run-api-unit-tests.sh [--no-build]
#
# A solução já deve estar compilada (o passo anterior do job faz `dotnet build UniOver.slnx -warnaserror`); sem
# --no-build cada projeto compila o que precisa. Roda de dentro de apps/api: o global.json de lá liga o
# Microsoft.Testing.Platform no `dotnet test`. Um projeto novo em tests/ entra sozinho; só o de integração é excluído.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/../../apps/api"

extra=("$@")
count=0
for project in tests/*/*.csproj; do
  case "$project" in *UniOver.IntegrationTests*) continue ;; esac
  echo "::group::$project"
  dotnet test --project "$project" "${extra[@]}"
  echo "::endgroup::"
  count=$((count + 1))
done

if [ "$count" -eq 0 ]; then
  echo "::error::nenhum projeto de teste encontrado em apps/api/tests."
  exit 1
fi
