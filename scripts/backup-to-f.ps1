# 完整自包含备份 -> F:\music-app-backup
# 用法: powershell -ExecutionPolicy Bypass -File scripts\backup-to-f.ps1
$ErrorActionPreference = 'Stop'
$ROOT   = 'F:\music-app-backup'
$ZONE   = 'asia-east2-a'
$VM     = 'music-app'
$stamp  = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$log    = Join-Path $ROOT 'backup.log'

New-Item -ItemType Directory -Force -Path $ROOT, "$ROOT\music", "$ROOT\clips", "$ROOT\system" | Out-Null
function Say($m) { $line = "[$(Get-Date -Format 'HH:mm:ss')] $m"; Write-Host $line; Add-Content -Path $log -Value $line -Encoding utf8 }

Say "=== backup start $stamp ==="

# --- 1. VM 侧收集(数据库/配置/证书/代码) ---
Say "[1/4] collecting VM payload..."
gcloud compute scp "$PSScriptRoot\vm-backup-collect.sh" "${VM}:/home/chaol/vm-backup-collect.sh" --zone=$ZONE 2>&1 | Out-Null
$out = gcloud compute ssh $VM --zone=$ZONE --command="bash ~/vm-backup-collect.sh" 2>&1
if ($LASTEXITCODE -ne 0) { Say "FATAL: VM collection failed`n$out"; exit 1 }
$out | Select-String 'DONE|FATAL|db_size|songs_count|clips_count' | ForEach-Object { Say "    $_" }

Say "[2/4] downloading payload..."
gcloud compute scp "${VM}:/home/chaol/vm-backup-payload.tar.gz" "$ROOT\system\vm-backup-payload.tar.gz" --zone=$ZONE 2>&1 | Out-Null
if (-not (Test-Path "$ROOT\system\vm-backup-payload.tar.gz")) { Say "FATAL: payload download failed"; exit 1 }
$pm = (Get-Item "$ROOT\system\vm-backup-payload.tar.gz").Length / 1MB
Say "    payload: $([math]::Round($pm,1)) MB"
gcloud compute ssh $VM --zone=$ZONE --command="rm -f ~/vm-backup-payload.tar.gz" 2>&1 | Out-Null

# --- 2. 曲库:从本地镜像同步(本地即权威副本,已与 VM 对齐) ---
Say "[3/4] mirroring songs (41GB, incremental)..."
$rc = robocopy 'C:\Projects\web-v1\music\allSongs' "$ROOT\music" /MIR /R:2 /W:2 /NP /NDL /NJH /NJS /MT:8
if ($LASTEXITCODE -ge 8) { Say "FATAL: robocopy songs failed (exit $LASTEXITCODE)"; exit 1 }
Say "    songs: $((Get-ChildItem "$ROOT\music" -File).Count) files"

# --- 3. 切片:增量同步(首次全量,之后只传新增) ---
# --- 3. 切片:增量同步(首次全量,之后只传新增) ---
Say "[4/4] syncing clips (incremental)..."
$clipDir = Join-Path $ROOT 'clips\allClips'
New-Item -ItemType Directory -Force -Path $clipDir | Out-Null

gcloud compute ssh $VM --zone=$ZONE --command="ls -A /var/www/music/allClips > /tmp/cliplist.txt" 2>&1 | Out-Null
$listLocal = Join-Path $env:TEMP 'cliplist.txt'
Remove-Item $listLocal -ErrorAction SilentlyContinue
gcloud compute scp "${VM}:/tmp/cliplist.txt" $listLocal --zone=$ZONE 2>&1 | Out-Null
if (-not (Test-Path $listLocal)) { Say "FATAL: cannot fetch clip list"; exit 1 }

$vmClips = @(Get-Content $listLocal -Encoding utf8 | Where-Object { $_ -ne '' })
$have = @{}
Get-ChildItem $clipDir -File -ErrorAction SilentlyContinue | ForEach-Object { $have[$_.Name] = $true }
$need = @($vmClips | Where-Object { -not $have.ContainsKey($_) })
Say "    VM=$($vmClips.Count)  local=$($have.Count)  need=$($need.Count)"

if ($need.Count -gt 0) {
    $BATCH = 10000
    for ($i = 0; $i -lt $need.Count; $i += $BATCH) {
        $chunk = $need[$i..([Math]::Min($i + $BATCH - 1, $need.Count - 1))]
        $needFile = Join-Path $env:TEMP 'need-clips.txt'
        [System.IO.File]::WriteAllLines($needFile, $chunk, (New-Object System.Text.UTF8Encoding $false))
        gcloud compute scp $needFile "${VM}:/tmp/need-clips.txt" --zone=$ZONE 2>&1 | Out-Null
        gcloud compute ssh $VM --zone=$ZONE --command="sed -i '1s/^\xEF\xBB\xBF//; s/\r`$//' /tmp/need-clips.txt" 2>&1 | Out-Null
        gcloud compute ssh $VM --zone=$ZONE --command="cd /var/www/music/allClips && sed -e '1s/^\xEF\xBB\xBF//' -e 's/\r$//' /tmp/need-clips.txt | tar cf /home/chaol/clips-delta.tar --ignore-failed-read -T -" 2>&1 | Out-Null
        $deltaLocal = Join-Path $env:TEMP 'clips-delta.tar'
        Remove-Item $deltaLocal -ErrorAction SilentlyContinue
        gcloud compute scp "${VM}:/home/chaol/clips-delta.tar" $deltaLocal --zone=$ZONE 2>&1 | Out-Null
        if (-not (Test-Path $deltaLocal)) { Say "FATAL: clips delta download failed at offset $i"; exit 1 }
        $pyExe = "C:\Users\chaol\AppData\Local\Google\Cloud SDK\google-cloud-sdk\platform\bundledpython\python.exe"
        if (-not (Test-Path $pyExe)) { $pyExe = (Get-Command python -ErrorAction SilentlyContinue).Source }
        if (-not $pyExe) { Say "FATAL: python not found (needed for UTF-8 safe extraction)"; exit 1 }
        $pyCode = "import tarfile,sys,warnings; warnings.simplefilter('ignore'); t=tarfile.open(sys.argv[1],'r'); t.extractall(sys.argv[2],filter='data'); t.close()"
        $pyOut = & $pyExe -c $pyCode $deltaLocal $clipDir 2>&1
        if ($LASTEXITCODE -ne 0) { Say "FATAL: python extract failed: $pyOut"; exit 1 }
        Remove-Item $deltaLocal -ErrorAction SilentlyContinue
        gcloud compute ssh $VM --zone=$ZONE --command="rm -f /home/chaol/clips-delta.tar /tmp/need-clips.txt" 2>&1 | Out-Null
        $done = [Math]::Min($i + $BATCH, $need.Count)
        Say "    clips $done / $($need.Count)"
    }
}

$vmSet = @{}; $vmClips | ForEach-Object { $vmSet[$_] = $true }
$stale = @(Get-ChildItem $clipDir -File | Where-Object { -not $vmSet.ContainsKey($_.Name) })
if ($stale.Count -gt 0) { $stale | Remove-Item -Force; Say "    removed $($stale.Count) stale clips" }

$clipCount = (Get-ChildItem $clipDir -File).Count
$cm = ((Get-ChildItem $clipDir -File | Measure-Object -Property Length -Sum).Sum) / 1GB
if ($clipCount -lt $vmClips.Count) { Say "WARN: clip count local=$clipCount vm=$($vmClips.Count)" }
Say "    clips: $clipCount files, $([math]::Round($cm,2)) GB (+$($need.Count) new)"

# --- 4. 汇总 ---
$total = (Get-ChildItem $ROOT -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1GB
@"
backup_completed : $stamp
total_size_gb    : $([math]::Round($total,2))
songs_files      : $((Get-ChildItem "$ROOT\music" -File).Count)
payload_mb       : $([math]::Round($pm,1))
clips_files      : $clipCount
clips_gb         : $([math]::Round($cm,2))
new_clips_added  : $($needClips.Count)
"@ | Set-Content "$ROOT\LAST-BACKUP.txt" -Encoding utf8

Say "=== DONE — total $([math]::Round($total,2)) GB at $ROOT ==="
