#!/usr/bin/env bash
# Roda uma parte do teste da API, com cobertura. Uso: run-api-tests.sh <parte>
#
# <parte> é um nome de api-partitions.json (recorte do projeto de integração por namespace) ou "rest", o
# complemento: a solução inteira menos os namespaces das outras partes. O projeto de integração (um container de
# Postgres, todas as classes na mesma coleção do xUnit, portanto em fila) é quem pesa; repartir os namespaces entre
# jobs é o que o encurta. Os demais projetos de teste (segundos) e qualquer namespace novo ficam no "rest".
#
# O "rest" supõe a solução já compilada pelo passo anterior do job (dotnet build -warnaserror); as outras partes
# compilam só o que o projeto de integração puxa. Um tipo de filtro por comando: misturar --filter-namespace com
# --filter-class combina por E e roda zero testes (código de saída 8).
set -euo pipefail

part="${1:?informe a parte: um nome de api-partitions.json ou \"rest\"}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cfg="$here/api-partitions.json"

# Roda de dentro de apps/api: o global.json de lá liga o Microsoft.Testing.Platform no dotnet test.
cd "$here/../../apps/api"

# jq no Windows (para quem rodar este script no Git Bash) termina as linhas com CRLF; o tr o tira em qualquer sistema.
jqr() { jq -r "$@" | tr -d '\r'; }

# Pasta fixa: o upload da cobertura procura apps/api/TestResults/*.cobertura.xml, rode a parte em solução ou em projeto.
common=(--coverage --coverage-output-format cobertura --results-directory "$PWD/TestResults")

if [ "$part" = "rest" ]; then
  mapfile -t claimed < <(jqr '.parts[].namespaces[]' "$cfg")
  exec dotnet test --solution UniOver.slnx --no-build "${common[@]}" --filter-not-namespace "${claimed[@]}"
fi

mapfile -t patterns < <(jqr --arg n "$part" '.parts[] | select(.name == $n) | .namespaces[]' "$cfg")
if [ "${#patterns[@]}" -eq 0 ]; then
  echo "::error::a parte \"$part\" não existe em api-partitions.json."
  exit 1
fi
# O projeto de integração traz a extensão de hangdump: se um teste travar, em 15 min a execução termina listando os testes que
# ainda estavam em curso (em vez de ficar calada até o teto de 20 min do job). HANGDUMP_TIMEOUT vazio desliga; o prazo é do tempo total da parte (a mais lenta leva ~13 min no GitHub).
hang=()
if [ -n "${HANGDUMP_TIMEOUT-15m}" ]; then hang=(--hangdump --hangdump-timeout "${HANGDUMP_TIMEOUT-15m}" --hangdump-type Mini); fi
exec dotnet test --project "$(jqr .project "$cfg")" "${common[@]}" "${hang[@]}" --filter-namespace "${patterns[@]}"
