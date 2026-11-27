#!/usr/bin/env bash
# Casos do release-publish.sh: quando o rascunho é publicado, quando fica como está e o que é baixado para conferência.
# Usa um gh de mentira: nenhum Release real é consultado nem alterado.
# Uso: bash .github/scripts/release-publish.test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/release-publish.sh"
failures=0
total=0

# O gh de mentira é uma função exportada: tem precedência sobre o gh do PATH no bash que roda o script. Ele registra
# cada chamada em FAKE_LOG e responde pelo que o caso definir.
gh() {
  echo "$*" >> "$FAKE_LOG"
  case "$1 $2" in
    'release view')
      [ -n "$FAKE_RELEASE" ] || { echo 'release not found' >&2; return 1; }
      printf '%s\n' "$FAKE_RELEASE"
      ;;
    'release list')
      [ "$FAKE_LIST" != fail ] || return 1
      printf '%s\n' "$FAKE_LIST"
      ;;
    'release download') return "$FAKE_DOWNLOAD_STATUS" ;;
    'release edit') return 0 ;;
    *) echo "chamada inesperada: $*" >&2; return 1 ;;
  esac
}
export -f gh

work="$(mktemp -d)"
# Só os arquivos que este teste cria; a pasta sai vazia, sem exclusão recursiva.
trap 'rm -f "$work/VERSION" "$work/log" "$work/output" "$work/stdout"; rmdir "$work"' EXIT
printf '1.10.0\n' > "$work/VERSION"

# release <draft> [anexo[:estado]...]: o JSON que o gh release view devolveria
release() {
  local draft="$1" assets="" item name state
  shift
  for item in "$@"; do
    name="${item%%:*}"
    state=uploaded
    [ "$item" = "$name" ] || state="${item#*:}"
    assets="$assets${assets:+,}{\"name\":\"$name\",\"state\":\"$state\"}"
  done
  printf '{"isDraft":%s,"assets":[%s]}' "$draft" "$assets"
}

apk=uniover-launcher.apk
sum=uniover-launcher.apk.sha256
manifest=uniover-agent-manifest.json

# run <comando e argumentos>: roda o script com o cenário atual e guarda o código de saída em `status`
run() {
  : > "$work/log"
  : > "$work/output"
  status=0
  (cd "$work" && FAKE_LOG="$work/log" FAKE_RELEASE="$FAKE_RELEASE" FAKE_LIST="$FAKE_LIST" \
    FAKE_DOWNLOAD_STATUS="$FAKE_DOWNLOAD_STATUS" SIGNED="$SIGNED" GITHUB_OUTPUT="$work/output" \
    bash "$script" "$@") > "$work/stdout" 2>&1 || status=$?
}

reset() {
  FAKE_RELEASE=""
  FAKE_LIST=$'v1.9.3\nv1.9.2'
  FAKE_DOWNLOAD_STATUS=0
  SIGNED=false
}

# expect <descrição> <condição...>
expect() {
  local label="$1"
  shift
  total=$((total + 1))
  if "$@"; then
    echo "ok   - $label"
  else
    echo "FAIL - $label (saída $status)"
    sed 's/^/       /' "$work/stdout"
    failures=$((failures + 1))
  fi
}

published() { [ "$status" -eq 0 ] && grep -Fxq 'release edit v1.10.0 --draft=false' "$work/log"; }
untouched() { [ "$status" -eq 0 ] && ! grep -Eq '^release (edit|upload|delete)' "$work/log"; }
refused() { [ "$status" -ne 0 ] && ! grep -Eq '^release (edit|upload|delete)' "$work/log" && grep -q '::error::' "$work/stdout"; }
downloaded() { grep -Fxq "release download v1.10.0 --pattern $manifest --dir manifest-dir" "$work/log"; }
not_downloaded() { ! grep -q '^release download' "$work/log"; }
reports() { [ "$status" -eq 0 ] && grep -Fxq "draft=$1" "$work/output"; }

# publish: rascunho
reset; FAKE_RELEASE=$(release true $apk $sum); run publish
expect 'sem assinatura, rascunho com o launcher é publicado' published
reset; SIGNED=true; FAKE_RELEASE=$(release true $apk $sum $manifest); run publish
expect 'com assinatura, rascunho com launcher e manifesto é publicado' published
reset; SIGNED=true; FAKE_RELEASE=$(release true $apk $sum); run publish
expect 'com assinatura, rascunho sem manifesto fica em rascunho' refused
reset; SIGNED=true; FAKE_RELEASE=$(release true $apk $sum "$manifest:open"); run publish
expect 'manifesto com envio incompleto não conta' refused
reset; FAKE_RELEASE=$(release true $apk); run publish
expect 'rascunho sem o checksum do launcher fica em rascunho' refused
reset; FAKE_RELEASE=$(release true $sum); run publish
expect 'o checksum não vale como o APK' refused

# publish: ordem das versões
reset; FAKE_LIST=""; FAKE_RELEASE=$(release true $apk $sum); run publish
expect 'primeiro Release do repositório é publicado' published
reset; FAKE_LIST=$'v1.9.0\nweb-assets-teste'; FAKE_RELEASE=$(release true $apk $sum); run publish
expect 'a comparação é por versão (1.10 é maior que 1.9) e ignora outras tags' published
reset; FAKE_LIST=$'v1.10.1\nv1.9.3'; FAKE_RELEASE=$(release true $apk $sum); run publish
expect 'versão antiga não é publicada depois de uma maior' refused
reset; FAKE_LIST=fail; FAKE_RELEASE=$(release true $apk $sum); run publish
expect 'sem a lista de publicados, fica em rascunho' refused

# publish: público e erros
reset; SIGNED=true; FAKE_RELEASE=$(release false $apk); run publish
expect 'Release já público não é alterado' untouched
reset; run publish
expect 'Release inexistente falha' refused
reset; FAKE_RELEASE='{"assets":[]}'; run publish
expect 'resposta sem isDraft falha' refused
reset; SIGNED=""; FAKE_RELEASE=$(release true $apk $sum); run publish
expect 'SIGNED vazio falha (a assinatura não informou o resultado)' refused

# inspect
reset; FAKE_RELEASE=$(release true $manifest); run inspect manifest-dir
expect 'rascunho: informa draft=true' reports true
expect 'rascunho: não baixa o manifesto parcial de uma tentativa anterior' not_downloaded
reset; FAKE_RELEASE=$(release false $apk $manifest); run inspect manifest-dir
expect 'público: informa draft=false' reports false
expect 'público: baixa o manifesto para conferir' downloaded
expect 'público: não altera o Release' untouched
reset; FAKE_RELEASE=$(release false $apk); run inspect manifest-dir
expect 'público sem manifesto: informa draft=false' reports false
expect 'público sem manifesto: nada a baixar' not_downloaded
reset; FAKE_DOWNLOAD_STATUS=1; FAKE_RELEASE=$(release false $manifest); run inspect manifest-dir
expect 'público: falha no download do manifesto falha o passo' refused
reset; run inspect manifest-dir
expect 'inspect de Release inexistente falha' refused

# uso
reset; FAKE_RELEASE=$(release true $apk $sum); run
expect 'sem comando falha' refused
reset; run inspect
expect 'inspect sem pasta falha' refused
reset; printf '1.10.0-rc.1\n' > "$work/VERSION"; FAKE_RELEASE=$(release true $apk $sum); run publish
expect 'VERSION fora de X.Y.Z falha' refused

echo
echo "$((total - failures))/$total casos passaram."
[ "$failures" -eq 0 ]
