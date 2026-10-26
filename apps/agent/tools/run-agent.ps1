# Supervisor atualizado junto com app. Somente ASCII: Windows PowerShell 5.1 le sem BOM como ANSI.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$base = Join-Path $env:LOCALAPPDATA 'UniOver'
$source = Join-Path $base 'app'
$previous = Join-Path $base 'app.previous'
$runtime = Join-Path $base 'runtime'
$blocked = Join-Path $runtime '.blocked-versions'
$trial = Join-Path $runtime 'update-trial.txt'
$env:UNIOVER_CONFIG_FILE = Join-Path $base 'config\agent.toml'
$env:UNIOVER_LOG_FILE = Join-Path $base 'logs\agent.log'
$env:UV_PROJECT_ENVIRONMENT = Join-Path $runtime 'venv'
$env:PYTHONUTF8 = '1'

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
    & $Uv sync --project $source --quiet *> $null
    if ($LASTEXITCODE -eq 0) { return $true }
    # Com uma versao em prova e a anterior guardada para onde voltar, o ambiente nao e apagado: se a segunda tentativa
    # tambem falhasse, nenhuma das duas versoes teria como rodar. Quem chama conta a falha e reverte ao chegar a tres.
    if ($KeepEnvironment) { return $false }
    $venv = Join-Path $runtime 'venv'
    if (Test-Path -LiteralPath $venv) { Remove-Item -LiteralPath $venv -Recurse -Force -ErrorAction SilentlyContinue }
    & $Uv sync --project $source --quiet *> $null
    return ($LASTEXITCODE -eq 0)
}

function Schedule-NextUpdate {
    $when = (Get-Date).AddHours(6).AddMinutes((Get-Random -Minimum 0 -Maximum 46))
    Set-UpdateState @{ nextCheckAt = (Get-UtcStamp $when) } | Out-Null
    return $when
}

function Invoke-Update([string]$Uv) {
    $before = Get-Version
    $env:UV = $Uv
    Set-UpdateState @{ outcome = 'updating'; checkedAt = (Get-UtcStamp (Get-Date)); reason = $null } | Out-Null
    & $Uv run --project $source uniover-agent self-update *> $null
    $exitCode = $LASTEXITCODE
    $after = Get-Version
    if ($exitCode -ne 0 -and $before -eq $after) {
        Set-UpdateState @{ outcome = 'failed'; checkedAt = (Get-UtcStamp (Get-Date)); reason = ('o processo de atualizacao terminou com erro (codigo ' + $exitCode + ')') } | Out-Null
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
        return $true
    } catch {
        Set-UpdateState @{ outcome = 'failed'; checkedAt = (Get-UtcStamp (Get-Date)); reason = 'nao consegui voltar para a versao anterior' } | Out-Null
        return $false
    }
}

New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Set-Location -LiteralPath $base
$wait = 5
$syncFalls = 0
$nextUpdate = [DateTime]::MinValue
$tray = $null
while ($true) {
    $uv = Find-Uv
    if (-not $uv -or -not (Test-Path -LiteralPath $source)) { Start-Sleep -Seconds 300; continue }
    $updated = $false
    if ((Get-Date) -ge $nextUpdate -or (Test-Path (Join-Path $runtime 'update-now'))) {
        Remove-Item -LiteralPath (Join-Path $runtime 'update-now') -Force -ErrorAction SilentlyContinue
        $updated = Invoke-Update $uv
        $nextUpdate = Schedule-NextUpdate
        if ($updated) {
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
    $restartForUpdate = $false
    while (-not $process.HasExited) {
        Start-Sleep -Seconds 15
        if (Test-Path (Join-Path $runtime 'restart-now')) {
            Remove-Item -LiteralPath (Join-Path $runtime 'restart-now') -Force -ErrorAction SilentlyContinue
            & taskkill.exe /PID $process.Id /T /F *> $null
            $restartForUpdate = $true
        }
        $rollbackFlag = Join-Path $runtime 'rollback-now'
        if (Test-Path -LiteralPath $rollbackFlag) {
            $fresh = Test-FreshFlag $rollbackFlag
            Remove-Item -LiteralPath $rollbackFlag -Force -ErrorAction SilentlyContinue
            if ($fresh -and (Test-Path -LiteralPath $previous)) {
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
                & taskkill.exe /PID $process.Id /T /F *> $null
                $restartForUpdate = $true
                if ($null -ne $tray -and -not $tray.HasExited) { & taskkill.exe /PID $tray.Id /T /F *> $null }
                exit 42
            }
            $nextUpdate = Schedule-NextUpdate
        }
        if ($null -ne $tray -and $tray.HasExited) { $tray = Start-Tray $uv }
    }
    $seconds = ((Get-Date) - $started).TotalSeconds
    if (-not $restartForUpdate) { Note-Run $seconds }
    if ($seconds -gt 600 -or $restartForUpdate) { $wait = 5 }
    Start-Sleep -Seconds $wait
    $wait = [Math]::Min($wait * 2, 300)
}
