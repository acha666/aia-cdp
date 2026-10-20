#Requires -Version 7.0
<#
.SYNOPSIS
    Publishes the CRLs that an AD CS CA writes to SourceDir through an aia-cdp upload route.

.DESCRIPTION
    Every *.crl, *.dcrl and *.pem file directly in SourceDir (X.pem is skipped when X exists) is
    sent, oldest LastWriteTimeUtc first, as the raw body of POST /api/v1/crls: DER (first byte
    0x30) as application/pkix-crl, a PEM file (with an X509 CRL block) as application/x-pem-file.
    The service finds the target from the CRL's issuer and kind and answers created, updated or
    unchanged, which all succeed, or an error code, which fails that file.

    A ledger (LedgerPath: file path -> SHA-256 of the bytes last accepted from that path, for one
    UploadUri) skips files whose bytes the service already accepted, so a run uploads only what
    changed. A file that is not in the ledger and comes back stale_crl is a failure: the CA
    produced a CRL older than the one the service publishes.

    One file failing does not stop the others. Exit code 0 when no file failed, also when there
    are no files; 1 when a file failed or the run could not start (missing SourceDir, a missing,
    empty or malformed token file, the token over http:// without -AllowInsecureHttp).

    Meant for a scheduled task on the CA: Microsoft-Windows-CertificationAuthority events 68, 69
    and 70 plus a periodic catch-up run, MultipleInstances IgnoreNew (docs/operations.md).

.PARAMETER UploadUri
    The upload route: https://<host>/api/v1/crls.

.PARAMETER UploadTokenFile
    File holding the service's AIA_UPLOAD_TOKEN (surrounding whitespace is ignored). Without it
    no Authorization header is sent, which the service accepts only while AIA_UPLOAD_TOKEN is
    unset. The token never appears in the log or on the command line; keep the file readable by
    the task's account only (icacls).

.PARAMETER SourceDir
    The directory the CA publishes its CRLs to. Not searched recursively.

.PARAMETER LogPath
    Log file, appended to (UTF-8).

.PARAMETER LedgerPath
    JSON { "uploadUri": <UploadUri, normalized>, "files": { <file path>: <SHA-256, lowercase
    hex, of the accepted bytes> } }. A missing or unreadable ledger, or one written for another
    UploadUri, counts as empty: every file is sent again, those the service already has come back
    unchanged, and the next success rewrites it for this UploadUri. After the service at the same
    UploadUri is restored or rolled back, delete the ledger (docs/operations.md).

.PARAMETER TimeoutSec
    Timeout of one upload request, in seconds.

.PARAMETER AllowInsecureHttp
    Send the token to an http:// UploadUri as well (tests only).

.PARAMETER UploadIntervalMs
    Pause between two uploads. The service's R2 store takes about one write per second to the
    catalog object, so a full and a delta CRL published together must not arrive back to back.

.EXAMPLE
    pwsh.exe -NoProfile -NonInteractive -File "C:\Program Files\aia-cdp\adcs-crl-uploader.ps1" -UploadUri https://pki.example.com/api/v1/crls -UploadTokenFile C:\ProgramData\PKI\crl-uploader\upload-token.txt
#>
# No positional parameters: an unquoted path with a space must not bind its tail to another one.
[CmdletBinding(PositionalBinding = $false)]
param(
    [ValidateNotNullOrEmpty()][string]$UploadUri = 'https://aia.example.com/api/v1/crls',
    [ValidateNotNullOrEmpty()][string]$UploadTokenFile,
    [ValidateNotNullOrEmpty()][string]$SourceDir = 'C:\ProgramData\PKI\crl-uploader\CertEnroll',
    [ValidateNotNullOrEmpty()][string]$LogPath = 'C:\ProgramData\PKI\crl-uploader\upload.log',
    [ValidateNotNullOrEmpty()][string]$LedgerPath = 'C:\ProgramData\PKI\crl-uploader\published.json',
    [ValidateRange(1, 3600)][int]$TimeoutSec = 60,
    [switch]$AllowInsecureHttp,
    [ValidateRange(0, 600000)][int]$UploadIntervalMs = 1000
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# The CA may still be writing a file when its event fires: reads are retried this often.
$ReadAttempts = 5
$ReadRetryMs = 1000

# Logging: one line per event, to the log file and the console. Never throws.
function Write-Log {
    param(
        [ValidateSet('INFO', 'WARN', 'ERROR', 'SUCCESS')][string]$Level = 'INFO',
        [Parameter(Mandatory)][string]$Message
    )
    # Invariant: the current culture's time separator is not always ':' (fi-FI writes 07.50.35).
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fffK', [cultureinfo]::InvariantCulture)
    $line = "[$ts][$Level] $Message"
    try { New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null } catch {}
    try { Add-Content -LiteralPath $LogPath -Value $line } catch {}
    $color = switch ($Level) {
        'WARN' { 'Yellow' }
        'ERROR' { 'Red' }
        'SUCCESS' { 'Green' }
        default { 'White' }
    }
    try { Write-Host $line -ForegroundColor $color } catch {}
}

# An exception's message followed by its inner exceptions' (one the previous message already
# quotes is dropped): a TLS or socket failure is named only by an inner one ("The SSL connection
# could not be established, see inner exception."), and upload.log is all a scheduled run leaves.
function Format-Exception {
    param([Parameter(Mandatory)][System.Exception]$Exception)
    $messages = [System.Collections.Generic.List[string]]::new()
    for ($e = $Exception; $e; $e = $e.InnerException) {
        if ($messages.Count -eq 0 -or -not $messages[$messages.Count - 1].Contains($e.Message)) {
            $messages.Add($e.Message)
        }
    }
    $messages -join ' -> '
}

# Startup ----------------------------------------------------------------------------------------

# The upload token as a SecureString, or $null without -UploadTokenFile. Exits 1 when the file is
# missing, unreadable, empty or holds something a bearer token cannot be. Messages never quote it.
function Read-UploadToken {
    if (-not $UploadTokenFile) {
        return $null
    }
    if (-not (Test-Path -LiteralPath $UploadTokenFile -PathType Leaf)) {
        Write-Log ERROR "Token file not found: $UploadTokenFile"
        exit 1
    }
    try {
        $text = Get-Content -LiteralPath $UploadTokenFile -Raw
    }
    catch {
        Write-Log ERROR ("Cannot read the token file {0}: {1}" -f $UploadTokenFile, (Format-Exception $_.Exception))
        exit 1
    }
    $plain = if ($null -eq $text) { '' } else { $text.Trim() }
    if (-not $plain) {
        Write-Log ERROR "Token file is empty: $UploadTokenFile"
        exit 1
    }
    # RFC 6750 b64token, as the service requires of AIA_UPLOAD_TOKEN. Anything else could never
    # authenticate, and an invalid header value would be quoted in the request's error message.
    if ($plain -notmatch '^[A-Za-z0-9._~+/-]+=*$') {
        Write-Log ERROR "Token file holds characters a bearer token cannot have: $UploadTokenFile"
        exit 1
    }
    ConvertTo-SecureString -String $plain -AsPlainText -Force
}

# Ledger -----------------------------------------------------------------------------------------

# File path -> SHA-256 of the bytes the service at $Uri accepted. Paths compare case-insensitively,
# like Windows paths (a hashtable does). Entries recorded for another URI say nothing about this
# service (staging -> production, a switch-over, Workers <-> Docker): that ledger counts as empty.
function Read-Ledger {
    param([Parameter(Mandatory)][string]$Uri)
    $ledger = @{}
    if (-not (Test-Path -LiteralPath $LedgerPath -PathType Leaf)) {
        Write-Log WARN "Ledger not found, starting empty: $LedgerPath"
        return $ledger
    }
    try {
        $data = Get-Content -LiteralPath $LedgerPath -Raw | ConvertFrom-Json -AsHashtable
        if ($data -isnot [System.Collections.IDictionary] -or $data.uploadUri -isnot [string] -or
            $data.files -isnot [System.Collections.IDictionary]) {
            throw 'not a JSON object with uploadUri and files'
        }
        if ($data.uploadUri -cne $Uri) {
            Write-Log WARN ("Ledger was written for {0}, starting empty for {1}: {2}" -f
                $data.uploadUri, $Uri, $LedgerPath)
            return $ledger
        }
        foreach ($entry in $data.files.GetEnumerator()) {
            if ($entry.Value -isnot [string] -or $entry.Value -cnotmatch '^[0-9a-f]{64}$') {
                throw "the entry for $($entry.Key) is not a SHA-256"
            }
            $ledger[$entry.Key] = $entry.Value
        }
    }
    catch {
        Write-Log WARN ("Ledger unreadable, starting empty: {0}: {1}" -f $LedgerPath, (Format-Exception $_.Exception))
        $ledger.Clear()
    }
    $ledger
}

# Written for $Uri through a temporary file and a rename, so a crash never leaves half a ledger.
function Save-Ledger {
    param([Parameter(Mandatory)][hashtable]$Ledger, [Parameter(Mandatory)][string]$Uri)
    $sorted = [ordered]@{}
    foreach ($key in ($Ledger.Keys | Sort-Object)) {
        $sorted[$key] = $Ledger[$key]
    }
    $dir = Split-Path -Parent $LedgerPath
    if ($dir) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $temp = "$LedgerPath.tmp"
    [ordered]@{ uploadUri = $Uri; files = $sorted } | ConvertTo-Json -Depth 3 |
        Set-Content -LiteralPath $temp -Encoding utf8NoBOM
    Move-Item -LiteralPath $temp -Destination $LedgerPath -Force
}

# Files ------------------------------------------------------------------------------------------

# The file's bytes, read with FileShare.Read (no writer may hold it), retried on IOException.
function Read-CrlFile {
    param([Parameter(Mandatory)][string]$Path)
    for ($attempt = 1; ; $attempt++) {
        try {
            $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
            try {
                $buffer = [System.IO.MemoryStream]::new()
                $stream.CopyTo($buffer)
                # The comma keeps the pipeline from unrolling the array byte by byte.
                return , $buffer.ToArray()
            }
            finally {
                $stream.Dispose()
            }
        }
        catch [System.IO.IOException] {
            if ($attempt -ge $ReadAttempts) {
                throw
            }
            Write-Log WARN ("Cannot read {0} yet (attempt {1} of {2}): {3}" -f
                $Path, $attempt, $ReadAttempts, (Format-Exception $_.Exception))
            Start-Sleep -Milliseconds $ReadRetryMs
        }
    }
}

# The upload media type from the bytes, as the service recognizes them; $null for neither.
function Get-CrlMediaType {
    param([Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Bytes)
    if ($Bytes.Length -gt 0 -and $Bytes[0] -eq 0x30) {
        return 'application/pkix-crl'
    }
    if ([System.Text.Encoding]::ASCII.GetString($Bytes).Contains('-----BEGIN X509 CRL-----')) {
        return 'application/x-pem-file'
    }
    $null
}

# Upload -----------------------------------------------------------------------------------------

# One POST. Returns the status and the parsed body (an object for JSON, else text); throws on
# network errors and timeouts.
function Send-Crl {
    param(
        [Parameter(Mandatory)][byte[]]$Bytes,
        [Parameter(Mandatory)][string]$ContentType,
        [securestring]$Token
    )
    $request = @{
        Method             = 'Post'
        Uri                = $UploadUri
        ContentType        = $ContentType
        Body               = $Bytes
        TimeoutSec         = $TimeoutSec
        SkipHttpErrorCheck = $true
        StatusCodeVariable = 'status'
    }
    if ($Token) {
        $request.Authentication = 'Bearer'
        $request.Token = $Token
        # Startup refused http:// with a token unless -AllowInsecureHttp.
        $request.AllowUnencryptedAuthentication = $AllowInsecureHttp.IsPresent
    }
    $body = Invoke-RestMethod @request
    [pscustomobject]@{ Status = $status; Body = $body }
}

# Invoke-RestMethod turns ISO time strings into DateTime values; log them as ISO UTC again.
function Format-Time {
    param($Value)
    if ($Value -is [datetime]) {
        return $Value.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ', [cultureinfo]::InvariantCulture)
    }
    "$Value"
}

function Format-Details {
    param($Details)
    if ($null -eq $Details) {
        return ''
    }
    ' ' + ($Details | ConvertTo-Json -Compress -Depth 5)
}

# Main -------------------------------------------------------------------------------------------

try {
    Write-Log INFO ("Startup: UploadUri={0}; SourceDir={1}; LedgerPath={2}; UploadTokenFile={3}" -f
        $UploadUri, $SourceDir, $LedgerPath, ($UploadTokenFile ? $UploadTokenFile : '(none)'))

    $uri = $null
    if (-not [System.Uri]::TryCreate($UploadUri, [System.UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin 'http', 'https') {
        Write-Log ERROR "UploadUri is not an absolute http:// or https:// URI: $UploadUri"
        exit 1
    }
    if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) {
        Write-Log ERROR "SourceDir not found: $SourceDir"
        exit 1
    }
    $token = Read-UploadToken
    if ($token -and $uri.Scheme -eq 'http' -and -not $AllowInsecureHttp) {
        Write-Log ERROR 'Refusing to send the upload token over http://: use https:// (-AllowInsecureHttp is for tests)'
        exit 1
    }

    $files = @(Get-ChildItem -LiteralPath $SourceDir -File |
            Where-Object Extension -In '.crl', '.dcrl', '.pem' |
            Sort-Object LastWriteTimeUtc, Name)
    if ($files.Count -eq 0) {
        Write-Log WARN "No CRL files found in $SourceDir"
        exit 0
    }
    $names = [System.Collections.Generic.HashSet[string]]::new(
        [string[]]$files.Name, [System.StringComparer]::OrdinalIgnoreCase)

    # The ledger is for this URI as the service sees it: scheme and host lowercase, no default port.
    $ledgerUri = $uri.AbsoluteUri
    $ledger = Read-Ledger -Uri $ledgerUri
    $counts = [ordered]@{ Created = 0; Updated = 0; Unchanged = 0; Skipped = 0; Failed = 0 }
    $uploaded = $false

    foreach ($file in $files) {
        try {
            if ($file.Extension -eq '.pem' -and $names.Contains($file.BaseName)) {
                Write-Log INFO ("Skipped: {0} ({1} is uploaded instead)" -f $file.Name, $file.BaseName)
                $counts.Skipped++
                continue
            }

            $bytes = Read-CrlFile -Path $file.FullName
            $sha256 = (Get-FileHash -InputStream ([System.IO.MemoryStream]::new($bytes)) -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($ledger[$file.FullName] -eq $sha256) {
                Write-Log INFO ("Skipped: {0} (accepted before, sha256 {1})" -f $file.Name, $sha256)
                $counts.Skipped++
                continue
            }
            $contentType = Get-CrlMediaType -Bytes $bytes
            if (-not $contentType) {
                Write-Log ERROR ("{0}: neither DER nor PEM with an X509 CRL block, not uploaded" -f $file.Name)
                $counts.Failed++
                continue
            }

            if ($uploaded -and $UploadIntervalMs -gt 0) {
                Start-Sleep -Milliseconds $UploadIntervalMs
            }
            $uploaded = $true
            Write-Log INFO ("Uploading: {0} ({1}, {2} bytes, sha256 {3})" -f
                $file.Name, $contentType, $bytes.Length, $sha256)
            $response = Send-Crl -Bytes $bytes -ContentType $contentType -Token $token
            $status = $response.Status
            $body = $response.Body

            if ($status -in 200, 201 -and $body.outcome -in 'created', 'updated', 'unchanged') {
                $ledger[$file.FullName] = $sha256
                try {
                    Save-Ledger -Ledger $ledger -Uri $ledgerUri
                }
                catch {
                    # Not recorded: the next run sends the file again and gets unchanged.
                    $ledger.Remove($file.FullName)
                    Write-Log ERROR ("{0}: {1} on the service, but the ledger could not be written: {2}" -f
                        $file.Name, $body.outcome, (Format-Exception $_.Exception))
                    $counts.Failed++
                    continue
                }
                $number = if ($null -eq $body.crlNumber) { 'none' } else { $body.crlNumber }
                Write-Log SUCCESS ("{0}: {1} (target {2}, {3} CRL Number {4}, thisUpdate {5})" -f
                    $file.Name, $body.outcome, $body.target, $body.kind, $number, (Format-Time $body.thisUpdate))
                $counts[$body.outcome]++
                continue
            }

            $counts.Failed++
            $code = $body.error.code
            if (-not $code) {
                Write-Log ERROR ("{0}: HTTP {1}, not an upload result" -f $file.Name, $status)
                continue
            }
            $message = "{0}: HTTP {1} {2}: {3}{4}" -f
                $file.Name, $status, $code, $body.error.message, (Format-Details $body.error.details)
            if ($code -eq 'stale_crl') {
                $message += ' (the CA wrote a CRL older than the published one)'
            }
            elseif ($status -eq 401) {
                $message += $token ? ' (the token in -UploadTokenFile is wrong)' :
                    ' (the service requires a token: pass -UploadTokenFile)'
            }
            Write-Log ERROR $message
        }
        catch {
            Write-Log ERROR ("{0}: {1}" -f $file.Name, (Format-Exception $_.Exception))
            $counts.Failed++
        }
    }

    $level = if ($counts.Failed -gt 0) { 'ERROR' } else { 'SUCCESS' }
    Write-Log $level ("Completed. Created: {0}, Updated: {1}, Unchanged: {2}, Skipped: {3}, Failed: {4}" -f
        $counts.Created, $counts.Updated, $counts.Unchanged, $counts.Skipped, $counts.Failed)
    if ($counts.Failed -gt 0) {
        exit 1
    }
    exit 0
}
catch {
    Write-Log ERROR (Format-Exception $_.Exception)
    exit 1
}
