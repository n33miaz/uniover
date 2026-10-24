[CmdletBinding()]
param(
    [ValidateSet('android', 'samsung')]
    [string]$TvKind = 'android',
    [string]$TvHost,
    [string]$ApiUrl = 'https://uniover.onrender.com',
    # Branch do repositorio de onde vem o codigo do agente; rode de novo com o padrao para atualizar.
    [string]$Ref = 'main',
    [switch]$Uninstall
)

# Dois modos:
#  - Automatico (sem -TvHost): acha a TV na rede, pareia o agente (QR), pareia a TV e deixa o agente
#    iniciando sozinho com o Windows, sem perguntar nada. E o que o conectar-uniover.cmd roda.
#  - Manual (com -TvHost): o comportamento de sempre, com a pergunta antes de criar a tarefa.

$ErrorActionPreference = 'Stop'
# A barra de progresso do Windows PowerShell 5.1 deixa o download dezenas de vezes mais lento.
$ProgressPreference = 'SilentlyContinue'
try {
    # O 5.1 pode vir so com TLS antigo, que o GitHub recusa.
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
$source = Join-Path $base 'app'
$config = Join-Path $base 'config\agent.toml'
$launcher = Join-Path $base 'launcher.ps1'
$fallback = Join-Path $base 'run-agent.fallback.ps1'
$installerUrl = 'https://raw.githubusercontent.com/n33miaz/uniover/main/apps/agent/tools/install-windows.ps1'
$automatic = -not $PSBoundParameters.ContainsKey('TvHost')

function Stop-Agent {
    # Parar a tarefa e os processos que ela deixou: pasta em uso nao pode ser trocada.
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $mine = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and ($_.ProcessId -ne $PID) -and (
            $_.CommandLine -like "*$base\launcher.ps1*" -or
            $_.CommandLine -like "*$base\run-agent.ps1*" -or
            $_.CommandLine -like "*$base\runtime*" -or
            $_.CommandLine -like "*$base\app*" -or
            # Layout antigo: sem isto o agente de antes continua vivo ao lado do novo.
            $_.CommandLine -like "*$base\agent-src*" -or
            $_.CommandLine -like "*$base\venv*"
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
    Remove-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $fallback -Force -ErrorAction SilentlyContinue
    Write-Host 'A tarefa agendada do UniOver foi removida e o agente parou.'
    Write-Host "Configuracao e pareamento ficaram em $base; apague a pasta se quiser tirar tudo."
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
        # O winget cria o atalho fora do PATH desta sessao; procuramos nos dois lugares que ele usa.
        foreach ($candidate in @('Microsoft\WinGet\Links\uv.exe', 'Microsoft\WindowsApps\uv.exe', '.local\bin\uv.exe')) {
            $path = Join-Path $env:LOCALAPPDATA $candidate
            if (Test-Path $path) {
                return $path
            }
        }
    }
    if (-not $command) {
        throw 'O uv foi instalado, mas o terminal ainda nao o encontrou. Abra outro PowerShell e rode o instalador de novo.'
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
    # Troca so as chaves dadas e preserva o resto (agent_id, listas do dono...). Nunca guarda token aqui.
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
    # Baixa o commit exato (e grava .version para a auto-atualizacao saber de onde partiu).
    $temporary = Join-Path $env:TEMP ('uniover-agent-' + [guid]::NewGuid())
    $zip = Join-Path $temporary 'main.zip'
    New-Item -ItemType Directory -Path $temporary -Force | Out-Null
    try {
        try {
            $reply = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/n33miaz/uniover/commits/$Ref" -Headers @{ 'User-Agent' = 'uniover-installer' }
        }
        catch {
            throw 'Nao consegui consultar a versao do agente no GitHub. Confira a internet e tente de novo.'
        }
        if ($reply.sha -notmatch '^[0-9a-f]{40}$') {
            throw 'O GitHub nao informou um commit valido para o agente.'
        }
        $sha = $reply.sha
        $address = "https://github.com/n33miaz/uniover/archive/$sha.zip"
        Write-Host 'Baixando o agente...'
        Invoke-WebRequest -UseBasicParsing -Uri $address -OutFile $zip
        # So apps/agent sai do zip: o repositorio inteiro tem caminhos (da API) que passam do limite de 260
        # caracteres do Windows e derrubam a extracao completa.
        if (Test-Path $Destination) {
            Remove-Item -LiteralPath $Destination -Recurse -Force
        }
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $root = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
        $bundle = [System.IO.Compression.ZipFile]::OpenRead($zip)
        $extracted = 0
        try {
            foreach ($entry in $bundle.Entries) {
                # <repo>-<sha>/apps/agent/<resto>, mais o icone publico do app para a bandeja.
                $parts = $entry.FullName -split '/', 4
                $isAgent = $parts.Count -ge 4 -and $parts[1] -eq 'apps' -and $parts[2] -eq 'agent' -and $parts[3]
                $isIcon = $entry.FullName -match '/apps/web/public/icons/icon-192\.png$'
                if (-not $isAgent -and -not $isIcon) {
                    continue
                }
                $relative = if ($isAgent) { $parts[3] -replace '/', '\' } else { 'assets\uniover.png' }
                $target = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
                if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
                    throw 'O pacote baixado tem um caminho invalido.'
                }
                if ($entry.FullName.EndsWith('/')) {
                    New-Item -ItemType Directory -Path $target -Force | Out-Null
                    continue
                }
                New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
                [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
                $extracted++
            }
        }
        finally {
            $bundle.Dispose()
        }
        if ($extracted -eq 0 -or -not (Test-Path -LiteralPath (Join-Path $Destination 'pyproject.toml'))) {
            throw 'O pacote baixado nao contem apps\agent.'
        }
        $png = Join-Path $Destination 'assets\uniover.png'
        $ico = Join-Path $Destination 'assets\uniover.ico'
        if (Test-Path -LiteralPath $png) {
            try {
                Add-Type -AssemblyName System.Drawing
                $bitmap = [System.Drawing.Bitmap]::new($png)
                $icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
                $stream = [System.IO.File]::Create($ico)
                try { $icon.Save($stream) } finally { $stream.Dispose(); $icon.Dispose(); $bitmap.Dispose() }
            }
            catch { }
            Remove-Item -LiteralPath $png -Force -ErrorAction SilentlyContinue
        }
        if ($sha) {
            [System.IO.File]::WriteAllText((Join-Path $Destination '.version'), $sha + "`n", [System.Text.UTF8Encoding]::new($false))
        }
    }
    finally {
        Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Register-AgentTask([string]$Arguments) {
    # O padrao do Agendador mata a tarefa depois de 72 h e nao a inicia na bateria: o agente
    # precisa ficar de pe o tempo todo. O Windows PowerShell existe em todo Windows.
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $Arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

function Move-LegacyLayout {
    # A primeira execucao nova organiza uma instalacao antiga sem tocar no Cofre de Credenciais.
    $moves = @(
        @((Join-Path $base 'agent-src'), $source),
        @((Join-Path $base 'agent-src.previous'), (Join-Path $base 'app.previous')),
        @((Join-Path $base 'venv'), (Join-Path $base 'runtime\venv')),
        @((Join-Path $base 'agent.toml'), $config),
        @((Join-Path $base 'agent.log'), (Join-Path $base 'logs\agent.log')),
        @((Join-Path $base 'conectar.html'), (Join-Path $base 'web\conectar.html')),
        @((Join-Path $base '.blocked-versions'), (Join-Path $base 'runtime\.blocked-versions')),
        @((Join-Path $base 'update-trial.txt'), (Join-Path $base 'runtime\update-trial.txt'))
    )
    foreach ($move in $moves) {
        if ((Test-Path -LiteralPath $move[0]) -and -not (Test-Path -LiteralPath $move[1])) {
            New-Item -ItemType Directory -Path (Split-Path $move[1] -Parent) -Force | Out-Null
            Move-Item -LiteralPath $move[0] -Destination $move[1] -ErrorAction SilentlyContinue
        }
    }
    foreach ($folder in @('runtime', 'config', 'logs', 'web')) {
        New-Item -ItemType Directory -Path (Join-Path $base $folder) -Force | Out-Null
    }
}

function Write-Readme {
    $readme = @'
UniOver

Esta pasta guarda o agente que conecta este computador ao UniOver e a TV.
Ele inicia sozinho, fica perto do relogio e se atualiza automaticamente.

Se algo nao funcionar, rode de novo o arquivo conectar-uniover.cmd.
Para remover, execute o instalador com -Uninstall e, se quiser, apague esta pasta.
'@
    [System.IO.File]::WriteAllText((Join-Path $base 'LEIA-ME.txt'), $readme, [System.Text.UTF8Encoding]::new($false))
}

function Write-StartMenuShortcut {
    try {
        $start = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
        $shortcut = Join-Path $start 'UniOver.lnk'
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut($shortcut)
        $link.TargetPath = ($ApiUrl.TrimEnd('/') + '/')
        $link.Description = 'Abrir o UniOver'
        $link.Save()
    }
    catch { }
}

# So ASCII, de proposito: o Windows PowerShell 5.1 le arquivo sem BOM como ANSI. O agente roda
# daqui, confere atualizacao a cada 6 h e, se cair, volta com espera crescente (ate 5 min).
$wrapperTemplate = @'
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$base = Join-Path $env:LOCALAPPDATA 'UniOver'
$source = Join-Path $base 'agent-src'
$previous = Join-Path $base 'agent-src.previous'
$blocked = Join-Path $base '.blocked-versions'
$trial = Join-Path $base 'update-trial.txt'
$env:UNIOVER_CONFIG_FILE = Join-Path $base 'agent.toml'
$env:UNIOVER_LOG_FILE = Join-Path $base 'agent.log'
$env:UV_PROJECT_ENVIRONMENT = Join-Path $base 'venv'
$env:PYTHONUTF8 = '1'

function Find-Uv {
    $configured = '__UV__'
    if (Test-Path -LiteralPath $configured) { return $configured }
    $found = Get-Command uv -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    foreach ($relative in @('Microsoft\WinGet\Links\uv.exe', 'Microsoft\WindowsApps\uv.exe', '.local\bin\uv.exe')) {
        $candidate = Join-Path $env:LOCALAPPDATA $relative
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Get-Version {
    try { return [System.IO.File]::ReadAllText((Join-Path $source '.version')).Trim() }
    catch { return $null }
}

function Sync-Agent([string]$Uv) {
    & $Uv sync --project $source --quiet *> $null
    if ($LASTEXITCODE -eq 0) { return $true }
    # Uma atualizacao do Windows pode deixar o venv parcialmente quebrado. Ele e descartavel.
    $venv = Join-Path $base 'venv'
    if (Test-Path -LiteralPath $venv) { Remove-Item -LiteralPath $venv -Recurse -Force -ErrorAction SilentlyContinue }
    & $Uv sync --project $source --quiet *> $null
    return ($LASTEXITCODE -eq 0)
}

function Schedule-NextUpdate {
    return (Get-Date).AddHours(6).AddMinutes((Get-Random -Minimum 0 -Maximum 46))
}

function Invoke-Update([string]$Uv) {
    $before = Get-Version
    $env:UV = $Uv
    & $Uv run --project $source uniover-agent self-update *> $null
    $after = Get-Version
    if ($before -and $after -and $before -ne $after) {
        [System.IO.File]::WriteAllText($trial, ($after + '|0'), [System.Text.Encoding]::ASCII)
        return $true
    }
    return $false
}

function Note-Run([double]$Seconds) {
    if (-not (Test-Path -LiteralPath $trial)) { return }
    $parts = (Get-Content -LiteralPath $trial -ErrorAction SilentlyContinue) -split '\|', 2
    if ($parts.Count -ne 2 -or $parts[0] -ne (Get-Version)) { return }
    if ($Seconds -ge 600) {
        Remove-Item -LiteralPath $trial -Force -ErrorAction SilentlyContinue
        return
    }
    $falls = 0
    [void][int]::TryParse($parts[1], [ref]$falls)
    $falls++
    if ($falls -lt 3 -or -not (Test-Path -LiteralPath $previous)) {
        [System.IO.File]::WriteAllText($trial, ($parts[0] + '|' + $falls), [System.Text.Encoding]::ASCII)
        return
    }
    $bad = Join-Path $base ('agent-src.rejected-' + $parts[0].Substring(0, 12))
    Remove-Item -LiteralPath $bad -Recurse -Force -ErrorAction SilentlyContinue
    try {
        Move-Item -LiteralPath $source -Destination $bad -ErrorAction Stop
        Move-Item -LiteralPath $previous -Destination $source -ErrorAction Stop
        if (-not (Select-String -LiteralPath $blocked -SimpleMatch $parts[0] -Quiet -ErrorAction SilentlyContinue)) {
            Add-Content -LiteralPath $blocked -Value $parts[0] -Encoding ASCII
        }
        Remove-Item -LiteralPath $trial -Force -ErrorAction SilentlyContinue
    }
    catch {
        # Na proxima tentativa o wrapper ainda tem a versao atual e tenta se recuperar de novo.
    }
}

Set-Location -LiteralPath $base
$wait = 5
$nextUpdate = [DateTime]::MinValue
while ($true) {
    $uv = Find-Uv
    if (-not $uv -or -not (Test-Path -LiteralPath $source)) {
        Start-Sleep -Seconds 300
        continue
    }
    $updated = $false
    if ((Get-Date) -ge $nextUpdate) {
        $updated = Invoke-Update $uv
        $nextUpdate = Schedule-NextUpdate
    }
    if (-not (Sync-Agent $uv)) {
        Start-Sleep -Seconds $wait
        $wait = [Math]::Min($wait * 2, 300)
        continue
    }
    $arguments = 'run --project "' + $source + '" uniover-agent run'
    $process = Start-Process -FilePath $uv -ArgumentList $arguments -PassThru -WindowStyle Hidden
    $started = Get-Date
    $restartForUpdate = $false
    while (-not $process.HasExited) {
        Start-Sleep -Seconds 15
        if ((Get-Date) -ge $nextUpdate) {
            if (Invoke-Update $uv) {
                # O uv run abre um python filho: derrubar so o uv deixaria o agente antigo vivo.
                & taskkill.exe /PID $process.Id /T /F *> $null
                $restartForUpdate = $true
            }
            $nextUpdate = Schedule-NextUpdate
        }
    }
    $seconds = ((Get-Date) - $started).TotalSeconds
    if (-not $restartForUpdate) { Note-Run $seconds }
    if ($seconds -gt 600) { $wait = 5 }
    if ($restartForUpdate) { $wait = 5 }
    Start-Sleep -Seconds $wait
    $wait = [Math]::Min($wait * 2, 300)
}
'@

function Write-AgentWrapper([string]$Uv) {
    $wrapperText = $wrapperTemplate.Replace('__UV__', $Uv.Replace("'", "''"))
    # Mantido apenas para atualizar instalacoes muito antigas que ainda chamam este nome.
    [System.IO.File]::WriteAllText((Join-Path $base 'run-agent.ps1'), $wrapperText, [System.Text.Encoding]::ASCII)
}

function Write-AgentLauncher {
    $updatedWrapper = Join-Path $source 'tools\run-agent.ps1'
    $updatedLauncher = Join-Path $source 'tools\launcher.ps1'
    if (-not (Test-Path -LiteralPath $updatedWrapper) -or -not (Test-Path -LiteralPath $updatedLauncher)) {
        throw 'O pacote do agente nao tem os arquivos de inicializacao.'
    }
    # O lancador nao muda: ele sempre delega para o supervisor que veio dentro de app atualizado.
    Copy-Item -LiteralPath $updatedLauncher -Destination $launcher -Force
    # Esta copia fica conhecida boa ate o proximo instalador; protege contra um supervisor futuro ruim.
    Copy-Item -LiteralPath $updatedWrapper -Destination $fallback -Force
}

$uv = Find-Uv
New-Item -ItemType Directory -Path $base -Force | Out-Null
# O instalador e um caminho manual de recuperacao: pare o supervisor antigo antes de mover
# qualquer pasta que ele possa estar usando. A auto-atualizacao usa o lancador estavel acima.
Stop-Agent
Move-LegacyLayout
Write-Readme
Write-StartMenuShortcut
$env:UNIOVER_CONFIG_FILE = $config
$env:UV_PROJECT_ENVIRONMENT = Join-Path $base 'runtime\venv'

if ($automatic) {
    # O ambiente Python fica FORA da pasta do agente e o uv roda com --project: assim a
    # auto-atualizacao consegue trocar a pasta do agente por renomeacao (pasta em uso nao troca).
    $env:UV_PROJECT_ENVIRONMENT = Join-Path $base 'runtime\venv'

    Get-AgentSource $source
    # A instalacao direta ja foi testada abaixo; uma versao anterior de outra instalacao nao e um
    # retorno valido caso este primeiro processo caia.
    Remove-Item -LiteralPath (Join-Path $base 'app.previous') -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $base 'update-trial.txt') -Force -ErrorAction SilentlyContinue
    Set-ConfigValues $config @{ api_url = $ApiUrl }

    Write-Host 'Preparando o ambiente Python (na primeira vez demora um pouco)...'
    & $uv sync --project $source
    if ($LASTEXITCODE -ne 0) {
        throw 'Nao foi possivel preparar o agente.'
    }

    # 1. Acha a TV na rede. O agente grava tipo, endereco e identificador no agent.toml.
    $findArguments = @('run', '--project', $source, 'uniover-agent', 'tv-find')
    if ($PSBoundParameters.ContainsKey('TvKind')) {
        $findArguments += @('--kind', $TvKind)
    }
    & $uv @findArguments
    $tvFound = ($LASTEXITCODE -eq 0)
    if (-not $tvFound) {
        Write-Host ''
        Write-Host 'Nao achei a TV sozinho. Confira se ela esta ligada e no mesmo Wi-Fi deste computador.'
        $typed = Read-Host 'Se souber o endereco IP da TV, digite aqui (ou aperte Enter para seguir sem a TV)'
        if ($typed) {
            $isSamsung = Read-Host 'A TV e Samsung? (s/N)'
            $kind = 'android'
            if ($isSamsung -match '^[sS]') {
                $kind = 'samsung'
            }
            Set-ConfigValues $config @{ tv_kind = $kind; tv_host = $typed.Trim() }
            $tvFound = $true
        }
    }

    # 2. Pareia este PC com a conta (codigo + QR). Ja pareado: nao pede de novo.
    & $uv run --project $source uniover-agent pair --if-needed
    if ($LASTEXITCODE -ne 0) {
        throw 'O pareamento do agente nao foi concluido.'
    }

    # 3. Pareia a TV (na Samsung, aceite o aviso Permitir na tela da TV).
    $tvPaired = $false
    if ($tvFound) {
        & $uv run --project $source uniover-agent tv-pair --if-needed
        $tvPaired = ($LASTEXITCODE -eq 0)
        if (-not $tvPaired) {
            Write-Host 'O pareamento da TV nao foi concluido. Rode este arquivo de novo com a TV ligada.'
        }
    }

    # 4. O agente passa a iniciar com o Windows, sem janela, sem perguntar.
    Write-AgentLauncher
    Register-AgentTask "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
    Start-ScheduledTask -TaskName $taskName

    Write-Host ''
    Write-Host 'Pronto. O que foi feito:'
    Write-Host "  - O agente foi instalado em $source e se atualiza sozinho."
    if ($tvPaired) {
        Write-Host '  - A TV foi encontrada e pareada.'
    }
    else {
        Write-Host '  - A TV ainda nao esta pareada (rode este arquivo de novo com a TV ligada).'
    }
    Write-Host "  - Foi criada a tarefa agendada '$taskName': o agente inicia sozinho quando voce entra no Windows, sem janela."
    Write-Host "  - O que o agente faz fica registrado em $(Join-Path $base 'logs\agent.log')."
    Write-Host 'Para remover, rode o comando abaixo (a configuracao e o pareamento ficam):'
    Write-Host ('  powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm ' + $installerUrl + '))) -Uninstall"')
    exit 0
}

# --- Modo manual (-TvHost informado) ---------------------------------------------------------
Get-AgentSource $source
Remove-Item -LiteralPath (Join-Path $base 'app.previous') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $base 'update-trial.txt') -Force -ErrorAction SilentlyContinue
Write-Config $config @("api_url = " + ($ApiUrl | ConvertTo-Json -Compress))

Write-Host 'Preparando o ambiente Python...'
& $uv --directory $source sync
if ($LASTEXITCODE -ne 0) {
    throw 'Nao foi possivel preparar o agente.'
}

Write-Host 'Aprovacao do agente'
Write-Host 'O proximo comando mostrara um codigo e um QR. Abra o app UniOver e aprove.'
& $uv --directory $source run uniover-agent pair
if ($LASTEXITCODE -ne 0) {
    throw 'O pareamento do agente nao foi concluido.'
}

# O pareamento preserva chaves locais; trocamos so os campos da TV para nunca guardar token aqui.
Set-ConfigValues $config @{ tv_kind = $TvKind; tv_host = $TvHost }

if ($TvKind -eq 'samsung') {
    Write-Host 'Aceite o aviso Permitir na TV Samsung quando ele aparecer.'
}
& $uv --directory $source run uniover-agent tv-pair --kind $TvKind --host $TvHost
if ($LASTEXITCODE -ne 0) {
    throw 'O pareamento da TV nao foi concluido.'
}

$answer = Read-Host "Registrar a tarefa '$taskName' para iniciar ao entrar no Windows? (s/N)"
if ($answer -match '^[sS]') {
    Write-AgentLauncher
    Register-AgentTask "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
    Start-ScheduledTask -TaskName $taskName
    Write-Host 'Tarefa registrada e iniciada.'
}
else {
    Write-Host 'A tarefa nao foi registrada. Para iniciar agora: uv run uniover-agent run'
}
