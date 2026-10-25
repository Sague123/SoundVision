// Помощник «Сейчас играет» для macOS.
//
// Печатает в stdout по одному JSON на строку — тот же формат, что у
// Windows-помощника (src/shared/now-playing.ts).
//
// Источники по порядку:
//   1. MediaRemote (приватный фреймворк, тот же, что кормит Пункт управления):
//      отдаёт трек любого плеера, включая Chrome с YouTube Music.
//      Начиная с macOS 15.4 система отвечает на него только программам Apple —
//      тогда он молчит, и это видно в отчёте.
//   2. AppleScript для Spotify и Music — запасной путь для этих двух плееров.
//      Приложения не запускаем: сначала проверяем, что они уже работают.
//
// Завершается, когда закрывается stdin (приложение-родитель закрылось).

import AppKit
import Foundation

// Тот же исполняемый файл умеет снимать системный звук: `--audio-tap`.
if CommandLine.arguments.contains("--audio-tap") {
    runAudioTap()
}

// MARK: - Снимок трека

struct Snapshot {
    var title = ""
    var artist = ""
    var album = ""
    var app = ""
    var durationMs = 0
    var positionMs = 0
    var positionAgeMs = 0
    var playing = false
    var artwork: Data?
    var artworkMime: String?
}

func mimeType(for data: Data) -> String {
    if data.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
    if data.starts(with: [0xFF, 0xD8]) { return "image/jpeg" }
    return "image/jpeg"
}

// MARK: - MediaRemote

final class MediaRemote {
    typealias GetInfo = @convention(c) (DispatchQueue, @escaping (CFDictionary?) -> Void) -> Void
    typealias GetPid = @convention(c) (DispatchQueue, @escaping (Int32) -> Void) -> Void

    private let getInfo: GetInfo?
    private let getPid: GetPid?

    var available: Bool { getInfo != nil }

    init() {
        let url = URL(fileURLWithPath: "/System/Library/PrivateFrameworks/MediaRemote.framework") as CFURL
        guard let bundle = CFBundleCreate(kCFAllocatorDefault, url) else {
            getInfo = nil
            getPid = nil
            return
        }
        getInfo = MediaRemote.symbol(bundle, "MRMediaRemoteGetNowPlayingInfo")
        getPid = MediaRemote.symbol(bundle, "MRMediaRemoteGetNowPlayingApplicationPID")
    }

    private static func symbol<T>(_ bundle: CFBundle, _ name: String) -> T? {
        guard let pointer = CFBundleGetFunctionPointerForName(bundle, name as CFString) else { return nil }
        return unsafeBitCast(pointer, to: T.self)
    }

    enum Reply {
        /// Система ответила; словарь пуст, если ничего не играет.
        case answered([String: Any])
        /// Ответа нет или он `nil`: фреймворк недоступен этой программе.
        case silent
    }

    func fetch() -> Reply {
        guard let getInfo else { return .silent }
        let semaphore = DispatchSemaphore(value: 0)
        var reply: Reply = .silent
        getInfo(DispatchQueue.global()) { dictionary in
            if let dictionary = dictionary as? [String: Any] { reply = .answered(dictionary) }
            semaphore.signal()
        }
        if semaphore.wait(timeout: .now() + 1.5) == .timedOut { return .silent }
        return reply
    }

    func appIdentifier() -> String {
        guard let getPid else { return "MediaRemote" }
        let semaphore = DispatchSemaphore(value: 0)
        var pid: Int32 = 0
        getPid(DispatchQueue.global()) { value in
            pid = value
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + 1.0)
        guard pid > 0, let app = NSRunningApplication(processIdentifier: pid) else { return "MediaRemote" }
        return app.bundleIdentifier ?? app.localizedName ?? "MediaRemote"
    }

    func snapshot(from info: [String: Any]) -> Snapshot? {
        guard let title = info["kMRMediaRemoteNowPlayingInfoTitle"] as? String, !title.isEmpty else { return nil }
        var s = Snapshot()
        s.title = title
        s.artist = info["kMRMediaRemoteNowPlayingInfoArtist"] as? String ?? ""
        s.album = info["kMRMediaRemoteNowPlayingInfoAlbum"] as? String ?? ""
        let duration = info["kMRMediaRemoteNowPlayingInfoDuration"] as? Double ?? 0
        let elapsed = info["kMRMediaRemoteNowPlayingInfoElapsedTime"] as? Double ?? 0
        let rate = info["kMRMediaRemoteNowPlayingInfoPlaybackRate"] as? Double ?? 0
        s.playing = rate > 0
        s.durationMs = max(0, Int(duration * 1000))
        // Позиция — снимок на момент Timestamp; пока играет, доводим до «сейчас».
        var position = elapsed * 1000
        if let stamp = info["kMRMediaRemoteNowPlayingInfoTimestamp"] as? Date {
            let age = max(0, Date().timeIntervalSince(stamp)) * 1000
            s.positionAgeMs = Int(age)
            if s.playing && age < 6 * 3600 * 1000 { position += age * rate }
        }
        if s.durationMs > 0 { position = min(position, Double(s.durationMs)) }
        s.positionMs = max(0, Int(position))
        if let art = info["kMRMediaRemoteNowPlayingInfoArtworkData"] as? Data, !art.isEmpty {
            s.artwork = art
            s.artworkMime = info["kMRMediaRemoteNowPlayingInfoArtworkMIMEType"] as? String ?? mimeType(for: art)
        }
        s.app = appIdentifier()
        return s
    }
}

// MARK: - AppleScript (запасной путь для Spotify и Music)

enum Player {
    case spotify
    case music

    var bundleId: String { self == .spotify ? "com.spotify.client" : "com.apple.Music" }
    var appName: String { self == .spotify ? "Spotify" : "Music" }

    /// Поля через табуляцию: название, артист, альбом, длительность, позиция, состояние, ссылка на обложку.
    var script: String {
        switch self {
        case .spotify:
            return """
            tell application "Spotify"
              if player state is stopped then return "stopped"
              set t to current track
              return (name of t) & tab & (artist of t) & tab & (album of t) & tab & ((duration of t) as string) & tab & ((player position) as string) & tab & (player state as string) & tab & (artwork url of t)
            end tell
            """
        case .music:
            return """
            tell application "Music"
              if player state is stopped then return "stopped"
              set t to current track
              return (name of t) & tab & (artist of t) & tab & (album of t) & tab & ((duration of t) as string) & tab & ((player position) as string) & tab & (player state as string) & tab & ""
            end tell
            """
        }
    }
}

func isRunning(_ player: Player) -> Bool {
    NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == player.bundleId }
}

/// Число из AppleScript: в некоторых локалях десятичный разделитель — запятая.
func parseNumber(_ text: String) -> Double {
    Double(text.replacingOccurrences(of: ",", with: ".").trimmingCharacters(in: .whitespaces)) ?? 0
}

func runScript(_ source: String) -> (output: String?, error: String?) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    process.arguments = ["-e", source]
    let out = Pipe()
    let err = Pipe()
    process.standardOutput = out
    process.standardError = err
    do { try process.run() } catch { return (nil, error.localizedDescription) }
    process.waitUntilExit()
    let output = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
    let error = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return (output, process.terminationStatus == 0 ? nil : (error?.isEmpty == false ? error : "osascript завершился с ошибкой"))
}

/// Ссылки на обложки Spotify — по одной скачиваем и запоминаем.
var artworkCache: [String: Data] = [:]

func downloadArtwork(_ link: String) -> Data? {
    if let cached = artworkCache[link] { return cached }
    guard let url = URL(string: link), url.scheme == "https" else { return nil }
    let semaphore = DispatchSemaphore(value: 0)
    var result: Data?
    URLSession.shared.dataTask(with: url) { data, _, _ in
        result = data
        semaphore.signal()
    }.resume()
    _ = semaphore.wait(timeout: .now() + 4)
    if let result, !result.isEmpty, result.count < 8_000_000 { artworkCache[link] = result }
    return artworkCache[link]
}

var scriptErrors = Set<String>()

func appleScriptSnapshot(_ player: Player) -> Snapshot? {
    guard isRunning(player) else { return nil }
    let (output, error) = runScript(player.script)
    if let error {
        // Одну и ту же ошибку (обычно — нет разрешения на автоматизацию) не повторяем.
        if scriptErrors.insert(error).inserted {
            let blocked = error.contains("-1743") || error.lowercased().contains("not authorized")
            sendError("\(player.appName): \(error)", code: blocked ? "blocked" : "failed")
        }
        return nil
    }
    guard let output, output != "stopped" else { return nil }
    let fields = output.components(separatedBy: "\t")
    guard fields.count >= 7, !fields[0].isEmpty else { return nil }

    var s = Snapshot()
    s.title = fields[0]
    s.artist = fields[1]
    s.album = fields[2]
    // Spotify отдаёт длительность в миллисекундах, Music — в секундах.
    let duration = parseNumber(fields[3])
    s.durationMs = Int(player == .spotify ? duration : duration * 1000)
    s.positionMs = Int(parseNumber(fields[4]) * 1000)
    s.playing = fields[5].lowercased().contains("play")
    s.app = player.bundleId
    if player == .spotify, !fields[6].isEmpty, let art = downloadArtwork(fields[6]) {
        s.artwork = art
        s.artworkMime = mimeType(for: art)
    }
    return s
}

// MARK: - Основной цикл

watchParent()

let remote = MediaRemote()
var mode = remote.available ? "macos-mediaremote" : "macos-applescript"
send(["type": "hello", "helper": mode, "version": "1"])
if !remote.available {
    sendError("MediaRemote не найден в системе; работает только AppleScript (Spotify, Music)", code: "unsupported")
}

var warnedBlocked = false
var lastKey = ""
var coverSent = false

func orNull(_ value: String?) -> Any {
    if let value { return value }
    return NSNull()
}

func switchMode(to newMode: String) {
    guard newMode != mode else { return }
    mode = newMode
    send(["type": "hello", "helper": mode, "version": "1"])
}

while true {
    var snapshot: Snapshot?
    var mediaRemoteSilent = false

    switch remote.fetch() {
    case .answered(let info):
        snapshot = remote.snapshot(from: info)
        if snapshot != nil { switchMode(to: "macos-mediaremote") }
    case .silent:
        // Молчание само по себе ничего не доказывает: когда ничего не играет,
        // система тоже может не ответить. О блокировке скажем, только если
        // плеер играет, а MediaRemote молчит.
        mediaRemoteSilent = true
    }

    if snapshot == nil {
        // MediaRemote пуст или закрыт — пробуем Spotify, потом Music.
        for player in [Player.spotify, Player.music] {
            if let found = appleScriptSnapshot(player), found.playing || snapshot == nil {
                snapshot = found
                if found.playing { break }
            }
        }
        if let found = snapshot {
            switchMode(to: "macos-applescript")
            if mediaRemoteSilent && found.playing && remote.available && !warnedBlocked {
                warnedBlocked = true
                sendError("MediaRemote молчит, хотя \(found.app) играет: в macOS 15.4+ он закрыт для сторонних программ. Данные идут через AppleScript — Chrome с YouTube Music при этом не виден", code: "blocked")
            }
        }
    }

    if let s = snapshot {
        let key = "\(s.artist)|\(s.title)|\(s.album)|\(s.durationMs / 2000)"
        if key != lastKey {
            lastKey = key
            coverSent = false
        }
        var cover: String?
        var mime: String?
        if !coverSent, let art = s.artwork {
            cover = art.base64EncodedString()
            mime = s.artworkMime ?? mimeType(for: art)
            coverSent = true
        }
        send([
            "type": "track",
            "artist": s.artist, "title": s.title, "album": s.album, "app": s.app,
            "durationMs": s.durationMs, "positionMs": s.positionMs,
            "positionAt": Int(Date().timeIntervalSince1970 * 1000),
            "positionAgeMs": s.positionAgeMs,
            "isPlaying": s.playing,
            "cover": orNull(cover),
            "coverMime": orNull(mime),
        ])
    } else {
        lastKey = ""
        send(["type": "stopped"])
    }

    Thread.sleep(forTimeInterval: 0.5)
}
