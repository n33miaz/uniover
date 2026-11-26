#!/usr/bin/env bash
# Passos do Deploy que dependem do estado do Release (rascunho ou público).
#
# Uso (da raiz do repositório, onde está o VERSION):
#   release-publish.sh inspect <pasta>   informa `draft=true|false`; se o Release já é público, baixa para <pasta> o
#                                        manifesto assinado (quando existe), para ele ser conferido sem substituir nada.
#   release-publish.sh publish           publica o rascunho depois de conferir os anexos; Release público fica como está.
#
# Entrada (variáveis de ambiente):
#   GH_TOKEN, GH_REPO  acesso do gh ao Release (um rascunho só aparece para token com escrita em contents)
#   SIGNED             no publish, `true` ou `false`: se a assinatura anexou o manifesto nesta publicação
#
# Saída do inspect: imprime `draft=...` e, se GITHUB_OUTPUT existir, grava a mesma linha nele.
set -euo pipefail

MANIFEST='uniover-agent-manifest.json'
VERSION_TAG='^v[0-9]+\.[0-9]+\.[0-9]+$'

fail() {
  echo "::error::$1"
  exit 1
}

# Lê o Release da tag e define `draft` (true|false) e `uploaded` (nomes dos anexos completos, um por linha).
read_release() {
  local release
  release=$(gh release view "$tag" --json isDraft,assets) || fail "não foi possível consultar o Release $tag."
  draft=$(jq -r '.isDraft' <<< "$release" | tr -d '\r')
  case "$draft" in
    true | false) ;;
    *) fail "o Release $tag não informou se é rascunho." ;;
  esac
  # Um envio interrompido deixa o anexo listado em outro estado: ele não conta.
  uploaded=$(jq -r '.assets[] | select(.state == "uploaded") | .name' <<< "$release" | tr -d '\r')
}

has_asset() {
  grep -Fxq -- "$1" <<< "$uploaded"
}

inspect() {
  local directory="$1"
  read_release
  if [ "$draft" = false ] && has_asset "$MANIFEST"; then
    gh release download "$tag" --pattern "$MANIFEST" --dir "$directory" \
      || fail "não foi possível baixar o manifesto do Release público $tag."
  fi
  echo "draft=$draft"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "draft=$draft" >> "$GITHUB_OUTPUT"
  fi
}

publish() {
  local signed="${SIGNED:-}" name published highest
  case "$signed" in
    true | false) ;;
    *) fail "SIGNED deve ser true ou false, veio '$signed'." ;;
  esac
  read_release
  if [ "$draft" = false ]; then
    echo "O Release $tag já é público: nada é alterado."
    return 0
  fi
  local required=(uniover-launcher.apk uniover-launcher.apk.sha256)
  if [ "$signed" = true ]; then
    required+=("$MANIFEST")
  fi
  for name in "${required[@]}"; do
    has_asset "$name" || fail "o rascunho $tag não tem o anexo $name completo: ele não é publicado."
  done
  # A retomada de uma execução antiga não pode passar à frente de uma versão publicada depois: o "latest" voltaria
  # atrás e o manifesto dela, assinado agora, seria o mais novo.
  published=$(gh release list --exclude-drafts --exclude-pre-releases --limit 100 --json tagName --jq '.[].tagName') \
    || fail "não foi possível listar os Releases publicados."
  highest=$({ printf '%s\n' "$published" | tr -d '\r' | grep -E "$VERSION_TAG" || true; echo "$tag"; } | sort -V | tail -n1)
  if [ "$highest" != "$tag" ]; then
    fail "já existe a versão $highest publicada, maior que $tag: o rascunho não é publicado."
  fi
  gh release edit "$tag" --draft=false
  echo "Release $tag publicado."
}

version=$(tr -d '\r\n' < VERSION)
tag="v$version"
[[ "$tag" =~ $VERSION_TAG ]] || fail "o VERSION '$version' não é do formato X.Y.Z."

case "${1:-}" in
  inspect)
    [ -n "${2:-}" ] || fail "informe a pasta de destino do manifesto."
    inspect "$2"
    ;;
  publish) publish ;;
  *) fail "comando desconhecido '${1:-}': use inspect ou publish." ;;
esac
