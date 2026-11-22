#!/usr/bin/env bash
# Decide se uma execução do Deploy pode seguir para a publicação.
#
# Entrada (variáveis de ambiente):
#   EVENT_NAME    nome do evento do GitHub (push, workflow_dispatch...)
#   HEAD_MESSAGE  mensagem completa do commit de head do push (só a primeira linha, o assunto, conta)
#   PRODUCTION_QUEUE  `true` ou `false`: se o push entrou no grupo de concorrência da produção (a triagem do
#                     deploy.yml). Obrigatória no push; ignorada nos outros eventos.
#
# Saída: imprime `publish=true` ou `publish=false` e, se GITHUB_OUTPUT existir, grava a mesma linha nele.
#
# Regras:
#   - workflow_dispatch segue sempre: a execução manual e o ensaio do alerta não dependem do commit.
#   - push segue só se o assunto do commit de head é exatamente `chore: release x.y.z` (SemVer sem sufixo).
#   - qualquer outro evento não publica; evento vazio falha.
#   - no push, a triagem da fila precisa concordar com a regra exata. Release fora da fila falha (publicaria sem esperar
#     a vez); push sem release dentro da fila também falha, porque pode ter cancelado um release pendente, e a falha
#     faz o notify avisar em vez de esse release sumir em silêncio.
# A checagem é só pelo assunto; a validação de VERSION, tags e metadados continua no job version do Deploy.
set -euo pipefail

RELEASE_SUBJECT='^chore: release [0-9]+\.[0-9]+\.[0-9]+$'

event="${EVENT_NAME:-}"
message="${HEAD_MESSAGE:-}"
subject="${message%%$'\n'*}"
subject="${subject%$'\r'}"

# Sem evento é erro de ligação no workflow, não "nada a publicar": falhar faz o notify avisar, em vez de um release
# ficar sem publicar em silêncio.
if [ -z "$event" ]; then
  echo "::error::EVENT_NAME vazio: o gate não sabe de que evento veio a execução."
  exit 1
fi

queue="${PRODUCTION_QUEUE:-}"

publish=false
case "$event" in
  workflow_dispatch)
    publish=true
    ;;
  push)
    if printf '%s\n' "$subject" | grep -Eq "$RELEASE_SUBJECT"; then
      publish=true
    fi
    case "$publish:$queue" in
      true:true | false:false) ;;
      true:false)
        echo "::error::o commit de head é um release, mas o push ficou fora da fila da produção (a mensagem tem '-' ou '+'). Nada é publicado: publique pela execução manual do Deploy."
        exit 1
        ;;
      false:true)
        echo "::error::o push entrou na fila da produção sem ser um release (chore: release x.y.z). Um release que esperava a vez pode ter sido cancelado: confira as execuções do Deploy."
        exit 1
        ;;
      *)
        echo "::error::PRODUCTION_QUEUE deve ser true ou false no push, veio '${queue}'."
        exit 1
        ;;
    esac
    ;;
esac

if [ "$publish" = "true" ]; then
  echo "::notice::o commit de head é um release (ou a execução é manual): a publicação segue."
else
  echo "::notice::o commit de head não é um release (chore: release x.y.z): nada é publicado nesta execução."
fi

echo "publish=$publish"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "publish=$publish" >> "$GITHUB_OUTPUT"
fi
