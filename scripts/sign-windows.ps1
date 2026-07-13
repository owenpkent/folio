#requires -Version 5.1
<#
.SYNOPSIS
    Wrapper invoked by Tauri's bundle.windows.signCommand.

.DESCRIPTION
    Tauri runs signCommand against every staged binary going into the bundle:
    the app .exe, the final .msi/-setup.exe installer, AND every vendor DLL
    along the way (Wix UI/Util extensions, NSIS plugins). Vendor DLLs are
    already signed by their authors and don't need OK Studio's signature --
    re-signing them is wasteful and increases exposure to Windows Defender
    file-lock failures during the build.

    Behavior:
      - .exe / .msi  --> sign with the OK Studio EV cert via the SafeNet
                       eToken, retrying up to 5 times with linear backoff
                       (mirrors alpha-osk/build/windows/sign.py and
                       MacroVox/scripts/sign-windows.ps1).
      - everything else (.dll, .tmp, etc.) --> exit 0 without doing anything.
      - missing/garbled path (e.g. literal "%1" if Tauri's substitution
        misbehaves) --> log and exit 0 so the bundle keeps moving.

    Cert is identified by SHA-1 thumbprint to disambiguate if multiple certs
    are present in the user store.

.PARAMETER Path
    Absolute path to the file Tauri wants signed. Tauri substitutes %1 in
    the signCommand template with this value.

.NOTES
    The eToken is invisible to elevated processes -- invoke `tauri build`
    from a non-elevated PowerShell with the token plugged in.
#>

param(
    [Parameter(Mandatory = $false, Position = 0)]
    [string]$Path
)

# Don't use Stop here -- we want to exit 0 on unexpected input rather than
# crash the bundle for a vendor file we'd skip anyway.
$ErrorActionPreference = 'Continue'

# Strip any surrounding quotes Tauri may have left in the substituted path.
if ($Path) {
    $Path = $Path.Trim('"').Trim("'")
}

# OK Studio Inc. EV cert (same cert as alpha-osk / MacroVox;
# see alpha-osk/build/windows/sign.py).
$Thumbprint   = 'fc22b5221318f3f3f6b3eb2d969d7f99091557bf'
$TimestampUrl = 'http://timestamp.digicert.com'
$MaxAttempts  = 5

# Defensive: if Tauri didn't substitute, the path will be the literal "%1"
# (or empty). Skip rather than blowing up the bundle.
if (-not $Path -or $Path -eq '%1' -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-Host "[sign-windows] skip (path not a file): '$Path'"
    exit 0
}

$ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
if ($ext -ne '.exe' -and $ext -ne '.msi') {
    Write-Host "[sign-windows] skip (not .exe/.msi): $Path"
    exit 0
}

# Skip gracefully when the OK Studio EV cert isn't in the store: a dev machine
# without the eToken plugged in, or CI (GitHub's windows-latest builds the app
# to catch breakage but has no token). This keeps `tauri build` succeeding
# everywhere; a real *signed* build only happens on the EV host with the token
# present, where this check passes and signing proceeds. String -eq is
# case-insensitive, so the lowercase literal matches the store's uppercase.
$certPresent = @(Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
    Where-Object { $_.Thumbprint -eq $Thumbprint }).Count -gt 0
if (-not $certPresent) {
    Write-Host "[sign-windows] OK Studio EV cert not in store (dev/CI build) -- skipping: $Path"
    exit 0
}

# Resolve signtool.exe -- Tauri's signCommand spawns this script in a plain
# (non-Developer) PowerShell where the Windows SDK isn't on PATH. Prefer
# whatever's on PATH; otherwise pick the highest-versioned x64 signtool from
# the SDK install root.
$signtool = $null
$cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
if ($cmd) { $signtool = $cmd.Source }
if (-not $signtool) {
    $sdkRoots = @()
    $pf32 = [Environment]::GetEnvironmentVariable('ProgramFiles')
    $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    if ($pf32) { $sdkRoots += (Join-Path $pf32 'Windows Kits\10\bin') }
    if ($pf86) { $sdkRoots += (Join-Path $pf86 'Windows Kits\10\bin') }
    foreach ($root in $sdkRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        $found = Get-ChildItem -Path $root -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue
        $x64   = $found | Where-Object { $_.FullName -like '*\x64\signtool.exe' }
        $best  = $x64 | Sort-Object FullName -Descending | Select-Object -First 1
        if ($best) { $signtool = $best.FullName; break }
    }
}
if (-not $signtool) {
    Write-Host "[sign-windows] signtool.exe not found on PATH or in Windows Kits -- install the Windows 10/11 SDK or run from a Developer PowerShell"
    exit 1
}

for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    & $signtool sign /sha1 $Thumbprint /fd sha256 /tr $TimestampUrl /td sha256 $Path
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[sign-windows] signed (attempt $attempt): $Path"
        exit 0
    }

    if ($attempt -lt $MaxAttempts) {
        $delay = $attempt * 2
        Write-Host "[sign-windows] signtool exit $LASTEXITCODE; retry in ${delay}s (Defender lock?)..."
        Start-Sleep -Seconds $delay
    }
}

Write-Host "[sign-windows] FAILED after $MaxAttempts attempts: $Path"
exit 1
