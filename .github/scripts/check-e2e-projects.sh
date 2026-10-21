#!/usr/bin/env bash
# Conferência do E2E: e2e-shards.json lista exatamente os projetos do playwright.config.ts.
# O job e2e roda um projeto por parte (--project X --shard k/n); um projeto novo no config, sem entrada no
# arquivo, nunca rodaria na CI e ninguém notaria. Aqui isso vira falha.
#
# Roda de dentro de apps/web, com as dependências instaladas (npm ci). O --list só carrega o config e os arquivos de
# teste: não sobe o webServer nem precisa dos navegadores.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cfg="$here/e2e-shards.json"

# jq no Windows (para quem rodar este script no Git Bash) termina as linhas com CRLF; o tr o tira em qualquer sistema.
declared=$(npx --no-install playwright test --list --reporter=json | jq -r '.config.projects[].name' | tr -d '\r' | sort)
planned=$(jq -r '.[].project' "$cfg" | tr -d '\r' | sort)

if [ "$declared" != "$planned" ]; then
  echo "Projetos em playwright.config.ts:"
  echo "$declared" | sed 's/^/  /'
  echo "Projetos em .github/scripts/e2e-shards.json:"
  echo "$planned" | sed 's/^/  /'
  echo "::error::os projetos do Playwright e o e2e-shards.json divergem: o que não está no arquivo não roda na CI."
  exit 1
fi

if ! jq -e 'all(.[]; (.shards | type == "number" and . >= 1 and . == floor) and (.browser | IN("chromium", "webkit", "firefox")))' \
  "$cfg" >/dev/null; then
  echo "::error::e2e-shards.json: cada projeto precisa de \"shards\" inteiro >= 1 e \"browser\" chromium, webkit ou firefox."
  exit 1
fi

echo "Conferido: os $(grep -c . <<<"$planned") projetos do Playwright estão no e2e-shards.json."
