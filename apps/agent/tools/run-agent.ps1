# Supervisor atualizado junto com app. Somente ASCII: Windows PowerShell 5.1 le sem BOM como ANSI.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
# A pasta fixa guarda o lancador e o ponteiro (location.txt) da pasta que a pessoa escolheu na instalacao; sem
# ponteiro valido, tudo fica na pasta fixa mesmo. O ponteiro e lido como UTF-8: o caminho pode ter acento.
$anchor = Join-Path $env:LOCALAPPDATA 'UniOver'
$base = $anchor
try {
    $chosen = ([System.IO.File]::ReadAllText((Join-Path $anchor 'location.txt'), [System.Text.Encoding]::UTF8) -split "`n")[0].Trim()
    if ($chosen -and [System.IO.Path]::IsPathRooted($chosen) -and (Test-Path -LiteralPath $chosen -PathType Container)) { $base = $chosen }
} catch { }
$source = Join-Path $base 'app'
$previous = Join-Path $base 'app.previous'
$runtime = Join-Path $base 'runtime'
$blocked = Join-Path $runtime '.blocked-versions'
$trial = Join-Path $runtime 'update-trial.txt'
$env:UNIOVER_HOME = $base
$env:UNIOVER_CONFIG_FILE = Join-Path $base 'config\agent.toml'
$env:UNIOVER_LOG_FILE = Join-Path $base 'logs\agent.log'
$env:UV_PROJECT_ENVIRONMENT = Join-Path $runtime 'venv'
$env:PYTHONUTF8 = '1'
# O agente sabe que tem um supervisor (o auto-reparo so pede reinicio a quem o atende).
$env:UNIOVER_SUPERVISED = '1'

function Get-WindowsStartupNames {
    # Os dois rotulos vivem no mesmo arquivo que o instalador e o agente Python leem.
    $names = @{ startup_app_name = 'UniOver'; scheduled_task_name = 'UniOver' }
    try {
        $file = Join-Path $source 'tools\windows-startup.json'
        $chosen = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        foreach ($key in @('startup_app_name', 'scheduled_task_name')) {
            $value = [string]$chosen.$key
            if ($value -and $value.Length -le 80 -and $value -notmatch '[\\/:*?"<>|\[\]''\x00-\x1F]' -and $value.Trim() -eq $value) {
                $names[$key] = $value
            }
        }
    } catch { }
    return $names
}

$startupNames = Get-WindowsStartupNames

function Find-Uv {
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

function Write-SupLog([string]$Level, [string]$Message) {
    # O que o supervisor viu e fez, em logs\supervisor.log (antes a saida dele ia para o nada). Arquivo proprio: o
    # rodizio do agent.log e do Python, e tres processos disputando o mesmo arquivo perdem linhas.
    try {
        $logs = Join-Path $base 'logs'
        New-Item -ItemType Directory -Path $logs -Force | Out-Null
        $file = Join-Path $logs 'supervisor.log'
        if ((Test-Path -LiteralPath $file) -and ((Get-Item -LiteralPath $file).Length -gt 524288)) {
            Move-Item -LiteralPath $file -Destination ($file + '.1') -Force
        }
        $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture)
        [System.IO.File]::AppendAllText($file, ($stamp + ' ' + $Level + ' supervisor: ' + $Message + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

$script:lastDiagnostic = @{}
function Add-Diagnostic([string]$Kind, [string]$Severity, [string]$Detail) {
    # Uma linha na fila de diagnostico (runtime\diagnostics.jsonl) que o agente envia a API quando conecta. O mesmo
    # aviso nao se repete em menos de 10 minutos: uma queda em laco nao enche a fila. So ASCII e sem caminhos.
    try {
        $key = $Kind + '|' + $Detail
        $now = Get-Date
        if ($script:lastDiagnostic.ContainsKey($key) -and (($now - $script:lastDiagnostic[$key]).TotalMinutes -lt 10)) { return }
        $script:lastDiagnostic[$key] = $now
        Add-Type -AssemblyName System.Web.Extensions
        $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
        $entry = @{ id = ([guid]::NewGuid().ToString()); at = (Get-UtcStamp $now); kind = $Kind; severity = $Severity; component = 'supervisor'; detail = $Detail.Substring(0, [Math]::Min($Detail.Length, 280)) }
        New-Item -ItemType Directory -Path $runtime -Force | Out-Null
        [System.IO.File]::AppendAllText((Join-Path $runtime 'diagnostics.jsonl'), ($serializer.Serialize($entry) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

function Set-StopReason([string]$Reason) {
    # Diz ao agente, na proxima subida, que a parada foi de proposito (e nao uma queda).
    try { [System.IO.File]::WriteAllText((Join-Path $runtime 'stop-reason.txt'), $Reason, [System.Text.Encoding]::ASCII) } catch { }
}

function Touch-Alive {
    # Sinal de vida do supervisor: o lancador e o auto-diagnostico do agente o conferem (se o supervisor travar, ninguem
    # reinicia o agente). Com o arquivo ja existente so a data muda: nao aloca bloco nenhum, entao vale mesmo com o disco
    # cheio (regravar o texto falharia justo quando o sinal mais importa).
    $path = Join-Path $runtime 'supervisor-alive'
    try {
        if (Test-Path -LiteralPath $path) { [System.IO.File]::SetLastWriteTimeUtc($path, [DateTime]::UtcNow); return }
    } catch { }
    try { [System.IO.File]::WriteAllText($path, (Get-Date).ToString('o'), [System.Text.Encoding]::ASCII) } catch { }
}

function Sleep-Beating([double]$Seconds) {
    # Nenhuma espera do supervisor passa de poucos segundos sem dar sinal de vida: quem o vigia (lancador e agente) nao
    # distingue "dormindo 5 minutos" de "travado".
    $end = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $end) {
        Touch-Alive
        $left = ($end - (Get-Date)).TotalMilliseconds
        Start-Sleep -Milliseconds ([int][Math]::Min(5000, [Math]::Max(50, $left)))
    }
}

function Get-FreeMegabytes {
    # Espaco livre do disco da instalacao em MB; nulo se nao der para saber (o chamador segue como se houvesse espaco).
    try {
        $root = [System.IO.Path]::GetPathRoot($base)
        if (-not $root) { return $null }
        return [int64]((New-Object System.IO.DriveInfo($root)).AvailableFreeSpace / 1MB)
    } catch { return $null }
}

function Test-LowDisk {
    $free = Get-FreeMegabytes
    return ($null -ne $free -and $free -lt $minFreeMb)
}

function Read-Shared([string]$Path) {
    # Le um arquivo que um processo filho ainda pode ter aberto para escrita (nunca falha por isso).
    try {
        $stream = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
        try { return (New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)).ReadToEnd() } finally { $stream.Dispose() }
    } catch { return '' }
}

function Invoke-Bounded([string]$File, [string]$Arguments, [double]$TimeoutSeconds) {
    # Roda um filho e espera NO MAXIMO $TimeoutSeconds, dando sinal de vida enquanto espera. Passado o prazo o filho e
    # toda a arvore dele morrem. A saida vai para arquivos (nunca pipe: um neto que herdasse a ponta do pipe prenderia a
    # espera). Devolve TimedOut, ExitCode (nulo se estourou o prazo) e o fim da saida.
    $stamp = [guid]::NewGuid().ToString('N')
    $outFile = Join-Path $runtime ('child-' + $stamp + '.out')
    $errFile = Join-Path $runtime ('child-' + $stamp + '.err')
    $result = @{ TimedOut = $false; ExitCode = $null; Output = '' }
    try {
        # O cmd.exe faz o redirecionamento para os arquivos (ProcessStartInfo so redireciona para pipe) e devolve o codigo
        # do filho; a arvore inteira (cmd e filho) morre junto no prazo.
        $line = '/d /s /c ""' + $File + '" ' + $Arguments + ' > "' + $outFile + '" 2> "' + $errFile + '""'
        $child = Start-Hidden ($env:ComSpec) $line
        # Sem tocar no Handle logo apos iniciar, o Windows PowerShell 5.1 devolve ExitCode nulo.
        $null = $child.Handle
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        while (-not $child.WaitForExit(2000)) {
            Touch-Alive
            if ((Get-Date) -ge $deadline) {
                $result.TimedOut = $true
                & taskkill.exe /PID $child.Id /T /F *> $null
                [void]$child.WaitForExit(10000)
                break
            }
        }
        if (-not $result.TimedOut) { $result.ExitCode = $child.ExitCode }
    } catch {
        $result.ExitCode = -1
        $result.Output = 'nao consegui iniciar o processo'
    } finally {
        $text = (Read-Shared $outFile) + "`n" + (Read-Shared $errFile)
        if ($text.Trim()) { $result.Output = $text }
        Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
    }
    return $result
}

function Remove-StaleChildOutputs {
    # Sobras de um filho que nao deu para apagar na hora (ou de um supervisor morto no meio): saem depois de uma hora.
    try {
        foreach ($filter in @('child-*', 'update-output-*')) {
            Get-ChildItem -LiteralPath $runtime -Filter $filter -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-1) } | Remove-Item -Force -ErrorAction SilentlyContinue
        }
    } catch { }
}

function Update-AnchorLauncher {
    # O lancador (pasta fixa) so era copiado na instalacao, entao uma correcao nele nunca chegava a quem ja tinha o UniOver.
    # Agora cada supervisor que sobe confere se a copia da pasta fixa e a do app e a troca por renomeacao se diferir. O
    # lancador em execucao nao e afetado (ja leu o arquivo); a copia nova vale na proxima vez que ele subir.
    $installed = Join-Path $anchor 'launcher.ps1'
    $temp = $installed + '.new'
    try {
        $fresh = Join-Path $source 'tools\launcher.ps1'
        if (-not (Test-Path -LiteralPath $fresh) -or -not (Test-Path -LiteralPath $installed)) { return }
        $wanted = [System.IO.File]::ReadAllBytes($fresh)
        $current = [System.IO.File]::ReadAllBytes($installed)
        if ([Convert]::ToBase64String($wanted) -eq [Convert]::ToBase64String($current)) { return }
        [System.IO.File]::WriteAllBytes($temp, $wanted)
        Move-Item -LiteralPath $temp -Destination $installed -Force
        Write-SupLog 'INFO' 'o lancador da pasta fixa foi atualizado para o do app'
    } catch { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
}

function Get-Tail([string]$Text) {
    # O fim de uma saida de erro, numa linha e sem quebras: o que vai para o registro do supervisor.
    if (-not $Text) { return '' }
    $line = (($Text -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -Last 3) -join ' | '
    return $line.Substring(0, [Math]::Min($line.Length, 300))
}

function Stop-VenvUsers {
    # Qualquer processo rodando do ambiente (icone da bandeja, agente que sobrou) prende o
    # uniover-agent.exe e faz o sync falhar para sempre. Antes de sincronizar, todos saem.
    $venvPath = Join-Path $runtime 'venv'
    Get-CimInstance Win32_Process -OperationTimeoutSec 30 -ErrorAction SilentlyContinue | Where-Object {
        ($_.ProcessId -ne $PID) -and (
            ($_.ExecutablePath -and $_.ExecutablePath -like "$venvPath\*") -or
            ($_.CommandLine -and $_.CommandLine -like "*uniover-agent*" -and $_.CommandLine -like "*$source*")
        )
    } | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F *> $null }
    # O icone tambem saiu, de proposito: nao e queda dele (o proximo Update-Tray o abre de novo).
    $script:tray = $null
}

function Get-RunDescription($Run, [double]$Seconds) {
    if ($Run.TimedOut) { return ('passou de ' + [int]$Seconds + ' s e foi interrompido') }
    return ('codigo ' + $Run.ExitCode)
}

function Sync-Agent([string]$Uv, [bool]$KeepEnvironment = $false) {
    Stop-VenvUsers
    # --frozen: o uv.lock manda (dependencia nova ou diferente da que a atualizacao ensaiou nunca entra sozinha), sem que
    # uma versao nova do uv que reescreveria o lock faca o sync falhar no PC. Com prazo: um uv preso nao prende o supervisor.
    $arguments = 'sync --frozen --project "' + $source + '" --quiet'
    $run = Invoke-Bounded $Uv $arguments $syncTimeoutSeconds
    if (-not $run.TimedOut -and $run.ExitCode -eq 0) { return $true }
    Write-SupLog 'WARNING' ('uv sync falhou (' + (Get-RunDescription $run $syncTimeoutSeconds) + '): ' + (Get-Tail $run.Output))
    # Com uma versao em prova e a anterior guardada para onde voltar, o ambiente nao e apagado: se a segunda tentativa
    # tambem falhasse, nenhuma das duas versoes teria como rodar. Quem chama conta a falha e reverte ao chegar a tres.
    if ($KeepEnvironment) {
        Add-Diagnostic 'update.sync_failed' 'error' 'nao consegui preparar o ambiente Python da versao em prova'
        return $false
    }
    $venv = Join-Path $runtime 'venv'
    # Disco quase cheio: refazer o ambiente (centenas de MB) so pioraria. O ambiente que existe e mantido e o agente sobe
    # com ele; sem ambiente nenhum nao ha o que subir e a volta seguinte tenta de novo quando houver espaco.
    if (Test-LowDisk) {
        Add-Diagnostic 'update.low_disk' 'error' 'pouco espaco em disco: o ambiente Python nao foi refeito'
        if (Test-Path -LiteralPath (Join-Path $venv 'Scripts\python.exe')) {
            Write-SupLog 'WARNING' 'pouco espaco em disco; mantenho o ambiente Python e subo o agente com ele'
            return $true
        }
        Write-SupLog 'WARNING' 'pouco espaco em disco e sem ambiente Python; espero haver espaco'
        return $false
    }
    if (Test-Path -LiteralPath $venv) { Remove-Item -LiteralPath $venv -Recurse -Force -ErrorAction SilentlyContinue }
    $run = Invoke-Bounded $Uv $arguments $syncTimeoutSeconds
    if ($run.TimedOut -or $run.ExitCode -ne 0) {
        Write-SupLog 'WARNING' ('uv sync falhou de novo depois de refazer o ambiente (' + (Get-RunDescription $run $syncTimeoutSeconds) + '): ' + (Get-Tail $run.Output))
        Add-Diagnostic 'update.sync_failed' 'error' 'nao consegui preparar o ambiente Python da versao instalada (a segunda tentativa tambem falhou)'
        return $false
    }
    Write-SupLog 'INFO' 'o ambiente Python foi refeito'
    return $true
}

function Schedule-NextUpdate([int]$Failures = 0) {
    # Normal: 10 a 12 minutos. O agente encontra novas versoes sozinho, sem depender do botao da bandeja.
    # Apos falhas, tenta em 3, 6, 12, 24 e no maximo 30 minutos; evita uma consulta em laco sem atrasar horas.
    if ($Failures -gt 0) {
        $minutes = [Math]::Min(3 * [Math]::Pow(2, [Math]::Min($Failures - 1, 4)), 30)
        $when = (Get-Date).AddMinutes($minutes).AddSeconds((Get-Random -Minimum 0 -Maximum 120))
    }
    else {
        $when = (Get-Date).AddMinutes(10).AddSeconds((Get-Random -Minimum 0 -Maximum 120))
    }
    Set-UpdateState @{ nextCheckAt = (Get-UtcStamp $when) } | Out-Null
    return $when
}

function Get-UpdateOutcome {
    try {
        Add-Type -AssemblyName System.Web.Extensions
        $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
        $state = $serializer.DeserializeObject([System.IO.File]::ReadAllText((Join-Path $runtime 'update-status.json')))
        return [string]$state['outcome']
    } catch { return '' }
}

$script:lowDiskNotedAt = [DateTime]::MinValue
function Invoke-Update([string]$Uv) {
    $before = Get-Version
    # O supervisor reabre logo apos a troca; uma versao em prova ainda nao deve iniciar outra checagem.
    if (Test-Path -LiteralPath $trial) {
        $trialParts = (Get-Content -LiteralPath $trial -ErrorAction SilentlyContinue) -split '\|', 2
        if ($trialParts.Count -eq 2 -and $trialParts[0] -eq $before) { return $false }
    }
    # Disco quase cheio: baixar e montar uma versao nova so piora (e nao ha espaco para o ambiente dela). Fica registrado
    # como falha com o motivo; a checagem volta pelo recuo normal e atualiza sozinha quando houver espaco.
    $free = Get-FreeMegabytes
    if ($null -ne $free -and $free -lt $minFreeMb) {
        Set-UpdateState @{ outcome = 'failed'; checkedAt = (Get-UtcStamp (Get-Date)); reason = ('pouco espaco em disco (' + $free + ' MB livres); a atualizacao espera ter espaco') } | Out-Null
        if ($null -eq $script:lowDiskNotedAt -or ((Get-Date) - $script:lowDiskNotedAt).TotalMinutes -ge 30) {
            $script:lowDiskNotedAt = Get-Date
            Write-SupLog 'WARNING' ('pouco espaco em disco (' + $free + ' MB livres); nao atualizo agora')
        }
        Add-Diagnostic 'update.low_disk' 'warn' ('pouco espaco em disco (' + $free + ' MB livres); a atualizacao foi adiada')
        return $false
    }
    $env:UV = $Uv
    Set-UpdateState @{ outcome = 'updating'; checkedAt = (Get-UtcStamp (Get-Date)); reason = $null } | Out-Null
    # O filho roda com prazo e a saida vai para arquivos (Invoke-Bounded): nem um uv preso nem um agente novo que herdasse a
    # ponta de um pipe prendem o supervisor. UV_NO_SYNC: o `uv run` nao re-sincroniza o ambiente do agente em execucao
    # (o sync e passo proprio, com prazo, deste supervisor; foi ele, dentro do `uv run`, que ficou preso sem filhos).
    $env:UV_NO_SYNC = '1'
    try { $run = Invoke-Bounded $Uv ('run --project "' + $source + '" uniover-agent self-update') $updateTimeoutSeconds }
    finally { Remove-Item -LiteralPath 'Env:UV_NO_SYNC' -ErrorAction SilentlyContinue }
    $exitCode = $run.ExitCode
    $output = $run.Output
    $after = Get-Version
    if ($run.TimedOut) {
        Write-SupLog 'ERROR' ('self-update passou de ' + [int]$updateTimeoutSeconds + ' s e foi interrompido: ' + (Get-Tail $output))
        Add-Diagnostic 'update.timed_out' 'error' ('o processo de atualizacao passou do prazo e foi interrompido')
        # Morto no meio da troca de pastas (app -> app.previous, app.new -> app), pode ter ficado sem `app`: sair faz o
        # lancador restaurar (aqui nao ha o que supervisionar).
        if (-not (Test-Path -LiteralPath $source)) {
            Write-SupLog 'ERROR' 'a pasta app sumiu no meio da troca; peco ao lancador que a restaure'
            Set-StopReason 'update'
            exit 42
        }
        if ($before -eq $after) {
            Set-UpdateState @{ outcome = 'failed'; checkedAt = (Get-UtcStamp (Get-Date)); reason = 'a atualizacao passou do prazo e foi interrompida' } | Out-Null
        }
    }
    elseif ($exitCode -ne 0 -and $before -eq $after) {
        Set-UpdateState @{ outcome = 'failed'; checkedAt = (Get-UtcStamp (Get-Date)); reason = ('o processo de atualizacao terminou com erro (codigo ' + $exitCode + ')') } | Out-Null
        Write-SupLog 'WARNING' ('self-update terminou com erro (codigo ' + $exitCode + '): ' + (Get-Tail $output))
        Add-Diagnostic 'update.failed' 'error' ('o processo de atualizacao terminou com erro (codigo ' + $exitCode + ')')
    }
    elseif ($before -and $after -and $before -ne $after) {
        Write-SupLog 'INFO' ('versao nova instalada, em prova: ' + $after.Substring(0, [Math]::Min(12, $after.Length)))
    }
    # O estado nunca fica em "atualizando" depois que o filho acabou: o Python nao conseguiu gravar o resultado (disco
    # cheio, morte no meio) e quem sabe o desfecho e este supervisor.
    if ((Get-UpdateOutcome) -eq 'updating') {
        if ($before -and $after -and $before -ne $after) {
            Set-UpdateState @{ outcome = 'updated'; checkedAt = (Get-UtcStamp (Get-Date)); latestSha = $after; reason = $null } | Out-Null
        }
        else {
            Set-UpdateState @{ outcome = 'failed'; checkedAt = (Get-UtcStamp (Get-Date)); reason = 'o processo de atualizacao terminou sem registrar o resultado' } | Out-Null
        }
    }
    if ($before -and $after -and $before -ne $after) {
        [System.IO.File]::WriteAllText($trial, ($after + '|0'), [System.Text.Encoding]::ASCII)
        return $true
    }
    return $false
}

function Move-Folder([string]$From, [string]$To) {
    # Renomeacao de verdade (Directory.Move): ou troca o nome inteiro ou falha sem tocar em nada. O Move-Item, quando ha um
    # arquivo aberto dentro da pasta, cai para copiar-e-apagar e deixa metade dos arquivos em cada lugar.
    [System.IO.Directory]::Move([System.IO.Path]::GetFullPath($From), [System.IO.Path]::GetFullPath($To))
}

function Note-Run([double]$Seconds) {
    if (-not (Test-Path -LiteralPath $trial)) { return }
    $parts = (Get-Content -LiteralPath $trial -ErrorAction SilentlyContinue) -split '\|', 2
    if ($parts.Count -ne 2 -or $parts[0] -ne (Get-Version)) { return }
    if ($Seconds -ge 600) { Remove-Item -LiteralPath $trial -Force -ErrorAction SilentlyContinue; return }
    $falls = 0
    [void][int]::TryParse($parts[1], [ref]$falls)
    $falls++
    Write-SupLog 'WARNING' ('a versao em prova caiu (' + $falls + ' de 3) depois de ' + [int]$Seconds + ' s')
    if ($falls -lt 3 -or -not (Test-Path -LiteralPath $previous)) {
        [System.IO.File]::WriteAllText($trial, ($parts[0] + '|' + $falls), [System.Text.Encoding]::ASCII)
        return
    }
    $bad = Join-Path $runtime ('app.rejected-' + $parts[0].Substring(0, 12))
    Remove-Item -LiteralPath $bad -Recurse -Force -ErrorAction SilentlyContinue
    try {
        Move-Folder $source $bad
        Move-Folder $previous $source
        if (-not (Select-String -LiteralPath $blocked -SimpleMatch $parts[0] -Quiet -ErrorAction SilentlyContinue)) {
            Add-Content -LiteralPath $blocked -Value $parts[0] -Encoding ASCII
        }
        Remove-Item -LiteralPath $trial -Force -ErrorAction SilentlyContinue
        Set-UpdateState @{ outcome = 'rolled_back'; rolledBack = $true; blockedSha = $parts[0]; checkedAt = (Get-UtcStamp (Get-Date)); reason = 'a versao nova caiu repetidamente; voltei para a anterior' } | Out-Null
        Write-SupLog 'ERROR' 'a versao nova caiu tres vezes seguidas; voltei para a anterior e bloqueei a nova'
        Add-Diagnostic 'update.rolled_back' 'error' 'a versao nova caiu tres vezes seguidas; voltou para a anterior'
    } catch { }
}

# Nenhum processo novo pode abrir (nem piscar) uma janela. Este script ja roda num console oculto, e os filhos
# chamados direto (`& $Uv ...`, `& taskkill.exe ...`) herdam esse console. Para o que precisa ficar vivo em paralelo
# usamos a classe Process com CreateNoWindow: o Start-Process cria um console novo e so depois o esconde (pisca).
function Start-Hidden([string]$File, [string]$Arguments) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $File
    $info.Arguments = $Arguments
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    return [System.Diagnostics.Process]::Start($info)
}

function Start-Tray([string]$Uv) {
    $arguments = 'run --project "' + $source + '" uniover-agent tray'
    return Start-Hidden $Uv $arguments
}

function Get-LogonTime {
    # Quando esta sessao do Windows comecou (o explorer.exe mais antigo dela). O teste pode fixar o instante por
    # UNIOVER_SUPERVISOR_LOGON_AT (UTC, ISO 8601); sem explorer (sessao sem area de trabalho) devolve nulo.
    try {
        $forced = [Environment]::GetEnvironmentVariable('UNIOVER_SUPERVISOR_LOGON_AT')
        if ($forced) { return [DateTime]::Parse($forced, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime() }
        $session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
        $first = Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session } | Sort-Object StartTime | Select-Object -First 1
        if ($first) { return $first.StartTime }
    } catch { }
    return $null
}

function Test-TrayClosed {
    # O "Sair" do icone deixa runtime\tray-closed e o icone nao deve voltar sozinho. O sinal vale ate o proximo logon:
    # se foi deixado antes de a sessao atual do Windows comecar, esta velho e e apagado. Uma atualizacao (que reinicia
    # este supervisor) nao apaga nada, entao quem fechou o icone nao o ve reaparecer a cada versao nova.
    $flag = Join-Path $runtime 'tray-closed'
    if (-not (Test-Path -LiteralPath $flag)) { return $false }
    try {
        $logon = Get-LogonTime
        if ($null -ne $logon -and (Get-Item -LiteralPath $flag).LastWriteTime -lt $logon) {
            Remove-Item -LiteralPath $flag -Force -ErrorAction SilentlyContinue
            return $false
        }
    } catch { }
    return $true
}

function Test-TrayRequested {
    # A entrada de Aplicativos de inicializacao pede somente o icone. Se a pessoa a desabilitou,
    # a tarefa ainda protege o agente, mas nao abre o icone no proximo logon.
    $request = Join-Path $runtime 'tray-start-request'
    if (-not (Test-Path -LiteralPath $request)) { return $false }
    try {
        $logon = Get-LogonTime
        if ($null -eq $logon -or (Get-Item -LiteralPath $request).LastWriteTime -lt $logon) { return $false }
    } catch { return $false }
    return $true
}

$script:trayStarted = $null
$script:trayFalls = 0
$script:trayRetryAt = [DateTime]::MinValue
function Update-Tray([string]$Uv) {
    # Mantem o icone de pe, menos quando a pessoa o fechou pelo "Sair". Um icone que cai logo ao abrir nao entra em laco:
    # a espera dobra (de 15 s ate 30 min) e a queda vira diagnostico para o dono.
    $current = $script:tray
    if ($null -ne $current -and -not $current.HasExited) { return }
    $now = Get-Date
    if ($null -ne $current) {
        $script:tray = $null
        $code = $null
        try { $code = $current.ExitCode } catch { }
        $lived = 9999
        if ($null -ne $script:trayStarted) { $lived = ($now - $script:trayStarted).TotalSeconds }
        if ($lived -ge 120) { $script:trayFalls = 0 }
        elseif (-not (Test-Path -LiteralPath (Join-Path $runtime 'tray-closed'))) {
            $script:trayFalls++
            $seconds = [Math]::Min(15 * [Math]::Pow(2, [Math]::Min($script:trayFalls, 7)), 1800)
            $script:trayRetryAt = $now.AddSeconds($seconds)
            if ($null -ne $code -and $code -ne 0) {
                Write-SupLog 'WARNING' ('o icone da bandeja caiu logo ao abrir (codigo ' + $code + ')')
                Add-Diagnostic 'tray.exited' 'error' ('o icone da bandeja caiu logo ao abrir (codigo ' + $code + ')')
            }
        }
    }
    if ((Test-TrayClosed) -or -not (Test-TrayRequested)) { return }
    if ($now -lt $script:trayRetryAt) { return }
    $script:trayStarted = $now
    $script:tray = Start-Tray $Uv
}

function Test-OwnerStalled {
    # O pulso (`last-alive`) do dono desta instalacao esta parado alem do limite da deteccao de travamento? Sem o arquivo
    # nada prova (um dono que nunca gravou pulso nao e julgado por ele). So vale na segunda vez que o mesmo carimbo
    # velho e visto: um PC que acordou agora ainda tem o carimbo antigo, mas o dono o regrava no minuto seguinte.
    try {
        $write = (Get-Item -LiteralPath (Join-Path $runtime 'last-alive') -ErrorAction Stop).LastWriteTimeUtc
    } catch { $script:ownerSeenStamp = $null; return $false }
    if (([DateTime]::UtcNow - $write).TotalSeconds -lt ($hangLaps * $lapSeconds)) { $script:ownerSeenStamp = $null; return $false }
    if ($script:ownerSeenStamp -eq $write) { return $true }
    $script:ownerSeenStamp = $write
    return $false
}

function Wait-Lap([double]$Seconds, [string]$Uv) {
    # A espera de uma volta, em fatias curtas: quem pede o icone de volta pelo atalho do menu Iniciar (que apaga o
    # tray-closed) nao espera os 15 s da volta.
    $end = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $end) {
        $left = ($end - (Get-Date)).TotalMilliseconds
        Start-Sleep -Milliseconds ([int][Math]::Min(1000, [Math]::Max(50, $left)))
        if ($null -eq $script:tray -or $script:tray.HasExited) { Update-Tray $Uv }
    }
}

function Move-StartupApproval([string]$OldFile, [string]$NewFile) {
    # O Windows guarda a escolha de desabilitar a inicializacao pelo nome do .lnk. Renomear
    # sem levar esse valor junto religaria o icone contra a escolha da pessoa.
    $key = $null
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(
            'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder', $true)
        if ($null -eq $key) { return $true }
        $old = $key.GetValue($OldFile, $null)
        if ($old -is [byte[]]) {
            $current = $key.GetValue($NewFile, $null)
            if ($current -isnot [byte[]] -or ($old.Length -gt 0 -and $old[0] -eq 3)) {
                $key.SetValue($NewFile, $old, [Microsoft.Win32.RegistryValueKind]::Binary)
            }
            $key.DeleteValue($OldFile, $false)
        }
        return $true
    } catch {
        Write-SupLog 'WARNING' 'nao consegui preservar a escolha de inicializacao ao renomear o atalho'
        return $false
    } finally { if ($null -ne $key) { $key.Dispose() } }
}

function Ensure-TrayShortcut {
    # O menu Iniciar traz o icone de volta depois do "Sair". A pasta Inicializar torna o mesmo
    # icone visivel em Aplicativos de inicializacao; a tarefa continua vigiando o agente. Os dois
    # caminhos passam pelo mutex do lancador. A atualizacao refaz os atalhos sem instalador/UAC.
    try {
        $script = Join-Path $source 'tools\tray-open.vbs'
        if (-not (Test-Path -LiteralPath $script)) { return }
        $name = [string]$startupNames.startup_app_name
        $taskName = [string]$startupNames.scheduled_task_name
        $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
        $startup = Join-Path $programs 'Startup'
        $wanted = '"' + $script + '"'
        $shell = New-Object -ComObject WScript.Shell
        $icon = Join-Path $source 'assets\tray\connected.ico'
        $startupReady = $false
        $startupCreated = $false
        foreach ($folder in @($programs, $startup)) {
            # Sem tarefa nao houve opcao de inicio automatico na instalacao manual.
            if ($folder -eq $startup -and -not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) -and
                -not (Get-ScheduledTask -TaskName 'UniOver agente' -ErrorAction SilentlyContinue)) { continue }
            New-Item -ItemType Directory -Path $folder -Force | Out-Null
            $path = Join-Path $folder ($name + '.lnk')
            if (Test-Path -LiteralPath $path) {
                $existing = $shell.CreateShortcut($path)
                if ($existing.Arguments -eq $wanted -and $existing.TargetPath -like '*wscript.exe') {
                    if ($folder -eq $startup) { $startupReady = $true }
                    continue
                }
            }
            $link = $shell.CreateShortcut($path)
            $link.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
            $link.Arguments = $wanted
            $link.WorkingDirectory = $base
            $link.Description = 'Mostrar o icone do UniOver na bandeja'
            if (Test-Path -LiteralPath $icon) { $link.IconLocation = $icon + ',0' }
            $link.Save()
            if ($folder -eq $startup) { $startupReady = $true; $startupCreated = $true }
        }
        $marker = Join-Path $runtime 'startup-label.txt'
        if (-not $startupReady) {
            Add-Diagnostic 'tray.startup_entry_missing' 'warn' 'nao consegui confirmar a entrada da bandeja em Aplicativos de inicializacao'
            # A bandeja continua nesta sessao e a proxima partida tenta criar o atalho de novo.
            [System.IO.File]::WriteAllText((Join-Path $runtime 'tray-start-request'), '', [System.Text.Encoding]::ASCII)
            return
        }
        $oldName = ''
        try { $oldName = [System.IO.File]::ReadAllText($marker, [System.Text.Encoding]::UTF8).Trim() } catch { }
        if (-not $oldName) { $oldName = 'UniOver Agente' }
        # Limpa todos os nomes anteriores conhecidos, inclusive uma primeira atualizacao sem marcador.
        # So um atalho para o NOSSO tray-open.vbs pode ser removido. No Startup, a preferencia
        # habilitado/desabilitado acompanha o nome novo antes de apagar o antigo.
        $oldNames = @($oldName, 'UniOver Agente', 'UniOver agente') | Select-Object -Unique
        foreach ($old in $oldNames) {
            if (-not $old -or $old -ieq $name -or $old -match '[\\/:*?"<>|]') { continue }
            foreach ($folder in @($programs, $startup)) {
                $oldPath = Join-Path $folder ($old + '.lnk')
                if (-not (Test-Path -LiteralPath $oldPath)) {
                    # Uma entrada antiga pode sobreviver no registro mesmo depois de o .lnk sumir.
                    if ($folder -eq $startup) { [void](Move-StartupApproval ($old + '.lnk') ($name + '.lnk')) }
                    continue
                }
                $oldLink = $shell.CreateShortcut($oldPath)
                if ($oldLink.TargetPath -like '*wscript.exe' -and $oldLink.Arguments -eq $wanted) {
                    if ($folder -eq $startup -and -not (Move-StartupApproval ($old + '.lnk') ($name + '.lnk'))) { continue }
                    Remove-Item -LiteralPath $oldPath -Force
                }
            }
        }
        if ($startupCreated -or -not (Test-Path -LiteralPath $marker)) {
            # Primeiro upgrade: o agente instalado ja tinha bandeja sem entrada Startup. Mostra o
            # icone agora; no proximo logon so o atalho habilitado fara o pedido da sessao.
            [System.IO.File]::WriteAllText((Join-Path $runtime 'tray-start-request'), '', [System.Text.Encoding]::ASCII)
        }
        [System.IO.File]::WriteAllText($marker, $name, [System.Text.Encoding]::UTF8)
        Write-SupLog 'INFO' 'atalhos da bandeja conferidos no menu Iniciar e em Aplicativos de inicializacao'
    } catch {
        Write-SupLog 'WARNING' 'nao consegui criar o atalho do icone da bandeja'
        Add-Diagnostic 'tray.shortcut_failed' 'warn' 'nao consegui criar o atalho do icone da bandeja no menu Iniciar'
    }
}

# Estado da atualizacao (runtime/update-status.json) e volta a versao anterior. Tudo isto e
# informativo ou pedido pelo dono: nada aqui pode derrubar o supervisor, entao nada levanta erro.
function Get-UtcStamp([DateTime]$Moment) {
    return $Moment.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [System.Globalization.CultureInfo]::InvariantCulture)
}

function Set-UpdateState([hashtable]$Changes) {
    try {
        $path = Join-Path $runtime 'update-status.json'
        Add-Type -AssemblyName System.Web.Extensions
        $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
        $state = @{}
        if (Test-Path -LiteralPath $path) {
            try {
                $old = $serializer.DeserializeObject([System.IO.File]::ReadAllText($path))
                foreach ($name in $old.Keys) { $state[$name] = $old[$name] }
            } catch { $state = @{} }
        }
        foreach ($key in @($Changes.Keys)) {
            if ($null -eq $Changes[$key]) { [void]$state.Remove($key) } else { $state[$key] = $Changes[$key] }
        }
        $temp = $path + '.tmp'
        [System.IO.File]::WriteAllText($temp, $serializer.Serialize($state), (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temp -Destination $path -Force
    } catch { }
}

function Test-FreshFlag([string]$Path) {
    # Um pedido esquecido (agente rodando sem supervisor) nao vale depois de 10 minutos.
    try { return ((Get-Item -LiteralPath $Path).LastWriteTimeUtc -gt [DateTime]::UtcNow.AddMinutes(-10)) }
    catch { return $false }
}

function Test-RollbackReady {
    # Ha uma versao em prova (update-trial.txt e da versao atual) E uma anterior inteira para onde voltar. So nesse caso
    # uma falha do sync leva a volta atras; versao estavel (sem prova) com ambiente estragado se conserta apagando o ambiente.
    try {
        if (-not (Test-Path -LiteralPath $trial)) { return $false }
        $parts = (Get-Content -LiteralPath $trial -ErrorAction SilentlyContinue) -split '\|', 2
        if ($parts.Count -ne 2 -or $parts[0] -ne (Get-Version)) { return $false }
        return ((Test-Path -LiteralPath (Join-Path $previous 'pyproject.toml')) -and (Test-Path -LiteralPath (Join-Path $previous 'tools\run-agent.ps1')))
    } catch { return $false }
}

function Confirm-Trial {
    # A versao em prova rodou 10 minutos seguidos com o pulso em dia: esta confirmada. Sem isto a prova so acabava
    # quando o agente parava, e uma versao que nunca cai ficava "em prova" para sempre (e a atualizacao seguinte
    # esperava, para nao apagar a ultima versao boa).
    try {
        if (-not (Test-Path -LiteralPath $trial)) { return }
        $parts = (Get-Content -LiteralPath $trial -ErrorAction SilentlyContinue) -split '\|', 2
        if ($parts.Count -ne 2 -or $parts[0] -ne (Get-Version)) { return }
        Remove-Item -LiteralPath $trial -Force -ErrorAction SilentlyContinue
        Set-UpdateState @{ outcome = 'updated'; checkedAt = (Get-UtcStamp (Get-Date)); reason = $null; rolledBack = $null; blockedSha = $null } | Out-Null
        Write-SupLog 'INFO' ('a versao nova se confirmou: 10 minutos estavel (' + $parts[0].Substring(0, [Math]::Min(12, $parts[0].Length)) + ')')
        Add-Diagnostic 'update.confirmed' 'info' 'a versao nova se confirmou depois de 10 minutos estavel'
    } catch { }
}

function Invoke-Rollback([string]$Reason = 'voltei para a versao anterior a pedido do administrador') {
    # Volta para `app.previous` (a versao que a ultima atualizacao guardou) e bloqueia a que sai.
    try {
        if (-not (Test-Path -LiteralPath $previous)) { return $false }
        $bad = Get-Version
        $tag = 'manual'
        if ($bad -and $bad.Length -ge 12) { $tag = $bad.Substring(0, 12) }
        $rejected = Join-Path $runtime ('app.rejected-' + $tag)
        Remove-Item -LiteralPath $rejected -Recurse -Force -ErrorAction SilentlyContinue
        Move-Folder $source $rejected
        try { Move-Folder $previous $source }
        catch {
            try { Move-Folder $rejected $source } catch { }
            throw
        }
        if ($bad -and -not (Select-String -LiteralPath $blocked -SimpleMatch $bad -Quiet -ErrorAction SilentlyContinue)) {
            Add-Content -LiteralPath $blocked -Value $bad -Encoding ASCII
        }
        Remove-Item -LiteralPath $trial -Force -ErrorAction SilentlyContinue
        Set-UpdateState @{ outcome = 'rolled_back'; rolledBack = $true; blockedSha = $bad; checkedAt = (Get-UtcStamp (Get-Date)); reason = $Reason } | Out-Null
        Write-SupLog 'WARNING' ('voltei para a versao anterior: ' + $Reason)
        Add-Diagnostic 'update.rolled_back' 'warn' $Reason
        return $true
    } catch {
        Set-UpdateState @{ outcome = 'failed'; checkedAt = (Get-UtcStamp (Get-Date)); reason = 'nao consegui voltar para a versao anterior' } | Out-Null
        Write-SupLog 'ERROR' 'nao consegui voltar para a versao anterior'
        Add-Diagnostic 'update.rollback_failed' 'error' 'nao consegui voltar para a versao anterior'
        return $false
    }
}

# Os tempos do pulso e da confirmacao da versao em prova (os testes os encurtam por estas variaveis; sem elas valem os de producao).
function Get-Setting([string]$Name, [double]$Default) {
    $value = 0.0
    if ([double]::TryParse([string][Environment]::GetEnvironmentVariable($Name), [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$value) -and $value -gt 0) { return $value }
    return $Default
}
$lapSeconds = Get-Setting 'UNIOVER_SUPERVISOR_LAP_SECONDS' 15
$hangLaps = [int](Get-Setting 'UNIOVER_SUPERVISOR_HANG_LAPS' 20)
$hangGraceSeconds = Get-Setting 'UNIOVER_SUPERVISOR_HANG_GRACE_SECONDS' 240
$confirmAfterSeconds = Get-Setting 'UNIOVER_SUPERVISOR_CONFIRM_SECONDS' 600
$slowLapSeconds = [Math]::Max(60, $lapSeconds * 4)
# Saida do agente que encontrou outro dono da instalacao (EXIT_ALREADY_RUNNING, em single_instance.py).
$ownedElsewhereCode = 5
$ownedElsewhereWait = Get-Setting 'UNIOVER_SUPERVISOR_OWNED_WAIT_SECONDS' 60
# Prazos de tudo que o supervisor espera: nada abaixo roda sem fim. O teto do self-update (2400 s) tem de passar da soma dos
# limites internos dele (consulta, download, extracao, duas tentativas de uv sync, auto-diagnostico: 1863 s em
# self_update.WORST_CASE_SECONDS, com folga), para nunca matar uma atualizacao lenta mas legitima, e de acabar antes de o
# agente dar a atualizacao por interrompida (50 min). Um teste confere as duas desigualdades.
$updateTimeoutSeconds = Get-Setting 'UNIOVER_SUPERVISOR_UPDATE_TIMEOUT_SECONDS' 2400
$syncTimeoutSeconds = Get-Setting 'UNIOVER_SUPERVISOR_SYNC_TIMEOUT_SECONDS' 900
# Abaixo disto de espaco livre (MB) nenhuma atualizacao comeca e o ambiente Python nunca e apagado.
$minFreeMb = Get-Setting 'UNIOVER_SUPERVISOR_MIN_FREE_MB' 600

New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Set-Location -LiteralPath $base
Write-SupLog 'INFO' 'supervisor iniciado'
Touch-Alive
Remove-StaleChildOutputs
Update-AnchorLauncher
Ensure-TrayShortcut
Touch-Alive
$wait = 5
$syncFalls = 0
$script:ownedElsewhere = $false
$script:ownerSeenStamp = $null
$script:ownerReported = $null
$updateFailures = 0
$nextUpdate = [DateTime]::MinValue
$tray = $null
while ($true) {
    Touch-Alive
    $uv = Find-Uv
    if (-not $uv -or -not (Test-Path -LiteralPath $source)) {
        Write-SupLog 'WARNING' 'sem uv ou sem a pasta do agente; espero 5 minutos'
        Sleep-Beating 300; continue
    }
    $updated = $false
    if ((Get-Date) -ge $nextUpdate -or (Test-Path (Join-Path $runtime 'update-now'))) {
        Remove-Item -LiteralPath (Join-Path $runtime 'update-now') -Force -ErrorAction SilentlyContinue
        $updated = Invoke-Update $uv
        $updateFailures = if ((Get-UpdateOutcome) -eq 'failed') { $updateFailures + 1 } else { 0 }
        $nextUpdate = Schedule-NextUpdate $updateFailures
        if ($updated) {
            Set-StopReason 'update'
            if ($null -ne $tray -and -not $tray.HasExited) { & taskkill.exe /PID $tray.Id /T /F *> $null }
            exit 42
        }
    }
    $rollbackReady = Test-RollbackReady
    # Com outro dono da instalacao (codigo 5) o ambiente acabou de ser preparado e o sync (que antes encerra quem usa o
    # ambiente) nao roda a cada tentativa: so mataria o dono que esta vivo e bem.
    if (-not $script:ownedElsewhere -and -not (Sync-Agent $uv $rollbackReady)) {
        # Versao em prova que nao consegue preparar o proprio ambiente nunca chegaria a rodar, nem a cair: sem esta conta o
        # laco esperaria para sempre. Na terceira falha seguida volta para a anterior, pela mesma rotina do pedido do dono.
        if ($rollbackReady) {
            $syncFalls++
            if ($syncFalls -ge 3) {
                if ($null -ne $tray -and -not $tray.HasExited) { & taskkill.exe /PID $tray.Id /T /F *> $null }
                if (Invoke-Rollback 'a versao nova nao conseguiu preparar o ambiente (3 falhas seguidas); voltei para a anterior') {
                    Set-StopReason 'rollback'
                    exit 42
                }
            }
        }
        else { $syncFalls = 0 }
        Sleep-Beating $wait; $wait = [Math]::Min($wait * 2, 300); continue
    }
    $syncFalls = 0
    # O icone sobe depois do sync: antes, ele prenderia o executavel que o sync troca.
    Update-Tray $uv
    $arguments = 'run --project "' + $source + '" uniover-agent run'
    $process = Start-Hidden $uv $arguments
    $started = Get-Date
    Write-SupLog 'INFO' ('agente iniciado (pid ' + $process.Id + ')')
    $restartForUpdate = $false
    $hung = $false
    # O pulso do agente e o `last-alive`, que ele regrava a cada minuto de dentro do laco de eventos: se o laco trava
    # (conexao aberta, processo vivo, mas parado) o arquivo para de mudar. O supervisor so conta voltas dele
    # proprio (a cada 15 s) em que o arquivo nao mudou; uma volta que demorou muito (PC suspenso, atualizacao) zera a conta.
    $alivePath = Join-Path $runtime 'last-alive'
    $lastWrite = $null
    $silent = 0
    $previousLap = Get-Date
    while (-not $process.HasExited) {
        Wait-Lap $lapSeconds $uv
        Touch-Alive
        $lap = Get-Date
        $slow = (($lap - $previousLap).TotalSeconds -gt $slowLapSeconds)
        $previousLap = $lap
        $write = $null
        try { $write = (Get-Item -LiteralPath $alivePath).LastWriteTimeUtc } catch { }
        if ($slow -or $null -eq $write -or $write -ne $lastWrite) { $silent = 0; $lastWrite = $write } else { $silent++ }
        if (($lap - $started).TotalSeconds -ge $hangGraceSeconds -and $silent -ge $hangLaps) {
            Write-SupLog 'ERROR' ('o agente esta vivo (pid ' + $process.Id + ') mas mudo ha cerca de 5 minutos; vou reinicia-lo')
            Add-Diagnostic 'process.unresponsive' 'error' 'o agente parou de dar sinal de vida por 5 minutos e foi reiniciado'
            Set-StopReason 'unresponsive'
            & taskkill.exe /PID $process.Id /T /F *> $null
            $hung = $true
            break
        }
        if (Test-Path -LiteralPath $trial) {
            if (($lap - $started).TotalSeconds -ge $confirmAfterSeconds -and $silent -lt 6 -and $null -ne $write) { Confirm-Trial }
        }
        if (Test-Path (Join-Path $runtime 'restart-now')) {
            Remove-Item -LiteralPath (Join-Path $runtime 'restart-now') -Force -ErrorAction SilentlyContinue
            Write-SupLog 'INFO' 'reinicio pedido; reinicio o agente'
            Set-StopReason 'restart'
            & taskkill.exe /PID $process.Id /T /F *> $null
            $restartForUpdate = $true
        }
        $rollbackFlag = Join-Path $runtime 'rollback-now'
        if (Test-Path -LiteralPath $rollbackFlag) {
            $fresh = Test-FreshFlag $rollbackFlag
            Remove-Item -LiteralPath $rollbackFlag -Force -ErrorAction SilentlyContinue
            if ($fresh -and (Test-Path -LiteralPath $previous)) {
                Set-StopReason 'rollback'
                & taskkill.exe /PID $process.Id /T /F *> $null
                if ($null -ne $tray -and -not $tray.HasExited) { & taskkill.exe /PID $tray.Id /T /F *> $null }
                if (Get-Command Stop-VenvUsers -ErrorAction SilentlyContinue) { Stop-VenvUsers }
                $restartForUpdate = $true
                if (Invoke-Rollback) { exit 42 }
            }
        }
        if ((Get-Date) -ge $nextUpdate -or (Test-Path (Join-Path $runtime 'update-now'))) {
            Remove-Item -LiteralPath (Join-Path $runtime 'update-now') -Force -ErrorAction SilentlyContinue
            if (Invoke-Update $uv) {
                Set-StopReason 'update'
                & taskkill.exe /PID $process.Id /T /F *> $null
                $restartForUpdate = $true
                if ($null -ne $tray -and -not $tray.HasExited) { & taskkill.exe /PID $tray.Id /T /F *> $null }
                exit 42
            }
            $updateFailures = if ((Get-UpdateOutcome) -eq 'failed') { $updateFailures + 1 } else { 0 }
            $nextUpdate = Schedule-NextUpdate $updateFailures
        }
        Update-Tray $uv
    }
    $seconds = ((Get-Date) - $started).TotalSeconds
    $code = $null
    try { $code = $process.ExitCode } catch { }
    # Codigo 5: outro agente ja e dono desta instalacao (uma execucao manual aberta, um processo antigo que sobreviveu).
    # Nao e queda: nao conta contra a versao em prova, nao entra na fila de diagnostico e a espera e fixa e calma.
    if (-not $restartForUpdate -and -not $hung -and $code -eq $ownedElsewhereCode) {
        $script:ownedElsewhere = $true
        Write-SupLog 'INFO' 'outro agente ja roda nesta instalacao; espero antes de tentar de novo'
        # Os pedidos do dono (reiniciar, voltar a versao) nao podem ficar esperando um agente nosso: valem agora.
        $restartFlag = Join-Path $runtime 'restart-now'
        if (Test-Path -LiteralPath $restartFlag) {
            Remove-Item -LiteralPath $restartFlag -Force -ErrorAction SilentlyContinue
            Write-SupLog 'INFO' 'reinicio pedido; encerro o outro agente desta instalacao'
            Set-StopReason 'restart'
            Stop-VenvUsers
            $script:ownedElsewhere = $false
            continue
        }
        $rollbackFlag = Join-Path $runtime 'rollback-now'
        if (Test-Path -LiteralPath $rollbackFlag) {
            $fresh = Test-FreshFlag $rollbackFlag
            Remove-Item -LiteralPath $rollbackFlag -Force -ErrorAction SilentlyContinue
            if ($fresh -and (Test-Path -LiteralPath $previous)) {
                Set-StopReason 'rollback'
                if ($null -ne $tray -and -not $tray.HasExited) { & taskkill.exe /PID $tray.Id /T /F *> $null }
                Stop-VenvUsers
                $script:ownedElsewhere = $false
                if (Invoke-Rollback) { exit 42 }
                continue
            }
        }
        # O dono pode ser um processo travado que sobrou de um supervisor morto: ele segura a trava para sempre e ninguem
        # mais olharia o pulso dele. Pulso parado nas duas ultimas tentativas (a segunda ve o mesmo carimbo parado da
        # primeira, o que descarta um PC que acabou de acordar) e o dono e encerrado; pulso em dia, ele e deixado em paz.
        if (Test-OwnerStalled) {
            # Um dono que o supervisor nao consegue encerrar (por exemplo, rodando como administrador) voltaria a cada volta:
            # o aviso e o diagnostico saem uma vez por dono. O carimbo do pulso parado o identifica (o dono travado nao o muda,
            # e outro dono grava um novo); os numeros dos processos do ambiente incluiriam o icone, que sobe de novo a cada volta.
            $ownerKey = [string]$script:ownerSeenStamp.Ticks
            if ($ownerKey -ne $script:ownerReported) {
                $script:ownerReported = $ownerKey
                Write-SupLog 'ERROR' 'o outro agente desta instalacao esta mudo ha mais de 5 minutos; vou encerra-lo'
                Add-Diagnostic 'process.unresponsive' 'error' 'o agente que segurava a instalacao parou de dar sinal de vida e foi encerrado'
            }
            Set-StopReason 'unresponsive'
            Stop-VenvUsers
            $script:ownedElsewhere = $false
            $script:ownerSeenStamp = $null
            continue
        }
        Start-Sleep -Seconds $ownedElsewhereWait
        continue
    }
    $script:ownedElsewhere = $false
    $script:ownerReported = $null
    if (-not $restartForUpdate) {
        Write-SupLog 'WARNING' ('o agente terminou (codigo ' + $code + ') depois de ' + [int]$seconds + ' s')
        if (-not $hung) {
            Add-Diagnostic 'process.exited' 'warn' ('o agente terminou sozinho (codigo ' + $code + ') depois de ' + [int]$seconds + ' segundos')
        }
        Note-Run $seconds
    }
    if ($seconds -gt 600 -or $restartForUpdate) { $wait = 5 }
    Sleep-Beating $wait
    $wait = [Math]::Min($wait * 2, 300)
}
