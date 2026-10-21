#!/usr/bin/env bash
# Monta as matrizes de jobs do ci.yml a partir dos arquivos desta pasta e as imprime no formato do
# $GITHUB_OUTPUT (uma linha chave=valor por matriz). Uso: plan-matrices.sh >> "$GITHUB_OUTPUT"
#
#   api-partitions.json  partes do teste da API; a parte "rest" é implícita (ver run-api-tests.sh)
#   e2e-shards.json      projetos do Playwright e em quantas partes cada um se divide
#
# As duas matrizes saem daqui (e não escritas à mão no ci.yml) para que o job, a conferência de cobertura e a
# execução usem a mesma lista: não existe uma parte que roda sem estar conferida, nem o contrário.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# "rest" é o nome da parte implícita; repetir um nome faria duas partes rodarem o mesmo recorte.
if ! jq -e '[.parts[].name] | (index("rest") | not) and (length == (unique | length))' \
  "$here/api-partitions.json" >/dev/null; then
  echo "::error::api-partitions.json: nomes de parte repetidos ou usando o nome reservado \"rest\"."
  exit 1
fi

# O tr tira o CR que o jq do Windows acrescenta (só importa para quem rodar o script no Git Bash).
api=$(jq -c '{include: ([.parts[] | {name}] + [{name: "rest"}])}' "$here/api-partitions.json" | tr -d '\r')

# Um item por (projeto, parte): o Playwright reparte os testes de cada projeto com --shard k/total.
e2e=$(jq -c '{include: [.[] | . as $p | range(1; $p.shards + 1) as $k
  | {project: $p.project, browser: $p.browser, shard: $k, total: $p.shards}]}' "$here/e2e-shards.json" | tr -d '\r')

echo "api_matrix=$api"
echo "e2e_matrix=$e2e"
