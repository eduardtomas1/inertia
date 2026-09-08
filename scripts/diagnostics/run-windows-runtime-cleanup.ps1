$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
if ($env:INERTIA_DIAGNOSTIC_ATTEMPT -notmatch '^[1-5]$') { throw 'Invalid diagnostic attempt' }
$attempt = $env:INERTIA_DIAGNOSTIC_ATTEMPT
New-Item -ItemType Directory -Force -Path diagnostic-results | Out-Null
npm exec -- vitest run tests/server/runtime.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile.json="diagnostic-results/attempt-$attempt.json" 2>&1 | Tee-Object -FilePath "diagnostic-results/attempt-$attempt.log"
$result = $LASTEXITCODE
@{ attempt = [int]$attempt; exitCode = $result; source = 'ae58b5c425ccd1d708fef912070dd1047f344840' } | ConvertTo-Json | Set-Content "diagnostic-results/attempt-$attempt-result.json"
if ($result -ne 0) { Write-Output "DIAGNOSTIC_ITERATION_FAILED=$attempt" }
exit $result
