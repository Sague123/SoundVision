// Помощник «Сейчас играет» для Windows.
//
// Читает System Media Transport Controls — тот же источник, что показывает
// плашку громкости Windows. Spotify, Chrome с YouTube Music и большинство
// плееров публикуют туда название, артиста, обложку и позицию.
//
// Печатает в stdout по одному JSON на строку (формат — src/shared/now-playing.ts).
// Завершается, когда закрывается stdin: значит, приложение-родитель закрылось.

using System.Text;
using System.Text.Json;
using Windows.Media.Control;

namespace SoundVision.NowPlaying;

internal sealed record Hello(string Type, string Helper, string Version);

internal sealed record Stopped(string Type);

internal sealed record Failure(string Type, string Message, string Code);

internal sealed record Track(
    string Type,
    string Artist,
    string Title,
    string Album,
    string App,
    long DurationMs,
    long PositionMs,
    long PositionAt,
    long PositionAgeMs,
    bool IsPlaying,
    string? Cover,
    string? CoverMime);

internal static class Program
{
    private const int PollMs = 500;
    private const int MaxCoverBytes = 8_000_000;
    // Обложка бывает не готова в момент смены трека — пробуем ещё несколько секунд.
    private const int MaxCoverTries = 20;

    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly object Gate = new();
    private static StreamWriter? _out;

    private static async Task<int> Main()
    {
        _out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
        _ = Task.Run(WatchParent);
        Send(new Hello("hello", "windows-smtc", "1"));

        GlobalSystemMediaTransportControlsSessionManager manager;
        try
        {
            manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        }
        catch (Exception error)
        {
            Send(new Failure("error", $"SMTC недоступен: {error.Message}", "unsupported"));
            return 1;
        }

        var lastKey = "";
        var coverTries = 0;
        var coverSent = false;
        var lastError = "";

        while (true)
        {
            try
            {
                var session = Pick(manager);
                var props = session is null ? null : await session.TryGetMediaPropertiesAsync();
                if (session is null || props is null || string.IsNullOrWhiteSpace(props.Title))
                {
                    lastKey = "";
                    Send(new Stopped("stopped"));
                }
                else
                {
                    var timeline = session.GetTimelineProperties();
                    var playing = session.GetPlaybackInfo().PlaybackStatus ==
                                  GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
                    var duration = Math.Max(0, (long)(timeline.EndTime - timeline.StartTime).TotalMilliseconds);

                    var key = $"{props.Artist}|{props.Title}|{props.AlbumTitle}|{duration / 2000}";
                    if (key != lastKey)
                    {
                        lastKey = key;
                        coverTries = 0;
                        coverSent = false;
                    }

                    string? cover = null;
                    string? mime = null;
                    if (!coverSent && coverTries < MaxCoverTries)
                    {
                        coverTries++;
                        (cover, mime) = await ReadCover(props);
                        if (cover is not null) coverSent = true;
                    }

                    // Позиция в SMTC — снимок на момент LastUpdatedTime. Если плеер играет,
                    // доводим снимок до «сейчас» здесь, где известен настоящий возраст.
                    var now = DateTimeOffset.UtcNow;
                    var position = (timeline.Position - timeline.StartTime).TotalMilliseconds;
                    long age = 0;
                    var updated = timeline.LastUpdatedTime;
                    if (updated.Year > 2000)
                    {
                        age = Math.Max(0, (long)(now - updated).TotalMilliseconds);
                        if (playing && age < 6 * 3600 * 1000L) position += age;
                    }
                    if (duration > 0 && position > duration) position = duration;

                    Send(new Track(
                        "track", props.Artist ?? "", props.Title, props.AlbumTitle ?? "",
                        session.SourceAppUserModelId ?? "", duration, Math.Max(0, (long)position),
                        now.ToUnixTimeMilliseconds(), age, playing, cover, mime));
                }
            }
            catch (Exception error)
            {
                // Одну и ту же ошибку не повторяем каждые полсекунды.
                if (error.Message != lastError)
                {
                    lastError = error.Message;
                    Send(new Failure("error", error.Message, "failed"));
                }
            }

            await Task.Delay(PollMs);
        }
    }

    /// Играющий сеанс важнее молчащего; из играющих — тот, что система считает текущим.
    private static GlobalSystemMediaTransportControlsSession? Pick(GlobalSystemMediaTransportControlsSessionManager manager)
    {
        var current = manager.GetCurrentSession();
        if (current is not null && IsPlaying(current)) return current;
        foreach (var session in manager.GetSessions())
        {
            if (IsPlaying(session)) return session;
        }
        return current ?? manager.GetSessions().FirstOrDefault();
    }

    private static bool IsPlaying(GlobalSystemMediaTransportControlsSession session) =>
        session.GetPlaybackInfo().PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;

    private static async Task<(string?, string?)> ReadCover(GlobalSystemMediaTransportControlsSessionMediaProperties props)
    {
        var reference = props.Thumbnail;
        if (reference is null) return (null, null);
        using var stream = await reference.OpenReadAsync();
        if (stream.Size == 0 || stream.Size > MaxCoverBytes) return (null, null);
        using var input = stream.AsStreamForRead();
        using var buffer = new MemoryStream((int)stream.Size);
        await input.CopyToAsync(buffer);
        var mime = string.IsNullOrEmpty(stream.ContentType) ? "image/jpeg" : stream.ContentType;
        return (Convert.ToBase64String(buffer.ToArray()), mime);
    }

    private static void Send(object message)
    {
        try
        {
            lock (Gate) _out!.WriteLine(JsonSerializer.Serialize(message, message.GetType(), Json));
        }
        catch (IOException)
        {
            // Родитель закрыл трубу — писать некому.
            Environment.Exit(0);
        }
    }

    private static async Task WatchParent()
    {
        try
        {
            await Console.OpenStandardInput().CopyToAsync(Stream.Null);
        }
        catch (IOException)
        {
        }
        Environment.Exit(0);
    }
}
