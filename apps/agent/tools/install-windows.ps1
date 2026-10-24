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

# Dois modos:
#  - Automático (sem -TvHost): acha a TV na rede, pareia o agente (QR), pareia a TV e deixa o agente
#    iniciando sozinho com o Windows, sem perguntar nada. É o que o conectar-uniover.cmd roda.
#  - Manual (com -TvHost): o comportamento de sempre, com a pergunta antes de criar a tarefa.

$ErrorActionPreference = 'Stop'
# A barra de progresso do Windows PowerShell 5.1 deixa o download dezenas de vezes mais lento.
$ProgressPreference = 'SilentlyContinue'
try {
    # O 5.1 pode vir só com TLS antigo, que o GitHub recusa.
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}
catch { }
try {
    # Para o terminal mostrar acentos e o QR (blocos) do agente sem estragar.
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
}
catch { }
$env:PYTHONUTF8 = '1'

$taskName = 'UniOver agente'
$base = Join-Path $env:LOCALAPPDATA 'UniOver'
$source = Join-Path $base 'agent-src'
$config = Join-Path $base 'agent.toml'
$wrapper = Join-Path $base 'run-agent.ps1'
$installerUrl = 'https://raw.githubusercontent.com/n33miaz/uniover/main/apps/agent/tools/install-windows.ps1'
$automatic = -not $PSBoundParameters.ContainsKey('TvHost')

function Stop-Agent {
    # Parar a tarefa e os processos que ela deixou: pasta em uso não pode ser trocada.
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $mine = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and ($_.ProcessId -ne $PID) -and (
            $_.CommandLine -like "*$base\run-agent.ps1*" -or
            $_.CommandLine -like "*$base\venv*" -or
            $_.CommandLine -like "*$base\agent-src*"
        )
    }
    foreach ($process in $mine) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 1
}

if ($Uninstall) {
    Stop-Agent
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $wrapper -Force -ErrorAction SilentlyContinue
    Write-Host 'A tarefa agendada do UniOver foi removida e o agente parou.'
    Write-Host "Configuração e pareamento ficaram em $base; apague a pasta se quiser tirar tudo."
    exit 0
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

function Set-ConfigValues([string]$Path, [hashtable]$Values) {
    # Troca só as chaves dadas e preserva o resto (agent_id, listas do dono...). Nunca guarda token aqui.
    $keys = ($Values.Keys | ForEach-Object { [regex]::Escape($_) }) -join '|'
    $lines = @()
    if (Test-Path -LiteralPath $Path) {
        $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8 | Where-Object { $_ -notmatch "^($keys)\s*=" })
    }
    foreach ($key in $Values.Keys) {
        $lines += "$key = " + ($Values[$key] | ConvertTo-Json -Compress)
    }
    Write-Config $Path $lines
}

function Get-AgentSource([string]$Destination) {
    # Baixa o commit exato (e grava .version para a auto-atualização saber de onde partiu).
    $temporary = Join-Path $env:TEMP ('uniover-agent-' + [guid]::NewGuid())
    $zip = Join-Path $temporary 'main.zip'
    New-Item -ItemType Directory -Path $temporary -Force | Out-Null
    try {
        try {
            $reply = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/n33miaz/uniover/commits/$Ref" -Headers @{ 'User-Agent' = 'uniover-installer' }
        }
        catch {
            throw 'Não consegui consultar a versão do agente no GitHub. Confira a internet e tente de novo.'
        }
        if ($reply.sha -notmatch '^[0-9a-f]{40}$') {
            throw 'O GitHub não informou um commit válido para o agente.'
        }
        $sha = $reply.sha
        $address = "https://github.com/n33miaz/uniover/archive/$sha.zip"
        Write-Host 'Baixando o agente...'
        Invoke-WebRequest -UseBasicParsing -Uri $address -OutFile $zip
        Expand-Archive -Path $zip -DestinationPath $temporary -Force
        $repository = Get-ChildItem -Path $temporary -Directory | Where-Object { $_.Name -like 'uniover-*' } | Select-Object -First 1
        if (-not $repository) {
            throw 'O pacote baixado não tem a estrutura esperada.'
        }
        $agent = Join-Path $repository.FullName 'apps\agent'
        if (-not (Test-Path $agent)) {
            throw 'O pacote baixado não contém apps\agent.'
        }
        if (Test-Path $Destination) {
            Remove-Item -LiteralPath $Destination -Recurse -Force
        }
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
        Copy-Item -Path (Join-Path $agent '*') -Destination $Destination -Recurse -Force
        if ($sha) {
            [System.IO.File]::WriteAllText((Join-Path $Destination '.version'), $sha + "`n", [System.Text.UTF8Encoding]::new($false))
        }
    }
    finally {
        Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Register-AgentTask([string]$Arguments) {
    # O padrão do Agendador mata a tarefa depois de 72 h e não a inicia na bateria: o agente
    # precisa ficar de pé o tempo todo. O Windows PowerShell existe em todo Windows.
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $Arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

# Só ASCII, de propósito: o Windows PowerShell 5.1 lê arquivo sem BOM como ANSI. O agente roda
# daqui: atualiza uma vez por início e, se cair, volta com espera crescente (até 5 min).
$wrapperTemplate = @'
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$base = Join-Path $env:LOCALAPPDATA 'UniOver'
$source = Join-Path $base 'agent-src'
$env:UNIOVER_CONFIG_FILE = Join-Path $base 'agent.toml'
$env:UNIOVER_LOG_FILE = Join-Path $base 'agent.log'
$env:UV_PROJECT_ENVIRONMENT = Join-Path $base 'venv'
$env:PYTHONUTF8 = '1'
$uv = '__UV__'
if (-not (Test-Path -LiteralPath $uv)) {
    $found = Get-Command uv -ErrorAction SilentlyContinue
    if ($found) { $uv = $found.Source }
}
Set-Location -LiteralPath $base
& $uv run --project $source uniover-agent self-update --no-sync *> $null
& $uv sync --project $source --quiet *> $null
$wait = 5
while ($true) {
    $started = Get-Date
    & $uv run --project $source uniover-agent run
    if (((Get-Date) - $started).TotalSeconds -gt 600) { $wait = 5 }
    Start-Sleep -Seconds $wait
    $wait = [Math]::Min($wait * 2, 300)
}
'@

$uv = Find-Uv
New-Item -ItemType Directory -Path $base -Force | Out-Null
$env:UNIOVER_CONFIG_FILE = $config
Stop-Agent

if ($automatic) {
    # O ambiente Python fica FORA da pasta do agente e o uv roda com --project: assim a
    # auto-atualização consegue trocar a pasta do agente por renomeação (pasta em uso não troca).
    $env:UV_PROJECT_ENVIRONMENT = Join-Path $base 'venv'

    Get-AgentSource $source
    Set-ConfigValues $config @{ api_url = $ApiUrl }

    Write-Host 'Preparando o ambiente Python (na primeira vez demora um pouco)...'
    & $uv sync --project $source
    if ($LASTEXITCODE -ne 0) {
        throw 'Não foi possível preparar o agente.'
    }

    # 1. Acha a TV na rede. O agente grava tipo, endereço e identificador no agent.toml.
    $findArguments = @('run', '--project', $source, 'uniover-agent', 'tv-find')
    if ($PSBoundParameters.ContainsKey('TvKind')) {
        $findArguments += @('--kind', $TvKind)
    }
    & $uv @findArguments
    $tvFound = ($LASTEXITCODE -eq 0)
    if (-not $tvFound) {
        Write-Host ''
        Write-Host 'Não achei a TV sozinho. Confira se ela está ligada e no mesmo Wi-Fi deste computador.'
        $typed = Read-Host 'Se souber o endereço IP da TV, digite aqui (ou aperte Enter para seguir sem a TV)'
        if ($typed) {
            $isSamsung = Read-Host 'A TV é Samsung? (s/N)'
            $kind = 'android'
            if ($isSamsung -match '^[sS]') {
                $kind = 'samsung'
            }
            Set-ConfigValues $config @{ tv_kind = $kind; tv_host = $typed.Trim() }
            $tvFound = $true
        }
    }

    # 2. Pareia este PC com a conta (código + QR). Já pareado: não pede de novo.
    & $uv run --project $source uniover-agent pair --if-needed
    if ($LASTEXITCODE -ne 0) {
        throw 'O pareamento do agente não foi concluído.'
    }

    # 3. Pareia a TV (na Samsung, aceite o aviso Permitir na tela da TV).
    $tvPaired = $false
    if ($tvFound) {
        & $uv run --project $source uniover-agent tv-pair --if-needed
        $tvPaired = ($LASTEXITCODE -eq 0)
        if (-not $tvPaired) {
            Write-Host 'O pareamento da TV não foi concluído. Rode este arquivo de novo com a TV ligada.'
        }
    }

    # 4. O agente passa a iniciar com o Windows, sem janela, sem perguntar.
    $wrapperText = $wrapperTemplate.Replace('__UV__', $uv.Replace("'", "''"))
    [System.IO.File]::WriteAllText($wrapper, $wrapperText, [System.Text.Encoding]::ASCII)
    Register-AgentTask "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`""
    Start-ScheduledTask -TaskName $taskName

    Write-Host ''
    Write-Host 'Pronto. O que foi feito:'
    Write-Host "  - O agente foi instalado em $source e se atualiza sozinho."
    if ($tvPaired) {
        Write-Host '  - A TV foi encontrada e pareada.'
    }
    else {
        Write-Host '  - A TV ainda não está pareada (rode este arquivo de novo com a TV ligada).'
    }
    Write-Host "  - Foi criada a tarefa agendada '$taskName': o agente inicia sozinho quando você entra no Windows, sem janela."
    Write-Host "  - O que o agente faz fica registrado em $(Join-Path $base 'agent.log')."
    Write-Host 'Para remover, rode o comando abaixo (a configuração e o pareamento ficam):'
    Write-Host ('  powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm ' + $installerUrl + '))) -Uninstall"')
    exit 0
}

# --- Modo manual (-TvHost informado) ---------------------------------------------------------
Get-AgentSource $source
Write-Config $config @("api_url = " + ($ApiUrl | ConvertTo-Json -Compress))

Write-Host 'Preparando o ambiente Python...'
& $uv --directory $source sync
if ($LASTEXITCODE -ne 0) {
    throw 'Não foi possível preparar o agente.'
}

Write-Host 'Aprovação do agente'
Write-Host 'O próximo comando mostrará um código e um QR. Abra o app UniOver e aprove.'
& $uv --directory $source run uniover-agent pair
if ($LASTEXITCODE -ne 0) {
    throw 'O pareamento do agente não foi concluído.'
}

# O pareamento preserva chaves locais; trocamos só os campos da TV para nunca guardar token aqui.
Set-ConfigValues $config @{ tv_kind = $TvKind; tv_host = $TvHost }

if ($TvKind -eq 'samsung') {
    Write-Host 'Aceite o aviso Permitir na TV Samsung quando ele aparecer.'
}
& $uv --directory $source run uniover-agent tv-pair --kind $TvKind --host $TvHost
if ($LASTEXITCODE -ne 0) {
    throw 'O pareamento da TV não foi concluído.'
}

$answer = Read-Host "Registrar a tarefa '$taskName' para iniciar ao entrar no Windows? (s/N)"
if ($answer -match '^[sS]') {
    $command = "& '$uv' --directory '$source' run uniover-agent run"
    Register-AgentTask "-NoProfile -WindowStyle Hidden -Command `"$command`""
    Start-ScheduledTask -TaskName $taskName
    Write-Host 'Tarefa registrada e iniciada.'
}
else {
    Write-Host 'A tarefa não foi registrada. Para iniciar agora: uv run uniover-agent run'
}
