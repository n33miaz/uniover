# Lancador estavel. Somente ASCII e compativel com Windows PowerShell 5.1.
# Quem o abre e o launcher.vbs (WScript, sem console), que cria este PowerShell ja oculto. Os filhos abaixo sao chamados
# direto, sem Start-Process: herdam o console oculto em vez de criar um novo, entao nada pisca na tela.
$ErrorActionPreference = 'Continue'
# A pasta fixa (onde este lancador e o launcher.vbs ficam, e onde a tarefa agendada os procura) guarda o ponteiro
# location.txt da pasta que a pessoa escolheu na instalacao. Sem ponteiro valido, os dados ficam na pasta fixa.
# O ponteiro e lido como UTF-8 (o caminho pode ter acento); nunca vai para o .vbs, que le em ANSI.
$anchor = Join-Path $env:LOCALAPPDATA 'UniOver'
$base = $anchor
try {
    $chosen = ([System.IO.File]::ReadAllText((Join-Path $anchor 'location.txt'), [System.Text.Encoding]::UTF8) -split "`n")[0].Trim()
    if ($chosen -and [System.IO.Path]::IsPathRooted($chosen) -and (Test-Path -LiteralPath $chosen -PathType Container)) { $base = $chosen }
} catch { }
$current = Join-Path $base 'app\tools\run-agent.ps1'
$legacy = Join-Path $base 'agent-src\tools\run-agent.ps1'
$fallback = Join-Path $base 'run-agent.fallback.ps1'

# Um lancador so: a tarefa e a migracao podem tentar subir outro ao mesmo tempo.
$created = $false
# O nome inclui a pasta: outra instalacao (ou um teste numa pasta temporaria) nao disputa o mesmo.
$sha = [System.Security.Cryptography.SHA256]::Create()
$key = [System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($base.ToLowerInvariant()))).Replace('-', '').Substring(0, 16)
$mutex = New-Object System.Threading.Mutex($true, ('Local\UniOverLauncher-' + $key), [ref]$created)
if (-not $created) { exit 0 }

# Na instalacao real, o lancador antigo usava um nome de mutex sem a pasta: se um deles ainda esta
# vivo, este nao sobe (dois lancadores dariam dois agentes com a mesma identidade). Em outra pasta
# (teste, outra instalacao) o nome antigo nao vale e nao se disputa.
$realBase = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'UniOver'
$legacyMutex = $null
if ($anchor -ieq $realBase) {
    $legacyCreated = $false
    $legacyMutex = New-Object System.Threading.Mutex($true, 'Local\UniOverLauncher', [ref]$legacyCreated)
    if (-not $legacyCreated) { exit 0 }
}

# Este lancador e o unico dono do agente. Qualquer agente que sobrou (layout antigo com
# agent-src/venv/run-agent.ps1 na raiz, ou um supervisor orfao) sai antes: dois agentes com a
# mesma identidade disputariam a conexao com o servidor.
$leftovers = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and ($_.ProcessId -ne $PID) -and (
        $_.CommandLine -like "*$base\run-agent.ps1*" -or
        $_.CommandLine -like "*$base\agent-src*" -or
        $_.CommandLine -like "*$base\venv*" -or
        $_.CommandLine -like "*$base\app\*" -or
        $_.CommandLine -like "*$base\runtime\*"
    )
}
foreach ($process in $leftovers) {
    & taskkill.exe /PID $process.ProcessId /T /F *> $null
}

# Queda de energia no meio da troca de pasta da atualizacao (app -> app.previous, depois app.new -> app): sem `app` o
# supervisor nao tem de onde subir e esperaria para sempre, e nenhum outro caminho a restaura. Este lancador (que a
# atualizacao nao troca) refaz a pasta ANTES de iniciar o supervisor. So age quando `app` realmente nao existe (ou esta sem
# o essencial): a troca so acontece depois de a candidata ser validada, e uma atualizacao em andamento sempre tem `app`.
$appDir = Join-Path $base 'app'
$appNew = Join-Path $base 'app.new'
$appPrevious = Join-Path $base 'app.previous'
$runtimeDir = Join-Path $base 'runtime'
$recoveryNoted = $false

function Get-FolderVersion([string]$Folder) {
    try { $text = [System.IO.File]::ReadAllText((Join-Path $Folder '.version')).Trim() } catch { return $null }
    if ($text -match '^[0-9a-f]{40}$') { return $text }
    return $null
}

function Test-AppFolder([string]$Folder, [bool]$NeedsVersion) {
    if (-not (Test-Path -LiteralPath (Join-Path $Folder 'pyproject.toml'))) { return $false }
    if (-not (Test-Path -LiteralPath (Join-Path $Folder 'tools\run-agent.ps1'))) { return $false }
    if ($NeedsVersion -and -not (Get-FolderVersion $Folder)) { return $false }
    return $true
}

function Write-LauncherLog([string]$Message, [string]$Level = 'WARNING') {
    # Uma linha em logs\supervisor.log (o mesmo do supervisor, no formato do registro do agente). Nao vai para o
    # agent.log: o rodizio dele e do Python, e dois processos no mesmo arquivo perdem linhas.
    try {
        $logs = Join-Path $base 'logs'
        New-Item -ItemType Directory -Path $logs -Force | Out-Null
        $file = Join-Path $logs 'supervisor.log'
        if ((Test-Path -LiteralPath $file) -and ((Get-Item -LiteralPath $file).Length -gt 524288)) {
            Move-Item -LiteralPath $file -Destination ($file + '.1') -Force
        }
        $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture)
        [System.IO.File]::AppendAllText($file, ($stamp + ' ' + $Level + ' launcher: ' + $Message + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

function Add-LauncherDiagnostic([string]$Kind, [string]$Severity, [string]$Detail) {
    # Uma linha na fila de diagnostico que o agente envia a API quando conecta (so ASCII, sem caminhos).
    try {
        Add-Type -AssemblyName System.Web.Extensions
        $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
        $entry = @{ id = ([guid]::NewGuid().ToString()); at = ((Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [System.Globalization.CultureInfo]::InvariantCulture)); kind = $Kind; severity = $Severity; component = 'launcher'; detail = $Detail }
        New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
        [System.IO.File]::AppendAllText((Join-Path $runtimeDir 'diagnostics.jsonl'), ($serializer.Serialize($entry) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

function Set-RecoveryState([hashtable]$Changes) {
    # Mesmo arquivo e mesmo jeito do supervisor (runtime\update-status.json): junta ao que ja esta la. Nunca levanta erro.
    try {
        New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
        $path = Join-Path $runtimeDir 'update-status.json'
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

function Move-Folder([string]$From, [string]$To) {
    # Renomeacao de verdade (Directory.Move): ou troca o nome inteiro ou falha sem tocar em nada. O Move-Item, quando ha um
    # arquivo aberto dentro da pasta, cai para copiar-e-apagar e deixa metade dos arquivos em cada lugar.
    [System.IO.Directory]::Move([System.IO.Path]::GetFullPath($From), [System.IO.Path]::GetFullPath($To))
}

function Restore-AppFolder {
    try {
        # Layout antigo (agent-src): a migracao feita pelo proprio agente cuida dele.
        if (Test-Path -LiteralPath (Join-Path $base 'agent-src')) { return }
        if (Test-AppFolder $appDir $false) { return }
        $appWasMissing = -not (Test-Path -LiteralPath $appDir)
        # A candidata so pode ser promovida quando app realmente sumiu: durante a escrita da candidata uma app
        # completa continua no lugar. Se sobrou uma app incompleta, a copia anterior e a opcao conservadora.
        if ($appWasMissing -and (Test-AppFolder $appNew $true)) { $from = $appNew; $kind = 'app.new' }
        elseif (Test-AppFolder $appPrevious $false) { $from = $appPrevious; $kind = 'app.previous' }
        else {
            if (-not $script:recoveryNoted) {
                $script:recoveryNoted = $true
                Write-LauncherLog 'a pasta app esta ausente ou incompleta e nao ha app.new nem app.previous para restaurar'
                Set-RecoveryState @{ outcome = 'failed'; checkedAt = ((Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [System.Globalization.CultureInfo]::InvariantCulture)); reason = 'a pasta do agente esta ausente ou incompleta e nao ha copia valida para restaurar' }
            }
            return
        }
        # A atualizacao conserva app ate a candidata estar validada e pronta para a troca; por isso so uma app
        # inteiramente valida interrompe a recuperacao. A candidata jamais e promovida quando qualquer app existe.
        if (Test-AppFolder $appDir $false) { return }
        $stamp = (Get-Date).ToString('yyyyMMddHHmmss', [System.Globalization.CultureInfo]::InvariantCulture)
        $badSha = $null
        if (Test-Path -LiteralPath $appDir) {
            # Existe, mas incompleta: fica de lado (nunca e apagada) e a versao dela e bloqueada, para a atualizacao nao
            # trazer a mesma de volta a cada checagem.
            $badSha = Get-FolderVersion $appDir
            New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
            Move-Folder $appDir (Join-Path $runtimeDir ('app.incomplete-' + $stamp))
            if ($badSha) {
                try { Add-Content -LiteralPath (Join-Path $runtimeDir '.blocked-versions') -Value $badSha -Encoding ASCII } catch { }
            }
        }
        $sha = Get-FolderVersion $from
        $hadPrevious = ($kind -eq 'app.new') -and (Test-AppFolder $appPrevious $false)
        Move-Folder $from $appDir
        $trial = Join-Path $runtimeDir 'update-trial.txt'
        New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
        if ($kind -eq 'app.new') {
            # A versao que acabou de ser promovida nunca rodou: fica em prova, com a anterior guardada para onde voltar.
            if ($hadPrevious) {
                try { [System.IO.File]::WriteAllText($trial, ($sha + '|0'), [System.Text.Encoding]::ASCII) } catch { }
            }
            Set-RecoveryState @{ outcome = 'updated'; checkedAt = ((Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [System.Globalization.CultureInfo]::InvariantCulture)); reason = $null; rolledBack = $null; blockedSha = $null }
            Write-LauncherLog ('a pasta app nao existia (queda no meio da troca da atualizacao); promovi app.new, versao ' + $sha.Substring(0, 12))
            Add-LauncherDiagnostic 'installation.restored' 'warn' 'a pasta do agente nao existia (queda no meio da atualizacao); a versao nova foi promovida'
        }
        else {
            Remove-Item -LiteralPath $trial -Force -ErrorAction SilentlyContinue
            $changes = @{ outcome = 'rolled_back'; rolledBack = $true; checkedAt = ((Get-Date).ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", [System.Globalization.CultureInfo]::InvariantCulture)); reason = 'a pasta do agente estava ausente ou incompleta; restaurei a versao anterior' }
            if ($badSha) { $changes['blockedSha'] = $badSha }
            Set-RecoveryState $changes
            Write-LauncherLog 'a pasta app estava ausente ou incompleta; restaurei app.previous'
            Add-LauncherDiagnostic 'installation.restored' 'warn' 'a pasta do agente estava ausente ou incompleta; a versao anterior foi restaurada'
        }
        $script:recoveryNoted = $false
    } catch {
        Write-LauncherLog ('nao consegui restaurar a pasta app (' + $_.Exception.GetType().Name + ')')
    }
}

while ($true) {
    Restore-AppFolder
    if (Test-Path -LiteralPath $current) {
        $started = Get-Date
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $current
        $code = $LASTEXITCODE
        if ($code -eq 42) { Write-LauncherLog 'o supervisor pediu para reiniciar (versao nova ou volta atras)' 'INFO'; continue }
        Write-LauncherLog ('o supervisor terminou (codigo ' + $code + ') depois de ' + [int]((Get-Date) - $started).TotalSeconds + ' s')
        if (((Get-Date) - $started).TotalSeconds -ge 30) { Start-Sleep -Seconds 5; continue }
    }
    # Durante a primeira migracao, a tarefa ja aponta para este lancador antes de `agent-src`
    # virar `app`. A queda nesse intervalo ainda pode iniciar o supervisor antigo.
    if (Test-Path -LiteralPath $legacy) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $legacy
        Start-Sleep -Seconds 5
        continue
    }
    if (Test-Path -LiteralPath $fallback) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $fallback
    }
    Start-Sleep -Seconds 30
}
