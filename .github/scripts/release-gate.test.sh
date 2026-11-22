#!/usr/bin/env bash
# Casos do gate do Deploy (release-gate.sh): o que publica e o que não publica.
# Uso: bash .github/scripts/release-gate.test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gate="$here/release-gate.sh"
failures=0
total=0

# Espelho do startsWith do deploy.yml: confere o prefixo `chore: release ` sem distinguir maiúsculas de minúsculas.
queue_of() {
  local message="${1,,}"
  case "$message" in
    'chore: release '*) echo true ;;
    *) echo false ;;
  esac
}

# check <esperado true|false> <evento> <mensagem> <descrição>
check() {
  local expected="$1" event="$2" message="$3" label="$4" output actual
  total=$((total + 1))
  output="$(env -u GITHUB_OUTPUT EVENT_NAME="$event" HEAD_MESSAGE="$message" PRODUCTION_QUEUE="$(queue_of "$message")" bash "$gate")"
  actual="$(printf '%s\n' "$output" | sed -n 's/^publish=//p' | tail -n1)"
  if [ "$actual" = "$expected" ]; then
    echo "ok   - $label"
  else
    echo "FAIL - $label: esperado publish=$expected, veio publish=${actual:-<vazio>}"
    failures=$((failures + 1))
  fi
}

# Publicam
check true push 'chore: release 0.78.4' 'release patch'
check true push 'chore: release 1.0.0' 'release major'
check true push 'chore: release 10.20.300' 'release com vários dígitos'
check true push $'chore: release 0.79.0\n\nCorpo qualquer.' 'release com corpo'
check true push $'chore: release 0.79.0\n\nreviewed-by: someone' 'release com hífen no corpo'
check true push $'chore: release 0.79.0\r\n\r\nCorpo com CRLF e versão 0.79.0+build.7.' 'release com CRLF e sinal de mais no corpo'
check true workflow_dispatch '' 'execução manual sem mensagem'
check true workflow_dispatch 'fix(web): qualquer coisa' 'execução manual com commit comum'

# Não publicam
check false push 'fix(web): stabilize browser scenarios' 'commit comum'
check false push 'chore: release 0.78.4-rc.1' 'versão com sufixo de pré-release'
check false push 'chore: release 0.78.4+build.7' 'versão com metadados de build'
check false push 'Chore: Release 0.78.4' 'assunto com maiúsculas'
check false push 'chore: release 0.78' 'versão incompleta'
check false push 'chore: release v0.78.4' 'versão com prefixo v'
check false push 'chore: release 0.78.4 ' 'espaço no fim do assunto'
check false push 'chore: release 0.78.4 extra' 'texto depois da versão'
check false push ' chore: release 0.78.4' 'espaço no começo do assunto'
check false push 'chore(web): release 0.78.4' 'tipo com escopo'
check false push 'chore: releases 0.78.4' 'palavra diferente'
check false push 'chore:  release 0.78.4' 'dois espaços'
check false push 'Merge pull request #1 from n33miaz/develop' 'merge commit padrão'
check false push $'fix(api): something\n\nchore: release 0.78.4' 'release só no corpo'
check false push '' 'push sem mensagem'
check false pull_request 'chore: release 0.78.4' 'outro evento'

# fails <mensagem> <fila> <descrição>: no push, o gate termina com erro (o notify avisa) em vez de responder publish
fails() {
  local message="$1" queue="$2" label="$3"
  total=$((total + 1))
  if env -u GITHUB_OUTPUT EVENT_NAME=push HEAD_MESSAGE="$message" PRODUCTION_QUEUE="$queue" bash "$gate" > /dev/null 2>&1; then
    echo "FAIL - $label: o gate terminou com sucesso"
    failures=$((failures + 1))
  else
    echo "ok   - $label"
  fi
}

fails 'chore: release 0.78.4' false 'release fora da fila da produção'
fails 'chore: release 0.78.4' '' 'push sem PRODUCTION_QUEUE'
fails 'chore: release 0.78.4' 'sim' 'PRODUCTION_QUEUE inválida'

# Evento vazio é erro de ligação no workflow: o gate falha em vez de responder publish=false
total=$((total + 1))
if env -u GITHUB_OUTPUT EVENT_NAME='' HEAD_MESSAGE='chore: release 0.78.4' bash "$gate" > /dev/null 2>&1; then
  echo "FAIL - evento vazio falha: o gate terminou com sucesso"
  failures=$((failures + 1))
else
  echo "ok   - evento vazio falha"
fi

# Grava em GITHUB_OUTPUT quando existe
total=$((total + 1))
out_file="$(mktemp)"
GITHUB_OUTPUT="$out_file" EVENT_NAME=push HEAD_MESSAGE='chore: release 1.2.3' PRODUCTION_QUEUE=true bash "$gate" > /dev/null
if [ "$(cat "$out_file")" = "publish=true" ]; then
  echo "ok   - grava publish no GITHUB_OUTPUT"
else
  echo "FAIL - grava publish no GITHUB_OUTPUT: veio '$(cat "$out_file")'"
  failures=$((failures + 1))
fi
rm -f "$out_file"

echo "$((total - failures))/$total casos passaram."
[ "$failures" -eq 0 ]
