$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$testBase = Join-Path $repoRoot 'builds/aria-smoke'
$report = Join-Path $repoRoot 'builds/aria-smoke-result.json'
New-Item -ItemType Directory -Force -Path "$testBase/workspace", "$testBase/user-data/User", "$testBase/extensions", "$testBase/store" | Out-Null
[System.IO.File]::WriteAllText("$testBase/user-data/User/settings.json", '{"aria.autoStart":false,"aria.adapterSetup":"off","aria.autoOpen":true,"editor.codeLens":true,"security.workspace.trust.enabled":false}', [System.Text.UTF8Encoding]::new($false))
if (Test-Path -LiteralPath $report) { Remove-Item -LiteralPath $report -Force }
$previousStore = $env:OIR_STORE_DIR
try {
    $env:OIR_STORE_DIR = "$testBase/store"
    $codeCommand = (Get-Command code.cmd -ErrorAction Stop).Source
    & $codeCommand --user-data-dir "$testBase/user-data" --extensions-dir "$testBase/extensions" --extensionDevelopmentPath $PSScriptRoot --extensionTestsPath "$PSScriptRoot/test-extension.js" --disable-extensions --disable-workspace-trust --skip-welcome --skip-release-notes --new-window "$testBase/workspace" --wait
    if (-not (Test-Path -LiteralPath $report)) { throw 'VS Code did not run the extension tests. Check launch errors above.' }
    $result = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    if ($result.status -ne 'passed') { throw "Extension tests failed: $($result.error)" }
    Write-Output 'EXTENSION HOST TESTS PASSED'
} finally {
    $env:OIR_STORE_DIR = $previousStore
}
