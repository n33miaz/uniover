#!/usr/bin/env bash
# Valida os commits de um PR: formato do assunto, tamanho, ausência de corpo/trailer e e-mail do autor.
# O committer não é checado: o "rebase and merge" do GitHub o reescreve ao entrar na develop.
# Uso: check-commits.sh <base> <head>   (a variável ALLOWED_EMAIL define o e-mail aceito)
set -u

base="${1:?informe o commit base}"
head="${2:?informe o commit head}"
allowed="${ALLOWED_EMAIL:-ncormino@gmail.com}"
pattern='^(feat|fix|chore|refactor|docs|test|perf|build|ci|style|revert)(\([a-z0-9-]+\))?!?: [a-z0-9]'

errors=0
fail() {
  echo "::error::commit ${1:0:7}: $2"
  errors=$((errors + 1))
}

commits=$(git rev-list --reverse "${base}..${head}")
if [ -z "$commits" ]; then
  echo "Nenhum commit para validar."
  exit 0
fi

for sha in $commits; do
  subject=$(git show -s --format=%s "$sha")
  body=$(git show -s --format=%b "$sha")
  author_email=$(git show -s --format=%ae "$sha")

  if ! [[ "$subject" =~ $pattern ]]; then
    fail "$sha" "o assunto \"$subject\" não segue o padrão tipo(escopo): descrição, em minúsculas."
  fi
  if [ "${#subject}" -gt 50 ]; then
    fail "$sha" "o assunto tem ${#subject} caracteres; o máximo é 50."
  fi
  if [[ "$subject" == *. ]]; then
    fail "$sha" "o assunto não pode terminar em ponto."
  fi
  if [ -n "${body//[[:space:]]/}" ]; then
    fail "$sha" "a mensagem deve ter uma linha só: sem corpo e sem trailer."
  fi
  if [ "$author_email" != "$allowed" ]; then
    fail "$sha" "o e-mail do autor ($author_email) não é o do dono do repositório."
  fi
done

if [ "$errors" -gt 0 ]; then
  echo "Checagem de commits falhou com $errors problema(s)."
  exit 1
fi
echo "Todos os commits estão no padrão."
