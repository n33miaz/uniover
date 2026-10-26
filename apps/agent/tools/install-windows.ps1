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
#    Roda SEM console: todo o andamento aparece numa pagina local no navegador (a mesma do QR).
#  - Manual (com -TvHost): o comportamento de sempre, com a pergunta antes de criar a tarefa.
#
# Regra: nenhuma janela de console pode aparecer para a pessoa. Aqui os programas de console sao chamados direto
# (herdam o console oculto deste processo) e o que precisa de um processo novo usa CreateNoWindow. A unica janela
# aceitavel e o pedido de permissao do Windows (UAC), feito uma vez.

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
$launcherVbs = Join-Path $base 'launcher.vbs'
$fallback = Join-Path $base 'run-agent.fallback.ps1'
$pageFile = Join-Path $base 'web\conectar.html'
$installerUrl = 'https://raw.githubusercontent.com/n33miaz/uniover/main/apps/agent/tools/install-windows.ps1'
$automatic = -not $PSBoundParameters.ContainsKey('TvHost')
$tvKindGiven = $PSBoundParameters.ContainsKey('TvKind')

function Write-Page([string]$Html, [bool]$Reload = $true) {
    # Pagina de andamento (modo automatico). $Html ja vem com as entidades HTML (o arquivo e so ASCII). Troca por
    # renomeacao: a pagina se recarrega sozinha e nunca pode ler meio arquivo.
    $refresh = ''
    if ($Reload) {
        $refresh = '<meta http-equiv="refresh" content="3">'
    }
    $page = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' + $refresh +
        '<meta name="viewport" content="width=device-width, initial-scale=1"><title>UniOver</title>' +
        '<style>body{margin:0;background:#f8fafc;color:#111827;font:24px/1.5 system-ui,sans-serif}' +
        'main{box-sizing:border-box;max-width:720px;margin:0 auto;padding:64px 24px;text-align:center}' +
        'h1{margin:0;font-size:32px}@media(prefers-color-scheme:dark){body{background:#0f172a;color:#f1f5f9}}' +
        '</style></head><body><main><h1>' + $Html + '</h1></main></body></html>'
    try {
        New-Item -ItemType Directory -Path (Split-Path $pageFile -Parent) -Force | Out-Null
        $temporary = $pageFile + '.new'
        [System.IO.File]::WriteAllText($temporary, $page, [System.Text.UTF8Encoding]::new($false))
        try {
            Move-Item -LiteralPath $temporary -Destination $pageFile -Force
        }
        catch {
            [System.IO.File]::WriteAllText($pageFile, $page, [System.Text.UTF8Encoding]::new($false))
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
    catch { }
}

function Open-Page {
    try {
        Start-Process -FilePath $pageFile
    }
    catch { }
}

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

function Restore-RunningAgent {
    # Instalacao que falhou: o Stop-Agent parou a tarefa antes de tudo, entao o agente que ja estava instalado (e que a
    # falha nao tocou) volta a rodar. Sem instalacao anterior ou sem tarefa registrada, nao ha o que religar.
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $source 'tools\run-agent.ps1'))) {
            return
        }
        if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
            return
        }
        Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    }
    catch { }
}

if ($Uninstall) {
    Stop-Agent
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $launcherVbs -Force -ErrorAction SilentlyContinue
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

function Move-Folder([string]$From, [string]$To) {
    # Renomeacao de verdade (Directory.Move): ou troca o nome inteiro ou falha sem tocar em nada. O Move-Item, quando ha um
    # arquivo aberto dentro da pasta, cai para copiar-e-apagar e deixa metade dos arquivos em cada lugar.
    [System.IO.Directory]::Move([System.IO.Path]::GetFullPath($From), [System.IO.Path]::GetFullPath($To))
}

function Get-AgentSource([string]$Destination) {
    # Baixa o commit exato (e grava .version para a auto-atualizacao saber de onde partiu).
    # O pacote e extraido e conferido numa pasta candidata ao lado ($Destination.new); so depois disso ela troca de lugar
    # com a instalacao atual por renomeacao (a atual fica em $Destination.previous), o mesmo desenho da atualizacao
    # automatica. Download, extracao ou conferencia que falhem deixam a instalacao que funciona exatamente como estava.
    $temporary = Join-Path $env:TEMP ('uniover-agent-' + [guid]::NewGuid())
    $zip = Join-Path $temporary 'main.zip'
    $candidate = $Destination + '.new'
    $oldFolder = $Destination + '.previous'
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
        if (Test-Path -LiteralPath $candidate) {
            Remove-Item -LiteralPath $candidate -Recurse -Force
        }
        New-Item -ItemType Directory -Path $candidate -Force | Out-Null
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $root = [System.IO.Path]::GetFullPath($candidate).TrimEnd('\') + '\'
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
        if ($extracted -eq 0 -or -not (Test-Path -LiteralPath (Join-Path $candidate 'pyproject.toml'))) {
            throw 'O pacote baixado nao contem apps\agent.'
        }
        $png = Join-Path $candidate 'assets\uniover.png'
        $ico = Join-Path $candidate 'assets\uniover.ico'
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
            [System.IO.File]::WriteAllText((Join-Path $candidate '.version'), $sha + "`n", [System.Text.UTF8Encoding]::new($false))
        }
        # A candidata esta inteira: agora sim, a troca. A anterior que sobrou de outra vez sai primeiro (se nao sair, nada
        # e movido: renomear uma pasta para cima de outra existente poria uma dentro da outra).
        if (Test-Path -LiteralPath $Destination) {
            Remove-Item -LiteralPath $oldFolder -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $oldFolder) {
                throw 'Nao consegui liberar a pasta da versao anterior do agente. A instalacao atual ficou como estava.'
            }
            try {
                Move-Folder $Destination $oldFolder
            }
            catch {
                throw 'A pasta do agente esta em uso por outro programa. A instalacao atual ficou como estava.'
            }
        }
        try {
            Move-Folder $candidate $Destination
        }
        catch {
            # A segunda renomeacao falhou: a anterior volta para o lugar e a instalacao nunca fica sem pasta do agente.
            if ((Test-Path -LiteralPath $oldFolder) -and -not (Test-Path -LiteralPath $Destination)) {
                try { Move-Folder $oldFolder $Destination } catch { }
            }
            throw 'Nao consegui colocar a versao nova no lugar. A instalacao atual ficou como estava.'
        }
    }
    catch {
        Remove-Item -LiteralPath $candidate -Recurse -Force -ErrorAction SilentlyContinue
        throw
    }
    finally {
        Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Register-AgentTask {
    # A tarefa abre o launcher.vbs pelo WScript, que nao tem console: o PowerShell nasce oculto e nada pisca no logon
    # (o PowerShell direto na tarefa pisca um console). So se o Windows nao tiver o Script Host
    # cai no PowerShell oculto. O padrao do Agendador mata a tarefa depois de 72 h e nao a inicia na bateria: o agente
    # precisa ficar de pe o tempo todo.
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    if ((Test-Path -LiteralPath $wscript) -and (Test-Path -LiteralPath $launcherVbs)) {
        $action = New-ScheduledTaskAction -Execute $wscript -Argument ('//B //Nologo "' + $launcherVbs + '"')
    }
    else {
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '"')
    }
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

function Write-AgentLauncher {
    $updatedWrapper = Join-Path $source 'tools\run-agent.ps1'
    $updatedLauncher = Join-Path $source 'tools\launcher.ps1'
    $updatedVbs = Join-Path $source 'tools\launcher.vbs'
    if (-not (Test-Path -LiteralPath $updatedWrapper) -or -not (Test-Path -LiteralPath $updatedLauncher)) {
        throw 'O pacote do agente nao tem os arquivos de inicializacao.'
    }
    # O lancador nao muda: ele sempre delega para o supervisor que veio dentro de app atualizado.
    Copy-Item -LiteralPath $updatedLauncher -Destination $launcher -Force
    if (Test-Path -LiteralPath $updatedVbs) {
        Copy-Item -LiteralPath $updatedVbs -Destination $launcherVbs -Force
    }
    # Esta copia fica conhecida boa ate o proximo instalador; protege contra um supervisor futuro ruim.
    Copy-Item -LiteralPath $updatedWrapper -Destination $fallback -Force
}

function Set-SystemSettings {
    # UMA elevacao (UAC), so para o que exige administrador e evita manutencao depois. A parte elevada roda num
    # PowerShell separado e oculto com -EncodedCommand (nao ha arquivo em pasta de usuario que alguem possa trocar antes
    # de ele rodar elevado) e NAO mexe em nada do usuario: sem LOCALAPPDATA, sem tarefa, sem Cofre de Credenciais, sem
    # donos de pasta. O resto deste instalador segue sem elevacao, como o usuario original. Devolve um texto de uma linha.
    $elevated = @'
$ErrorActionPreference = 'Continue'
$failed = 0
# Caminho absoluto: elevado, nada pode ser achado pelo PATH (uma pasta de usuario antes de System32 poria um
# powercfg.exe qualquer rodando como administrador). SystemRoot e definido pelo Windows e aponta para a instalacao dele.
$powercfg = Join-Path $env:SystemRoot 'System32\powercfg.exe'
# Na tomada o PC nao suspende nem hiberna (o agente precisa dele acordado); a tela pode apagar.
& $powercfg /change standby-timeout-ac 0
if ($LASTEXITCODE -ne 0) { $failed = $failed -bor 1 }
& $powercfg /change hibernate-timeout-ac 0
if ($LASTEXITCODE -ne 0) { $failed = $failed -bor 1 }
# O Windows desliga o adaptador de rede "para economizar energia" e derruba o Wi-Fi. Vale a partir do proximo
# reinicio do adaptador (nao o reiniciamos aqui para nao derrubar a internet no meio da instalacao).
try {
    $class = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e972-e325-11ce-bfc1-08002be10318}'
    foreach ($adapter in @(Get-NetAdapter -Physical -ErrorAction Stop)) {
        foreach ($key in @(Get-ChildItem -LiteralPath $class -ErrorAction SilentlyContinue)) {
            $id = (Get-ItemProperty -LiteralPath $key.PSPath -Name NetCfgInstanceId -ErrorAction SilentlyContinue).NetCfgInstanceId
            if ($id -eq $adapter.InterfaceGuid) {
                Set-ItemProperty -LiteralPath $key.PSPath -Name PnPCapabilities -Value 24 -Type DWord -ErrorAction Stop
            }
        }
    }
}
catch { $failed = $failed -bor 2 }
# Regra de entrada da descoberta da TV (SSDP, UDP 1900), so em redes privadas ou de dominio e so da propria sub-rede.
try {
    Get-NetFirewallRule -Name 'UniOver-SSDP-In' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop
    New-NetFirewallRule -Name 'UniOver-SSDP-In' -DisplayName 'UniOver descoberta da TV (SSDP)' -Direction Inbound -Protocol UDP -LocalPort 1900 -Action Allow -Profile Private,Domain -RemoteAddress LocalSubnet -ErrorAction Stop | Out-Null
}
catch { $failed = $failed -bor 4 }
exit $failed
'@
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($elevated))
    # Tambem o PowerShell que sobe elevado vem de um caminho absoluto, nunca do PATH.
    $systemShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    try {
        $process = Start-Process -FilePath $systemShell -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
    }
    catch {
        return 'Sem a permissao de administrador, o PC pode suspender e perder o Wi-Fi; rode de novo e aceite o aviso do Windows.'
    }
    if ($process.ExitCode -eq 0) {
        return 'Energia, rede e firewall ajustados para o agente.'
    }
    return 'Alguns ajustes do sistema nao puderam ser aplicados; o agente funciona, mas o PC pode suspender ou perder o Wi-Fi.'
}

function Invoke-AutomaticInstall {
    Write-Page 'Instalando o UniOver&hellip;'
    Open-Page

    $uv = Find-Uv
    New-Item -ItemType Directory -Path $base -Force | Out-Null
    # O instalador e um caminho manual de recuperacao: pare o supervisor antigo antes de mover
    # qualquer pasta que ele possa estar usando. A auto-atualizacao usa o lancador estavel acima.
    Stop-Agent
    Move-LegacyLayout
    Write-Readme
    Write-StartMenuShortcut
    $env:UNIOVER_CONFIG_FILE = $config
    # O ambiente Python fica FORA da pasta do agente e o uv roda com --project: assim a
    # auto-atualizacao consegue trocar a pasta do agente por renomeacao (pasta em uso nao troca).
    $env:UV_PROJECT_ENVIRONMENT = Join-Path $base 'runtime\venv'

    # A unica janela que aparece e o pedido de permissao do Windows, uma vez; depois disso nenhuma atualizacao pede.
    Write-Page 'Aceite o aviso de permiss&atilde;o do Windows (s&oacute; desta vez).'
    $system = Set-SystemSettings
    Write-Page 'Instalando o UniOver&hellip;'

    # A instalacao que existia, se havia, fica em app.previous (a troca e feita dentro de Get-AgentSource, so depois de o
    # pacote novo estar inteiro): se este processo cair, ainda ha para onde voltar.
    Get-AgentSource $source
    Remove-Item -LiteralPath (Join-Path $base 'update-trial.txt') -Force -ErrorAction SilentlyContinue
    Set-ConfigValues $config @{ api_url = $ApiUrl }

    Write-Host 'Preparando o ambiente Python (na primeira vez demora um pouco)...'
    & $uv sync --project $source
    if ($LASTEXITCODE -ne 0) {
        throw 'Nao foi possivel preparar o agente.'
    }

    # 1. Acha a TV na rede. O agente grava tipo, endereco e identificador no agent.toml.
    Write-Page 'Procurando a TV&hellip;'
    $findArguments = @('run', '--project', $source, 'uniover-agent', 'tv-find')
    if ($tvKindGiven) {
        $findArguments += @('--kind', $TvKind)
    }
    & $uv @findArguments
    $tvFound = ($LASTEXITCODE -eq 0)

    # 2. Pareia este PC com a conta (codigo + QR na pagina local, que se atualiza sozinha). Ja pareado: nao pede de novo.
    # A pagina ja esta aberta: o agente so a reescreve (--no-browser evita uma segunda aba).
    & $uv run --project $source uniover-agent pair --if-needed --no-browser --installing
    if ($LASTEXITCODE -ne 0) {
        throw 'O pareamento do agente nao foi concluido.'
    }

    # 3. Pareia a TV (na Samsung, aceite o aviso Permitir na tela da TV; na Android TV o codigo e pedido numa janela).
    $tvPaired = $false
    if ($tvFound) {
        Write-Page 'Pareando a TV&hellip; Aceite Permitir na tela da TV, ou digite o c&oacute;digo na janela que abrir.'
        & $uv run --project $source uniover-agent tv-pair --if-needed --installing
        $tvPaired = ($LASTEXITCODE -eq 0)
    }

    # 4. O agente passa a iniciar com o Windows, sem janela, sem perguntar.
    Write-AgentLauncher
    Register-AgentTask
    Start-ScheduledTask -TaskName $taskName

    Write-Host ''
    Write-Host 'Pronto. O que foi feito:'
    Write-Host "  - O agente foi instalado em $source e se atualiza sozinho."
    Write-Host "  - $system"
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

    if ($tvPaired) {
        Write-Page 'Pronto. Pode fechar esta janela.' $false
    }
    else {
        Write-Page 'Pronto, mas a TV ainda n&atilde;o foi pareada. Ligue a TV e abra o conector de novo.' $false
    }
}

if ($automatic) {
    try {
        Invoke-AutomaticInstall
        exit 0
    }
    catch {
        $reason = [System.Net.WebUtility]::HtmlEncode($_.Exception.Message)
        Write-Host ("Falha: " + $_.Exception.Message)
        Restore-RunningAgent
        Write-Page ('A instala&ccedil;&atilde;o n&atilde;o terminou: ' + $reason + ' Feche esta janela e abra o conector de novo.') $false
        exit 1
    }
}

# --- Modo manual (-TvHost informado), pensado para um terminal visivel ------------------------------
# Qualquer falha daqui para baixo religa antes o agente que ja estava instalado e so entao encerra com o erro.
trap { Restore-RunningAgent; break }
$uv = Find-Uv
New-Item -ItemType Directory -Path $base -Force | Out-Null
Stop-Agent
Move-LegacyLayout
Write-Readme
Write-StartMenuShortcut
$env:UNIOVER_CONFIG_FILE = $config
$env:UV_PROJECT_ENVIRONMENT = Join-Path $base 'runtime\venv'

Get-AgentSource $source
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
    Register-AgentTask
    Start-ScheduledTask -TaskName $taskName
    Write-Host 'Tarefa registrada e iniciada.'
}
else {
    Write-Host 'A tarefa nao foi registrada. Para iniciar agora: uv run uniover-agent run'
}
