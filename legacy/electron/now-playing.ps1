# «Сейчас играет» из Windows: System Media Transport Controls.
#
# Это тот же источник, что показывает плашка громкости Windows: название,
# артист, обложка и позиция трека любого плеера — браузера с YouTube Music,
# Spotify, чего угодно. Раз в секунду печатает одну строку JSON в stdout;
# главный процесс Electron читает её и отдаёт визуализатору.
#
# Работает только в Windows PowerShell 5.1 (powershell.exe): проекция WinRT в
# PowerShell 7 убрана.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($operation, [Type]$resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    $task.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$manager = Await ($managerType::RequestAsync()) $managerType

$lastKey = ''

function Read-Thumbnail($reference) {
    if ($null -eq $reference) { return $null }
    try {
        $stream = Await ($reference.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        $size = [uint32]$stream.Size
        if ($size -eq 0 -or $size -gt 8MB) { return $null }
        $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
        Await ($reader.LoadAsync($size)) ([uint32]) | Out-Null
        $bytes = New-Object byte[] $size
        $reader.ReadBytes($bytes)
        $type = $stream.ContentType
        if ([string]::IsNullOrEmpty($type)) { $type = 'image/png' }
        $reader.Dispose()
        $stream.Dispose()
        return "data:$type;base64," + [Convert]::ToBase64String($bytes)
    } catch {
        return $null
    }
}

while ($true) {
    $out = @{ type = 'stopped' }
    try {
        $session = $manager.GetCurrentSession()
        if ($null -ne $session) {
            $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            $timeline = $session.GetTimelineProperties()
            $playback = $session.GetPlaybackInfo()
            $playing = $playback.PlaybackStatus -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing

            # Позиция в SMTC — снимок на момент LastUpdatedTime: досчитываем до сейчас.
            $position = $timeline.Position.TotalMilliseconds
            if ($playing -and $timeline.LastUpdatedTime.Year -gt 2000) {
                $position += ([DateTimeOffset]::Now - $timeline.LastUpdatedTime).TotalMilliseconds
            }
            $duration = ($timeline.EndTime - $timeline.StartTime).TotalMilliseconds
            if ($duration -gt 0 -and $position -gt $duration) { $position = $duration }

            # Обложку читаем и шлём только на смене трека: это десятки
            # килобайт, раз в секунду их гонять незачем. Главный процесс её помнит.
            $key = "$($props.Artist)|$($props.Title)"
            $cover = $null
            if ($key -ne $lastKey) {
                $lastKey = $key
                $cover = Read-Thumbnail $props.Thumbnail
            }

            if (-not [string]::IsNullOrEmpty($props.Title)) {
                $out = @{
                    type       = 'now-playing'
                    title      = $props.Title
                    artist     = $props.Artist
                    album      = $props.AlbumTitle
                    app        = $session.SourceAppUserModelId
                    positionMs = [math]::Max(0, [math]::Round($position))
                    durationMs = [math]::Max(0, [math]::Round($duration))
                    isPlaying  = $playing
                    key        = $key
                    coverUrl   = $cover
                }
            }
        }
    } catch {
        $out = @{ type = 'error'; message = $_.Exception.Message }
    }
    [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds 1000
}
