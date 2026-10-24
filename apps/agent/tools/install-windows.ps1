[CmdletBinding()]
param(
    [ValidateSet('android', 'samsung')]
    [string]$TvKind = 'android',
    [string]$TvHost,
    [string]$ApiUrl = 'https://uniover.onrender.com',
    # Branch do repositório de onde vem o código do agente; rode de novo com o padrão para atualizar.
    [string]$Ref = 'main',
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$taskName = 'UniOver agente'

if ($Uninstall) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host 'A tarefa agendada do UniOver foi removida.'
    exit 0
}

if (-not $TvHost) {
    $TvHost = Read-Host 'Endereço IP da TV'
}
if (-not $TvHost) {
    throw 'Informe o endereço IP da TV com -TvHost.'
}

function Find-Uv {
    $command = Get-Command uv -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    Write-Host 'Instalando o uv pelo winget...'
    winget install --id astral-sh.uv -e --source winget --accept-package-agreements --accept-source-agreements
    $command = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $command) {
        # O winget cria o atalho fora do PATH desta sessão; procuramos nos dois lugares que ele usa.
        foreach ($candidate in @('Microsoft\WinGet\Links\uv.exe', 'Microsoft\WindowsApps\uv.exe')) {
            $path = Join-Path $env:LOCALAPPDATA $candidate
            if (Test-Path $path) {
                return $path
            }
        }
    }
    if (-not $command) {
        throw 'O uv foi instalado, mas o terminal ainda não o encontrou. Abra outro PowerShell e rode o instalador de novo.'
    }
    return $command.Source
}

function Write-Config([string]$Path, [string[]]$Lines) {
    # O TOML precisa ser UTF-8 sem BOM; assim funciona tanto no Windows PowerShell quanto no pwsh.
    $content = ($Lines -join [Environment]::NewLine) + [Environment]::NewLine
    $encoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Path, $content, $encoding)
}

$uv = Find-Uv
$base = Join-Path $env:LOCALAPPDATA 'UniOver'
$source = Join-Path $base 'agent-src'
$temporary = Join-Path $env:TEMP ('uniover-agent-' + [guid]::NewGuid())
$zip = Join-Path $temporary 'main.zip'

New-Item -ItemType Directory -Path $temporary -Force | Out-Null
try {
    Write-Host 'Baixando o agente...'
    Invoke-WebRequest -Uri "https://github.com/n33miaz/uniover/archive/refs/heads/$Ref.zip" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $temporary -Force
    $repository = Get-ChildItem -Path $temporary -Directory | Where-Object { $_.Name -like 'uniover-*' } | Select-Object -First 1
    if (-not $repository) {
        throw 'O pacote baixado não tem a estrutura esperada.'
    }
    $agent = Join-Path $repository.FullName 'apps\agent'
    if (-not (Test-Path $agent)) {
        throw 'O pacote baixado não contém apps\agent.'
    }
    if (Test-Path $source) {
        Remove-Item -LiteralPath $source -Recurse -Force
    }
    New-Item -ItemType Directory -Path $source -Force | Out-Null
    Copy-Item -Path (Join-Path $agent '*') -Destination $source -Recurse -Force
}
finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}

$config = Join-Path $base 'agent.toml'
New-Item -ItemType Directory -Path $base -Force | Out-Null
$env:UNIOVER_CONFIG_FILE = $config
Write-Config $config @("api_url = " + ($ApiUrl | ConvertTo-Json -Compress))

Write-Host 'Preparando o ambiente Python...'
& $uv --directory $source sync
if ($LASTEXITCODE -ne 0) {
    throw 'Não foi possível preparar o agente.'
}

Write-Host 'Aprovação do agente'
Write-Host 'O próximo comando mostrará um código. Abra o app UniOver e aprove-o.'
& $uv --directory $source run uniover-agent pair
if ($LASTEXITCODE -ne 0) {
    throw 'O pareamento do agente não foi concluído.'
}

# O pareamento preserva chaves locais; trocamos só os campos da TV para nunca guardar token aqui.
$withoutTv = Get-Content -LiteralPath $config | Where-Object { $_ -notmatch '^(tv_kind|tv_host)\s*=' }
$withoutTv += "tv_kind = " + ($TvKind | ConvertTo-Json -Compress)
$withoutTv += "tv_host = " + ($TvHost | ConvertTo-Json -Compress)
Write-Config $config $withoutTv

if ($TvKind -eq 'samsung') {
    Write-Host 'Aceite o aviso “Permitir” na TV Samsung quando ele aparecer.'
}
& $uv --directory $source run uniover-agent tv-pair --kind $TvKind --host $TvHost
if ($LASTEXITCODE -ne 0) {
    throw 'O pareamento da TV não foi concluído.'
}

$answer = Read-Host 'Registrar a tarefa “UniOver agente” para iniciar ao entrar no Windows? (s/N)'
if ($answer -match '^[sS]') {
    $command = "& '$uv' --directory '$source' run uniover-agent run"
    # O Windows PowerShell existe em todo Windows; o pwsh nem sempre está instalado.
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$command`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Host 'Tarefa registrada e iniciada.'
}
else {
    Write-Host 'A tarefa não foi registrada. Para iniciar agora: uv run uniover-agent run'
}
