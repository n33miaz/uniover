#!/usr/bin/env bash
# Conferência das partes do teste da API: somadas, elas são exatamente a suíte inteira (nenhum teste de fora,
# nenhum repetido). Roda no job da parte "rest", depois do build, e só lista testes: não executa nenhum.
#
# Como a conta fecha: as partes nomeadas em api-partitions.json pegam namespaces do projeto de integração e a parte
# "rest" é o complemento (--filter-not-namespace dos mesmos padrões, sobre a solução inteira). Projeto ou namespace
# novo, portanto, cai no "rest" sem ninguém lembrar de nada. Esta conferência prova que o complemento se comporta
# como complemento, e falha se um padrão deixou de casar com algum teste (parte vazia, por exemplo depois de um
# renomear de namespace).
#
# Cuidado herdado do xUnit: filtros de tipos diferentes combinam por E (--filter-namespace com --filter-class roda
# zero testes, código de saída 8). Cada comando aqui usa um tipo só.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cfg="$here/api-partitions.json"

# Roda de dentro de apps/api: o global.json de lá liga o Microsoft.Testing.Platform no dotnet test.
cd "$here/../../apps/api"

# Imprime, ordenados e um por linha, os testes que o comando selecionaria. Os nomes de teste são as únicas linhas
# indentadas que começam pelo namespace dos projetos; o resto da saída (resumos) é traduzido e não serve de chave.
# Na CI o executor de testes pode colorir a saída (ANSI): --no-ansi pede sem, e o sed tira qualquer código que sobrar.
discover() {
  local out
  if ! out=$(dotnet test "$@" --no-build --list-tests --no-ansi </dev/null 2>&1); then
    echo "$out" >&2
    echo "::error::não foi possível listar os testes (dotnet test $*)."
    return 1
  fi
  local names
  names=$(sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g' <<<"$out" | tr -d '\r' | grep -E '^  UniOver\.' | sort || true)
  if [ -z "$names" ]; then
    echo "$out" >&2
    echo "::error::nenhum teste listado por: dotnet test $*."
    return 1
  fi
  printf '%s\n' "$names"
}

count() { grep -c . <<<"$1" || true; }

# jq no Windows (para quem rodar este script no Git Bash) termina as linhas com CRLF; o tr o tira em qualquer sistema.
jqr() { jq -r "$@" | tr -d '\r'; }

project=$(jqr '.project' "$cfg")
mapfile -t claimed < <(jqr '.parts[].namespaces[]' "$cfg")

all=$(discover --solution UniOver.slnx)
echo "Suíte inteira: $(count "$all") testes."

sum=""
while IFS= read -r name; do
  mapfile -t patterns < <(jqr --arg n "$name" '.parts[] | select(.name == $n) | .namespaces[]' "$cfg")
  part=$(discover --project "$project" --filter-namespace "${patterns[@]}")
  echo "Parte $name (${patterns[*]}): $(count "$part") testes."
  sum+="$part"$'\n'
done < <(jqr '.parts[].name' "$cfg")

rest=$(discover --solution UniOver.slnx --filter-not-namespace "${claimed[@]}")
echo "Parte rest (tudo que não casa com as outras): $(count "$rest") testes."
sum+="$rest"$'\n'

# Comparação como multiconjuntos: o que sobra de um lado é teste de fora, o que sobra do outro é teste repetido.
if ! diff_out=$(diff <(printf '%s\n' "$all") <(grep . <<<"$sum" | sort)); then
  echo "$diff_out" | head -40
  echo "::error::as partes do teste da API não somam a suíte inteira (linhas com < faltam nas partes; com > aparecem em mais de uma)."
  exit 1
fi
echo "Conferido: as partes somam a suíte inteira, sem repetição."
