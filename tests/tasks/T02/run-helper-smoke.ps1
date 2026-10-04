param(
    [Parameter(Mandatory = $true)]
    [string]$HelperPath
)

$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path -LiteralPath $HelperPath).Path
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $resolved
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.EnvironmentVariables['CLIPNEST_STABLE_PROFILE_ID'] = '0000000000000000000000000000000000000000000000000000000000000000'
$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $startInfo
if (-not $process.Start()) { throw 'helper_start_failed' }

try {
    $readyTask = $process.StandardOutput.ReadLineAsync()
    if (-not $readyTask.Wait(5000)) { throw 'ready_timeout' }
    $ready = $readyTask.Result | ConvertFrom-Json
    if ($ready.status -ne 'ready' -or $ready.helperPid -ne $process.Id) { throw 'ready_process_mismatch' }
    $createdAt = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture)
    if ($ready.helperProcessCreatedAt -ne $createdAt) { throw 'ready_creation_time_mismatch' }

    $request = [ordered]@{
        v = 1
        requestId = 't02-smoke-capture-1'
        generation = 't02-smoke-generation'
        helperInstanceId = [string]$ready.helperInstanceId
        kind = 'capture'
    }
    $process.StandardInput.WriteLine(($request | ConvertTo-Json -Compress))
    $process.StandardInput.Flush()
    $captureTask = $process.StandardOutput.ReadLineAsync()
    if (-not $captureTask.Wait(2000)) { throw 'capture_timeout' }
    $capture = $captureTask.Result | ConvertFrom-Json
    if ($capture.status -notin @('captured', 'target_invalid')) { throw 'capture_protocol_failure' }

    $process.StandardInput.Close()
    if (-not $process.WaitForExit(2000)) { throw 'helper_shutdown_timeout' }
    if ($process.ExitCode -ne 0) { throw 'helper_shutdown_failed' }
    Write-Output "PASS: READY identity matched the spawned process; read-only capture status=$($capture.status); no clipboard write or input request was sent."
}
finally {
    if (-not $process.HasExited) {
        $process.Kill()
        $process.WaitForExit()
    }
    $process.Dispose()
}
