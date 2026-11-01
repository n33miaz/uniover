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
    # Sinal de vida do supervisor: o auto-diagnostico do agente o confere (se o supervisor morrer, ninguem reinicia o
    # agente). Escrever um arquivo pequeno a cada volta custa quase nada.
    try { [System.IO.File]::WriteAllText((Join-Path $runtime 'supervisor-alive'), (Get-Date).ToString('o'), [System.Text.Encoding]::ASCII) } catch { }
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
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        ($_.ProcessId -ne $PID) -and (
            ($_.ExecutablePath -and $_.ExecutablePath -like "$venvPath\*") -or
            ($_.CommandLine -and $_.CommandLine -like "*uniover-agent*" -and $_.CommandLine -like "*$source*")
        )
    } | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F *> $null }
}

function Sync-Agent([string]$Uv, [bool]$KeepEnvironment = $false) {
    Stop-VenvUsers
    # --frozen: o uv.lock manda (dependencia nova ou diferente da que a atualizacao ensaiou nunca entra sozinha), sem que
    # uma versao nova do uv que reescreveria o lock faca o sync falhar no PC.
    $output = & $Uv sync --frozen --project $source --quiet 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0) { return $true }
    Write-SupLog 'WARNING' ('uv sync falhou (codigo ' + $LASTEXITCODE + '): ' + (Get-Tail $output))
    # Com uma versao em prova e a anterior guardada para onde voltar, o ambiente nao e apagado: se a segunda tentativa
    # tambem falhasse, nenhuma das duas versoes teria como rodar. Quem chama conta a falha e reverte ao chegar a tres.
    if ($KeepEnvironment) { return $false }
    $venv = Join-Path $runtime 'venv'
    if (Test-Path -LiteralPath $venv) { Remove-Item -LiteralPath $venv -Recurse -Force -ErrorAction SilentlyContinue }
    $output = & $Uv sync --frozen --project $source --quiet 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        Write-SupLog 'WARNING' ('uv sync falhou de novo depois de refazer o ambiente (codigo ' + $LASTEXITCODE + '): ' + (Get-Tail $output))
        return $false
    }
    Write-SupLog 'INFO' 'o ambiente Python foi refeito'
    return $true
}

function Schedule-NextUpdate([int]$Failures = 0) {
    # Normal: de 6 a 6h45 depois. Depois de uma atualizacao que falhou, tenta de novo bem antes (30 min, 1 h, 2 h...,
    # no maximo as 6 h normais): uma queda de rede de um minuto nao pode custar 6 h sem atualizacao.
    if ($Failures -gt 0) {
        $minutes = [Math]::Min(30 * [Math]::Pow(2, [Math]::Min($Failures - 1, 4)), 360)
        $when = (Get-Date).AddMinutes($minutes).AddSeconds((Get-Random -Minimum 0 -Maximum 120))
    }
    else {
        $when = (Get-Date).AddHours(6).AddMinutes((Get-Random -Minimum 0 -Maximum 46))
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

function Invoke-Update([string]$Uv) {
    $before = Get-Version
    $env:UV = $Uv
    Set-UpdateState @{ outcome = 'updating'; checkedAt = (Get-UtcStamp (Get-Date)); reason = $null } | Out-Null
    $output = & $Uv run --project $source uniover-agent self-update 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    $after = Get-Version
    if ($exitCode -ne 0 -and $before -eq $after) {
        Set-UpdateState @{ outcome = 'failed'; checkedAt = (Get-UtcStamp (Get-Date)); reason = ('o processo de atualizacao terminou com erro (codigo ' + $exitCode + ')') } | Out-Null
        Write-SupLog 'WARNING' ('self-update terminou com erro (codigo ' + $exitCode + '): ' + (Get-Tail $output))
    }
    elseif ($before -and $after -and $before -ne $after) {
        Write-SupLog 'INFO' ('versao nova instalada, em prova: ' + $after.Substring(0, [Math]::Min(12, $after.Length)))
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

New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Set-Location -LiteralPath $base
Write-SupLog 'INFO' 'supervisor iniciado'
$wait = 5
$syncFalls = 0
$updateFailures = 0
$nextUpdate = [DateTime]::MinValue
$tray = $null
while ($true) {
    Touch-Alive
    $uv = Find-Uv
    if (-not $uv -or -not (Test-Path -LiteralPath $source)) {
        Write-SupLog 'WARNING' 'sem uv ou sem a pasta do agente; espero 5 minutos'
        Start-Sleep -Seconds 300; continue
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
    if (-not (Sync-Agent $uv $rollbackReady)) {
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
        Start-Sleep -Seconds $wait; $wait = [Math]::Min($wait * 2, 300); continue
    }
    $syncFalls = 0
    # O icone sobe depois do sync: antes, ele prenderia o executavel que o sync troca.
    if ($null -eq $tray -or $tray.HasExited) { $tray = Start-Tray $uv }
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
        Start-Sleep -Milliseconds ([int]($lapSeconds * 1000))
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
        if ($null -ne $tray -and $tray.HasExited) { $tray = Start-Tray $uv }
    }
    $seconds = ((Get-Date) - $started).TotalSeconds
    $code = $null
    try { $code = $process.ExitCode } catch { }
    if (-not $restartForUpdate) {
        Write-SupLog 'WARNING' ('o agente terminou (codigo ' + $code + ') depois de ' + [int]$seconds + ' s')
        if (-not $hung) {
            Add-Diagnostic 'process.exited' 'warn' ('o agente terminou sozinho (codigo ' + $code + ') depois de ' + [int]$seconds + ' segundos')
        }
        Note-Run $seconds
    }
    if ($seconds -gt 600 -or $restartForUpdate) { $wait = 5 }
    Start-Sleep -Seconds $wait
    $wait = [Math]::Min($wait * 2, 300)
}
