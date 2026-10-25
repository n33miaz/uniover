<#
.SYNOPSIS
  Ensaio automatico de atualizacao do agente (rode antes de publicar algo que toque apps/agent).

.DESCRIPTION
  Monta uma instalacao isolada numa pasta temporaria com a versao BASE (padrao: origin/main), sobe
  o supervisor de verdade e atualiza para a CANDIDATA (a arvore local) duas vezes, mais o caminho
  de falha. Imprime APROVADO ou REPROVADO com o motivo; o codigo de saida e 0 so se aprovado.
  Nunca toca em %LOCALAPPDATA%\UniOver real, na tarefa agendada nem no Cofre de Credenciais.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File apps\agent\tools\upgrade-drill.ps1
#>
[CmdletBinding()]
param(
    # Commit da base. Padrao: origin/main (buscado antes).
    [string]$BaseSha,
    # Commit da candidata. Padrao: a arvore local, inclusive o que ainda nao foi commitado.
    [string]$CandidateRef,
    # Espera maxima por troca, em segundos.
    [int]$TimeoutSeconds = 420,
    # Usa um cache do uv novo (mais lento, simula um PC sem nada baixado).
    [switch]$ColdCache,
    # Nao apaga a pasta temporaria no fim (para investigar).
    [switch]$KeepFiles,
    # Planta um defeito conhecido na candidata: o ensaio tem de REPROVAR (prova que ele pega defeito).
    [ValidateSet('window', 'crash')]
    [string]$InjectDefect
)

$ErrorActionPreference = 'Stop'
$agent = Split-Path -Parent $PSScriptRoot
$uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uv) { throw 'uv nao encontrado no PATH.' }

$arguments = @('run', '--project', $agent, 'python', (Join-Path $PSScriptRoot 'upgrade_drill.py'), '--timeout', $TimeoutSeconds)
if ($BaseSha) { $arguments += @('--base-sha', $BaseSha) }
if ($CandidateRef) { $arguments += @('--candidate-ref', $CandidateRef) }
if ($ColdCache) { $arguments += '--cold-cache' }
if ($KeepFiles) { $arguments += '--keep-files' }
if ($InjectDefect) { $arguments += @('--inject-defect', $InjectDefect) }

& $uv.Source @arguments
exit $LASTEXITCODE
