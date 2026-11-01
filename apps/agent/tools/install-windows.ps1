[CmdletBinding()]
param(
    [ValidateSet('android', 'samsung')]
    [string]$TvKind = 'android',
    [string]$TvHost,
    [string]$ApiUrl = 'https://uniover.onrender.com',
    # Branch do repositorio de onde vem o codigo do agente; rode de novo com o padrao para atualizar. Hoje e a develop
    # (a develop e a producao); o agente instalado segue o mesmo ramo (update_channel no agent.toml). Para voltar a
    # publicar pela main, troque aqui, o DEFAULT_CHANNEL do agente e o endereco do conectar-uniover.cmd (um teste confere).
    [string]$Ref = 'develop',
    # Pasta onde o UniOver fica guardado (sem isto, uma janela pergunta na primeira instalacao; numa reinstalacao a
    # pasta que ja existe e mantida).
    [string]$InstallDir,
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
# A pasta fixa guarda so o que o Windows precisa achar sempre no mesmo lugar: o lancador (a tarefa o abre), o launcher.vbs
# e o ponteiro (location.txt) da pasta que a pessoa escolheu. Tudo o mais (app, runtime, config, logs, web) fica na pasta
# de instalacao, que por padrao e a propria pasta fixa: quem ja tinha o UniOver instalado nao muda nada.
$anchor = Join-Path $env:LOCALAPPDATA 'UniOver'
$pointerFile = Join-Path $anchor 'location.txt'
$launcher = Join-Path $anchor 'launcher.ps1'
$launcherVbs = Join-Path $anchor 'launcher.vbs'
$installerUrl = "https://raw.githubusercontent.com/n33miaz/uniover/$Ref/apps/agent/tools/install-windows.ps1"
$automatic = -not $PSBoundParameters.ContainsKey('TvHost')
$tvKindGiven = $PSBoundParameters.ContainsKey('TvKind')

function Set-Layout([string]$Root) {
    # Tudo o que depende da pasta de instalacao, num lugar so (e refeito quando a pessoa escolhe outra pasta).
    $script:base = $Root
    $script:source = Join-Path $Root 'app'
    $script:config = Join-Path $Root 'config\agent.toml'
    $script:fallback = Join-Path $Root 'run-agent.fallback.ps1'
    $script:pageFile = Join-Path $Root 'web\conectar.html'
}

function Get-ExistingBase {
    # A pasta de uma instalacao que ja existe: a do ponteiro (lido como UTF-8, o caminho pode ter acento) ou a fixa.
    # Sem nenhuma das duas e uma primeira instalacao: devolve $null.
    try {
        $text = ([System.IO.File]::ReadAllText($pointerFile, [System.Text.Encoding]::UTF8) -split "`n")[0].Trim()
        if ($text -and [System.IO.Path]::IsPathRooted($text) -and (Test-Path -LiteralPath $text -PathType Container)) { return $text }
    }
    catch { }
    if ((Test-Path -LiteralPath (Join-Path $anchor 'app')) -or (Test-Path -LiteralPath (Join-Path $anchor 'agent-src'))) { return $anchor }
    return $null
}

Set-Layout $anchor
$existingBase = Get-ExistingBase
if ($existingBase) { Set-Layout $existingBase }

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

function Backup-Environment {
    # O ambiente Python (runtime\venv) fica de lado ANTES da troca e do preparo do ambiente definitivo: o uv sync altera o
    # ambiente no lugar, e uma falha depois dele nao pode deixar o codigo antigo sem o ambiente que ele conhece. So renomeia
    # (nao copia). Se nao der para guardar, a instalacao para aqui, antes de mexer em qualquer coisa.
    $venv = Join-Path $base 'runtime\venv'
    $backup = Join-Path $base 'runtime\venv.previous'
    if (-not (Test-Path -LiteralPath $venv)) { return }
    try {
        Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $backup) { throw 'a copia antiga do ambiente nao saiu do lugar' }
        Move-Folder $venv $backup
        $script:environmentBackup = $backup
    }
    catch {
        Write-InstallLog ('Nao consegui guardar o ambiente anterior: ' + $_.Exception.Message)
        throw 'O UniOver esta aberto por outro programa agora. Feche-o e tente de novo; a instalacao atual ficou como estava.'
    }
}

function Remove-EnvironmentBackup {
    # A instalacao deu certo: o ambiente guardado nao serve mais e libera o espaco.
    if ($script:environmentBackup) {
        Remove-Item -LiteralPath $script:environmentBackup -Recurse -Force -ErrorAction SilentlyContinue
        $script:environmentBackup = $null
    }
}

function Restore-PreviousVersion {
    # Falha DEPOIS da troca (preparar o ambiente definitivo, examinar a versao instalada): a versao que funcionava esta em
    # app.previous e volta ao lugar antes de o agente ser religado; sem isto o instalador religaria a candidata quebrada.
    # O ambiente Python guardado (Backup-Environment) volta junto: codigo antigo com ambiente novo pode nem iniciar.
    try {
        if ($script:environmentBackup -and (Test-Path -LiteralPath $script:environmentBackup)) {
            $venv = Join-Path $base 'runtime\venv'
            Remove-Item -LiteralPath $venv -Recurse -Force -ErrorAction SilentlyContinue
            Move-Folder $script:environmentBackup $venv
            Write-InstallLog 'O ambiente Python anterior voltou ao lugar.'
            $script:environmentBackup = $null
        }
    }
    catch {
        Write-InstallLog ('Nao consegui devolver o ambiente anterior: ' + $_.Exception.Message)
    }
    try {
        if ($script:swappedOut -and (Test-Path -LiteralPath $script:swappedOut) -and (Test-Path -LiteralPath $source)) {
            Remove-Item -LiteralPath $source -Recurse -Force
            Move-Folder $script:swappedOut $source
            Write-InstallLog 'A versao nova falhou depois da troca; a anterior voltou ao lugar.'
            $script:swappedOut = $null
        }
    }
    catch {
        Write-InstallLog ('Nao consegui devolver a versao anterior: ' + $_.Exception.Message)
    }
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
    Write-Host 'O UniOver foi desligado: ele nao inicia mais com o Windows e parou de funcionar neste computador.'
    Write-Host "Suas configuracoes e o pareamento ficaram em $base; apague essa pasta se quiser tirar tudo."
    exit 0
}

function Find-Uv {
    $command = Get-Command uv -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    Write-Host 'Preparando uma ferramenta que o UniOver precisa (so na primeira vez)...'
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
        throw 'Uma ferramenta que o UniOver precisa foi instalada, mas o Windows ainda nao a encontrou. Feche tudo e abra o conector de novo.'
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

function Get-MoveFailureReason([Exception]$Exception) {
    # A excecao pode trazer o perfil do usuario no caminho. O tipo, HRESULT e texto sem o caminho ainda dizem por que a
    # troca falhou, sem gravar esse dado no diagnostico exibido.
    $reasons = @()
    $current = $Exception
    while ($null -ne $current) {
        $message = $current.Message -replace '[A-Za-z]:\\[^\r\n''"]*', '<caminho omitido>'
        $hresult = [Convert]::ToString($current.HResult, 16).PadLeft(8, '0')
        $reasons += "$($current.GetType().Name): $message (HRESULT 0x$hresult)"
        $current = $current.InnerException
    }
    return $reasons -join ' <- '
}

function Move-Folder([string]$From, [string]$To) {
    # Renomeacao de verdade (Directory.Move): ou troca o nome inteiro ou falha sem tocar em nada. O Move-Item, quando ha um
    # arquivo aberto dentro da pasta, cai para copiar-e-apagar e deixa metade dos arquivos em cada lugar.
    $fromFull = [System.IO.Path]::GetFullPath($From)
    $toFull = [System.IO.Path]::GetFullPath($To)
    $fromVolume = [System.IO.Path]::GetPathRoot($fromFull)
    $toVolume = [System.IO.Path]::GetPathRoot($toFull)
    if (-not [string]::Equals($fromVolume, $toVolume, [StringComparison]::OrdinalIgnoreCase)) {
        throw "A candidata e o destino estao em volumes diferentes ($fromVolume e $toVolume)."
    }
    # Antivirus e indexador podem segurar por instantes um arquivo que acabou de ser extraido. So repetimos os erros
    # transitorios de compartilhamento/acesso; os demais continuam a mostrar o defeito real imediatamente.
    $retryable = @(-2147024891, -2147024864, -2147024863) # acesso negado, arquivo em uso, bloqueio de arquivo
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try {
            [System.IO.Directory]::Move($fromFull, $toFull)
            return
        }
        catch {
            $current = $_.Exception
            $retry = $false
            while ($null -ne $current) {
                if ($retryable -contains $current.HResult) {
                    $retry = $true
                    break
                }
                $current = $current.InnerException
            }
            if (-not $retry -or $attempt -eq 4) {
                throw
            }
            Start-Sleep -Milliseconds (200 * ($attempt + 1))
        }
    }
}

function Get-ZipComment([string]$Path) {
    # O comentario do fim do zip (o GitHub grava ali o codigo do commit). Procura o registro final do zip nos ultimos
    # 64 KB. Devolve $null se o arquivo nao tem esse registro (nao e um zip inteiro).
    try {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        $floor = [Math]::Max(0, $bytes.Length - 65557)
        for ($i = $bytes.Length - 22; $i -ge $floor; $i--) {
            if ($bytes[$i] -eq 0x50 -and $bytes[$i + 1] -eq 0x4B -and $bytes[$i + 2] -eq 0x05 -and $bytes[$i + 3] -eq 0x06) {
                $length = $bytes[$i + 20] + 256 * $bytes[$i + 21]
                if ($i + 22 + $length -ne $bytes.Length) { continue }
                return [System.Text.Encoding]::ASCII.GetString($bytes, $i + 22, $length).Trim()
            }
        }
    }
    catch { }
    return $null
}

function Get-AgentSource([string]$Destination, [scriptblock]$Verify = $null) {
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
            throw 'Nao consegui buscar a versao mais nova do UniOver. Confira a internet e tente de novo.'
        }
        if ($reply.sha -notmatch '^[0-9a-f]{40}$') {
            throw 'O servidor de downloads nao informou uma versao valida do UniOver.'
        }
        $sha = $reply.sha
        $address = "https://github.com/n33miaz/uniover/archive/$sha.zip"
        Write-Host 'Baixando o UniOver...'
        Invoke-WebRequest -UseBasicParsing -Uri $address -OutFile $zip
        # O pacote tem o codigo da versao gravado nele: um pacote de outra versao, ou que nao veio inteiro, nao passa.
        if ((Get-ZipComment $zip) -ne $sha) {
            throw 'O pacote baixado nao e da versao esperada. A instalacao atual ficou como estava.'
        }
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
            throw 'O pacote baixado esta incompleto.'
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
        # A candidata esta inteira, mas ainda nao foi vista funcionando: $Verify (preparar e examinar a candidata no ambiente
        # dela) roda ANTES da troca. Se falhar, a instalacao que funciona nem chega a sair do lugar.
        if ($Verify) { & $Verify $candidate }
        # Agora sim, a troca. A anterior que sobrou de outra vez sai primeiro (se nao sair, nada
        # e movido: renomear uma pasta para cima de outra existente poria uma dentro da outra).
        if (Test-Path -LiteralPath $Destination) {
            Remove-Item -LiteralPath $oldFolder -Recurse -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $oldFolder) {
                throw 'Nao consegui liberar a pasta da versao anterior do UniOver. A instalacao atual ficou como estava.'
            }
            try {
                Move-Folder $Destination $oldFolder
                $script:swappedOut = $oldFolder
            }
            catch {
                $reason = Get-MoveFailureReason $_.Exception
                Write-InstallLog "Pasta em uso: $reason"
                throw 'O UniOver esta aberto por outro programa agora. Feche-o e tente de novo; a instalacao atual ficou como estava.'
            }
        }
        try {
            Move-Folder $candidate $Destination
        }
        catch {
            # A segunda renomeacao falhou: a anterior volta para o lugar e a instalacao nunca fica sem pasta do agente.
            $reason = Get-MoveFailureReason $_.Exception
            if ((Test-Path -LiteralPath $oldFolder) -and -not (Test-Path -LiteralPath $Destination)) {
                try { Move-Folder $oldFolder $Destination } catch { }
            }
            Write-InstallLog "Troca da versao falhou: $reason"
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
    # Logon sobe na hora; a repeticao a cada 10 min sobe de novo se o agente ou o lancador morreram (o mutex do lancador
    # garante uma instancia so); o reinicio por falha cobre queda do processo. Interativa de proposito: o token fica no
    # Cofre de Credenciais do usuario, que uma tarefa sem logon nao abre, e o gatilho de inicializacao do sistema
    # exigiria administrador. Sem acordar o PC por agenda: o agente ja pede ao Windows que nao suspenda por ociosidade.
    $triggers = @(
        (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
        (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650))
    )
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
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

Esta pasta guarda o UniOver deste computador: o programa que liga o PC ao app e a TV.
Ele inicia sozinho quando voce entra no Windows, fica perto do relogio e se atualiza e se arruma sozinho.

O que tem aqui (voce nao precisa mexer em nada):
  app       o programa em si (troca sozinho a cada atualizacao; a versao anterior fica guardada ao lado)
  config    suas configuracoes
  logs      o que o UniOver fez e o que deu errado (agent.log, supervisor.log, instalacao.log)
  runtime   o que ele precisa para funcionar e o estado das atualizacoes
  web       a pagina de conexao
  tv        a chave de acesso a sua TV
  icons     as figuras dos apps da TV

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
        throw 'O pacote baixado nao tem os arquivos de inicializacao.'
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

function Write-InstallLog([string]$Message) {
    # Os detalhes tecnicos (para quem for ajudar) ficam em logs\instalacao.log; a pessoa so ve frases simples.
    try {
        $logs = Join-Path $base 'logs'
        New-Item -ItemType Directory -Path $logs -Force | Out-Null
        $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture)
        [System.IO.File]::AppendAllText((Join-Path $logs 'instalacao.log'), ($stamp + ' ' + $Message + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    }
    catch { }
}

function Test-InstallFolder([string]$Full) {
    # Recusa, com uma frase que a pessoa entende, a pasta em que o UniOver nao funcionaria bem: de rede, de disco removivel,
    # protegida pelo Windows (exigiria administrador a cada atualizacao), longa demais (o Windows limita o caminho a 260
    # caracteres e as dependencias do programa sao fundas), sem espaco ou sem permissao de escrita.
    $root = [System.IO.Path]::GetPathRoot($Full)
    if (-not $root -or $root.StartsWith('\\')) {
        throw 'Escolha uma pasta num disco do proprio computador (nao uma pasta de rede).'
    }
    $drive = New-Object System.IO.DriveInfo($root)
    if ($drive.DriveType -ne [System.IO.DriveType]::Fixed) {
        throw 'Escolha uma pasta num disco do computador: um pen drive ou disco removivel pode ser desconectado e o UniOver pararia.'
    }
    foreach ($protected in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:SystemRoot)) {
        if ($protected -and $Full.StartsWith($protected, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'O Windows protege essa pasta. Escolha outra, por exemplo uma pasta dentro do seu usuario ou em outro disco.'
        }
    }
    if ($Full.Length -gt 80) {
        throw 'O caminho dessa pasta e longo demais. Escolha uma pasta mais curta.'
    }
    if ($drive.AvailableFreeSpace -lt 1GB) {
        throw 'Nao ha espaco livre suficiente nesse disco (o UniOver precisa de cerca de 1 GB).'
    }
    try {
        New-Item -ItemType Directory -Path $Full -Force | Out-Null
        $probe = Join-Path $Full '.escrita'
        [System.IO.File]::WriteAllText($probe, 'ok')
        Remove-Item -LiteralPath $probe -Force
    }
    catch {
        throw 'Nao consigo gravar nessa pasta. Escolha outra.'
    }
}

function Resolve-InstallFolder([string]$Path) {
    # O UniOver sempre fica numa pasta propria chamada UniOver: se a pessoa escolheu "D:\Programas", fica em
    # "D:\Programas\UniOver" (nunca espalha arquivos soltos numa pasta que ela usa para outras coisas).
    $full = [System.IO.Path]::GetFullPath($Path.Trim().Trim('"'))
    if ((Split-Path $full -Leaf) -ne 'UniOver') { $full = Join-Path $full 'UniOver' }
    if ($full -ieq $anchor) { return $anchor }
    Test-InstallFolder $full
    return $full
}

function Select-InstallFolder {
    # A pergunta da primeira instalacao, numa janela do Windows (a unica alem do aviso de permissao). Cancelar ou fechar
    # usa a pasta padrao: ninguem fica preso aqui. O texto leva acentos por escape (este arquivo e so ASCII).
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $owner = New-Object System.Windows.Forms.Form
        $owner.TopMost = $true
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = [regex]::Unescape('Escolha onde o UniOver vai ficar guardado neste computador.\nSe tiver d\u00favida, s\u00f3 clique em OK: ele fica numa pasta pr\u00f3pria, dentro do seu usu\u00e1rio.')
        $dialog.SelectedPath = $anchor
        $dialog.ShowNewFolderButton = $true
        if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
            return $dialog.SelectedPath
        }
    }
    catch { }
    return $null
}

function Initialize-InstallFolder {
    # Primeira instalacao: usa -InstallDir ou pergunta onde guardar. Reinstalacao: mantem a pasta que ja existe (mudar de
    # pasta exige remover antes; mover um programa em uso e pareamento no meio de uma atualizacao nao vale o risco).
    New-Item -ItemType Directory -Path $anchor -Force | Out-Null
    if ($existingBase) {
        if ($InstallDir) { Write-InstallLog 'Ja existe uma instalacao: a pasta pedida foi ignorada e a atual foi mantida.' }
        return
    }
    $wanted = $InstallDir
    if (-not $wanted -and $automatic) { $wanted = Select-InstallFolder }
    if (-not $wanted) { return }
    $final = Resolve-InstallFolder $wanted
    if ($final -ne $anchor) {
        New-Item -ItemType Directory -Path $final -Force | Out-Null
        [System.IO.File]::WriteAllText($pointerFile, $final, [System.Text.UTF8Encoding]::new($false))
        Set-Layout $final
    }
}

function Get-BaseConfig {
    # O que o instalador grava no agent.toml: o endereco da API e o ramo de que o UniOver se atualiza (so main ou develop;
    # outro valor deixa o padrao do programa).
    $values = @{ api_url = $ApiUrl }
    if ($Ref -eq 'main' -or $Ref -eq 'develop') { $values['update_channel'] = $Ref }
    return $values
}

function Invoke-Prepare([string]$Uv) {
    # --frozen: instala exatamente o que o uv.lock diz, sem reescreve-lo nem reclamar se uma versao nova do uv o veria
    # diferente (o --locked faria o PC falhar por isso). A saida vai para o registro.
    $output = & $Uv sync --frozen --project $source 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        Write-InstallLog ('uv sync falhou (codigo ' + $LASTEXITCODE + '): ' + $output)
        throw 'Nao consegui preparar o UniOver neste computador. Confira a internet e tente de novo.'
    }
}

function Test-Candidate([string]$Uv, [string]$Candidate) {
    # Ensaio da versao nova ANTES da troca: o ambiente dela fica ao lado (app.new.venv, descartavel) e o programa que ja
    # funciona nao e tocado. Falhou: a instalacao atual segue como estava.
    $candidateEnvironment = $Candidate + '.venv'
    $saved = $env:UV_PROJECT_ENVIRONMENT
    try {
        Remove-Item -LiteralPath $candidateEnvironment -Recurse -Force -ErrorAction SilentlyContinue
        $env:UV_PROJECT_ENVIRONMENT = $candidateEnvironment
        $output = & $Uv sync --frozen --project $Candidate 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            Write-InstallLog ('uv sync da candidata falhou (codigo ' + $LASTEXITCODE + '): ' + $output)
            throw 'Nao consegui preparar a versao nova do UniOver. Confira a internet e tente de novo; a instalacao atual ficou como estava.'
        }
        $output = & $Uv run --no-sync --project $Candidate python -m uniover_agent.selfcheck 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            Write-InstallLog ('auto-diagnostico da candidata falhou: ' + $output)
            throw 'A versao baixada nao funciona neste computador. A instalacao atual ficou como estava; tente de novo mais tarde.'
        }
    }
    finally {
        $env:UV_PROJECT_ENVIRONMENT = $saved
        Remove-Item -LiteralPath $candidateEnvironment -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-SelfCheck([string]$Uv) {
    $output = & $Uv run --no-sync --project $source python -m uniover_agent.selfcheck 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        Write-InstallLog ('auto-diagnostico da versao falhou: ' + $output)
        throw 'A versao baixada nao funciona neste computador. A instalacao anterior, se havia, volta a funcionar; tente de novo mais tarde.'
    }
}

function Write-InstallDiagnosis([string]$Uv) {
    try {
        $output = & $Uv run --no-sync --project $source uniover-agent diagnose 2>&1 | Out-String
        Write-InstallLog ('Exame final da instalacao:' + [Environment]::NewLine + $output)
    }
    catch { }
}

function Invoke-AutomaticInstall {
    # Primeiro a pergunta da pasta: a pagina de andamento mora nela, e a janela aberta no navegador nao pode trocar de lugar.
    Initialize-InstallFolder
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
    $env:UNIOVER_HOME = $base
    # O ambiente Python fica FORA da pasta do agente e o uv roda com --project: assim a
    # auto-atualizacao consegue trocar a pasta do agente por renomeacao (pasta em uso nao troca).
    $env:UV_PROJECT_ENVIRONMENT = Join-Path $base 'runtime\venv'

    # A unica janela que aparece e o pedido de permissao do Windows, uma vez; depois disso nenhuma atualizacao pede.
    Write-Page 'Aceite o aviso de permiss&atilde;o do Windows (s&oacute; desta vez).'
    $system = Set-SystemSettings
    Write-Page 'Instalando o UniOver&hellip;'

    # A instalacao que existia, se havia, fica em app.previous (a troca e feita dentro de Get-AgentSource, so depois de o
    # pacote novo estar inteiro): se este processo cair, ainda ha para onde voltar.
    Backup-Environment
    Get-AgentSource $source { param($Candidate) Test-Candidate $uv $Candidate }
    Remove-Item -LiteralPath (Join-Path $base 'update-trial.txt') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $base 'runtime\update-trial.txt') -Force -ErrorAction SilentlyContinue
    Set-ConfigValues $config (Get-BaseConfig)

    Write-Host 'Preparando o UniOver (na primeira vez demora um pouco)...'
    Invoke-Prepare $uv

    # A versao instalada se examina antes de seguir: se ela nao carrega neste computador, para aqui com uma frase simples.
    Invoke-SelfCheck $uv

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
        Write-InstallLog "pair terminou com codigo $LASTEXITCODE"
        throw 'Este computador nao foi ligado a sua conta. Abra o conector de novo e aprove no app.'
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

    # Chegou aqui: versao nova instalada, ambiente preparado, pareamento feito. O ambiente guardado pode sair.
    Remove-EnvironmentBackup
    # Um exame final da instalacao fica no registro, para quem for ajudar saber como ela ficou.
    Write-InstallDiagnosis $uv

    $summary = @(
        'Pronto. O que foi feito:',
        "  - O UniOver foi instalado em $base e se atualiza sozinho.",
        "  - $system",
        $(if ($tvPaired) { '  - A TV foi encontrada e ligada ao UniOver.' } else { '  - A TV ainda nao esta ligada (abra o conector de novo com a TV ligada).' }),
        '  - Ele inicia sozinho quando voce entra no Windows, sem nenhuma janela.',
        ('  - O que ele faz e o que da errado fica anotado em ' + (Join-Path $base 'logs')),
        'Para desligar o UniOver, rode o comando abaixo (suas configuracoes ficam guardadas):',
        ('  powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm ' + $installerUrl + '))) -Uninstall"')
    )
    foreach ($line in $summary) { Write-Host $line; Write-InstallLog $line }

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
        # A frase para a pessoa e a da propria falha (todas as daqui sao simples); o detalhe tecnico vai para o registro.
        $reason = [System.Net.WebUtility]::HtmlEncode($_.Exception.Message)
        Write-Host ('Falha: ' + $_.Exception.Message)
        Write-InstallLog ('Falha: ' + $_.Exception.ToString())
        Restore-PreviousVersion
        Restore-RunningAgent
        Write-Page ('A instala&ccedil;&atilde;o n&atilde;o terminou: ' + $reason + ' Feche esta janela e abra o conector de novo. Se n&atilde;o resolver, avise quem te ajudou: os detalhes ficaram no arquivo instalacao.log, na pasta do UniOver.') $false
        exit 1
    }
}

# --- Modo manual (-TvHost informado), pensado para um terminal visivel ------------------------------
# Qualquer falha daqui para baixo religa antes o agente que ja estava instalado e so entao encerra com o erro.
trap { Restore-PreviousVersion; Restore-RunningAgent; break }
$uv = Find-Uv
Initialize-InstallFolder
New-Item -ItemType Directory -Path $base -Force | Out-Null
Stop-Agent
Move-LegacyLayout
Write-Readme
Write-StartMenuShortcut
$env:UNIOVER_CONFIG_FILE = $config
$env:UNIOVER_HOME = $base
$env:UV_PROJECT_ENVIRONMENT = Join-Path $base 'runtime\venv'

Backup-Environment
Get-AgentSource $source { param($Candidate) Test-Candidate $uv $Candidate }
Remove-Item -LiteralPath (Join-Path $base 'update-trial.txt') -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $base 'runtime\update-trial.txt') -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path (Split-Path $config -Parent) -Force | Out-Null
$configLines = @()
foreach ($entry in (Get-BaseConfig).GetEnumerator()) { $configLines += ($entry.Key + ' = ' + ($entry.Value | ConvertTo-Json -Compress)) }
Write-Config $config $configLines

Write-Host 'Preparando o UniOver...'
Invoke-Prepare $uv
Invoke-SelfCheck $uv

Write-Host 'Ligando este computador a sua conta'
Write-Host 'O proximo comando mostrara um codigo e um desenho (QR). Abra o app UniOver e aprove.'
& $uv --directory $source run uniover-agent pair
if ($LASTEXITCODE -ne 0) {
    throw 'Este computador nao foi ligado a sua conta.'
}

# O pareamento preserva chaves locais; trocamos so os campos da TV para nunca guardar token aqui.
Set-ConfigValues $config @{ tv_kind = $TvKind; tv_host = $TvHost }

if ($TvKind -eq 'samsung') {
    Write-Host 'Aceite o aviso Permitir na TV Samsung quando ele aparecer.'
}
& $uv --directory $source run uniover-agent tv-pair --kind $TvKind --host $TvHost
if ($LASTEXITCODE -ne 0) {
    throw 'A TV nao foi ligada ao UniOver.'
}

Remove-EnvironmentBackup
$answer = Read-Host 'Fazer o UniOver iniciar sozinho quando voce entrar no Windows? (s/N)'
if ($answer -match '^[sS]') {
    Write-AgentLauncher
    Register-AgentTask
    Start-ScheduledTask -TaskName $taskName
    Remove-EnvironmentBackup
    Write-InstallDiagnosis $uv
    Write-Host 'Pronto: o UniOver ja esta funcionando e vai iniciar sozinho.'
}
else {
    Write-Host 'Ele nao vai iniciar sozinho. Para iniciar agora: uv run uniover-agent run'
}
