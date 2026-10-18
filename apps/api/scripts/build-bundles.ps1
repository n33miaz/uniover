# Equivalente em PowerShell de build-bundles.sh: um bundle por módulo com Persistence/ e ModuleDesignTimeFactory.
$ErrorActionPreference = 'Stop'
$apiRoot = Split-Path -Parent $PSScriptRoot
Set-Location $apiRoot

# O dotnet ef só instancia a fábrica de design; esta conexão nunca é usada para gerar o bundle.
if (-not $env:UNIOVER_MIGRATIONS_CONNECTION) {
    $env:UNIOVER_MIGRATIONS_CONNECTION = 'Host=localhost;Database=unused;Username=unused;Password=unused'
}

$built = 0
foreach ($moduleDir in Get-ChildItem -Directory 'src/Modules') {
    $module = $moduleDir.Name
    $project = "src/Modules/$module/UniOver.Modules.$module/UniOver.Modules.$module.csproj"
    $persistence = "src/Modules/$module/UniOver.Modules.$module/Persistence"

    if (-not (Test-Path $project) -or -not (Test-Path $persistence)) { continue }
    if (-not (Select-String -Path "$persistence/*.cs" -Pattern 'ModuleDesignTimeFactory' -Quiet -ErrorAction SilentlyContinue)) { continue }

    Write-Host "==> bundle de $module"
    dotnet ef migrations bundle --project $project --startup-project $project `
        --self-contained -r linux-x64 -o "artifacts/bundles/$($module.ToLower())/efbundle" --force
    if ($LASTEXITCODE -ne 0) { throw "falha ao gerar o bundle de $module" }
    $built++
}

Write-Host "bundles gerados: $built"
