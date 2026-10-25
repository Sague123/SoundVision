// «Сейчас играет» через mediaremote-adapter (BSD-3, github.com/ungive/mediaremote-adapter).
//
// С macOS 15.4 MediaRemote отвечает только процессам Apple. Системный
// /usr/bin/perl — процесс Apple, поэтому адаптер загружается в него как
// динамическая библиотека и печатает состояние в stdout. Мы запускаем perl
// как дочерний процесс и читаем поток JSON: он показывает любой плеер,
// включая браузер с YouTube Music, и отдаёт обложку.
//
// Файлы лежат рядом с помощником: mediaremote/mediaremote-adapter.pl и
// mediaremote/MediaRemoteAdapter.framework (их кладёт scripts/build-helpers.mjs).

import Foundation

final class AdapterStream {
    private let lock = NSLock()
    private var payload: [String: Any]?
    private var buffer = Data()
    private var process: Process?
    private(set) var failure: String?

    /// Есть ли что запускать: скрипт и фреймворк на месте.
    static func locate() -> (script: String, framework: String)? {
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        let folder = executable.deletingLastPathComponent().appendingPathComponent("mediaremote")
        let script = folder.appendingPathComponent("mediaremote-adapter.pl").path
        let framework = folder.appendingPathComponent("MediaRemoteAdapter.framework").path
        let fm = FileManager.default
        guard fm.fileExists(atPath: script), fm.fileExists(atPath: framework) else { return nil }
        return (script, framework)
    }

    /// Запустить поток. `false` — не вышло (причина в `failure`).
    func start(script: String, framework: String) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
        process.arguments = [script, framework, "stream", "--no-diff", "--micros"]
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err

        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            self?.consume(chunk)
        }
        err.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            if let text = String(data: chunk, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
               !text.isEmpty {
                self?.noteStderr(text)
            }
        }
        process.terminationHandler = { [weak self] finished in
            guard let self else { return }
            self.lock.lock()
            self.payload = nil
            if self.failure == nil || finished.terminationStatus != 0 {
                let detail = self.failure.map { ": \($0)" } ?? ""
                self.failure = "адаптер завершился с кодом \(finished.terminationStatus)\(detail)"
            }
            self.lock.unlock()
        }
        do {
            try process.run()
        } catch {
            failure = "не удалось запустить /usr/bin/perl: \(error.localizedDescription)"
            return false
        }
        self.process = process
        return true
    }

    func stop() {
        if let process, process.isRunning { process.terminate() }
    }

    var isRunning: Bool { process?.isRunning ?? false }

    /// Последнее состояние потока (`nil`, пока ничего не пришло или ничего не играет).
    func current() -> [String: Any]? {
        lock.lock()
        defer { lock.unlock() }
        return payload
    }

    func lastFailure() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return failure
    }

    private func noteStderr(_ text: String) {
        lock.lock()
        failure = String(text.suffix(300))
        lock.unlock()
    }

    private func consume(_ chunk: Data) {
        buffer.append(chunk)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<newline)
            buffer.removeSubrange(buffer.startIndex...newline)
            handle(line)
        }
    }

    private func handle(_ line: Data) {
        guard !line.isEmpty,
              let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              object["type"] as? String == "data",
              let body = object["payload"] as? [String: Any] else { return }
        lock.lock()
        payload = body
        lock.unlock()
    }
}

/// Состояние адаптера → снимок трека. `nil`, если ничего не играет.
func adapterSnapshot(from body: [String: Any]) -> Snapshot? {
    guard let title = body["title"] as? String, !title.isEmpty else { return nil }
    var s = Snapshot()
    s.title = title
    s.artist = body["artist"] as? String ?? ""
    s.album = body["album"] as? String ?? ""
    s.app = body["bundleIdentifier"] as? String ?? "MediaRemote"
    s.playing = body["playing"] as? Bool ?? false
    s.durationMs = max(0, Int((number(body["durationMicros"]) ?? 0) / 1000))

    var position = (number(body["elapsedTimeMicros"]) ?? 0) / 1000
    if let stamp = number(body["timestampEpochMicros"]), stamp > 0 {
        let age = max(0, Date().timeIntervalSince1970 * 1000 - stamp / 1000)
        s.positionAgeMs = Int(age)
        let rate = number(body["playbackRate"]) ?? 1
        if s.playing && age < 6 * 3600 * 1000 { position += age * (rate > 0 ? rate : 1) }
    }
    if s.durationMs > 0 { position = min(position, Double(s.durationMs)) }
    s.positionMs = max(0, Int(position))

    if let encoded = body["artworkData"] as? String, let art = Data(base64Encoded: encoded), !art.isEmpty {
        s.artwork = art
        s.artworkMime = body["artworkMimeType"] as? String ?? mimeType(for: art)
    }
    return s
}

private func number(_ value: Any?) -> Double? {
    if let n = value as? NSNumber { return n.doubleValue }
    return nil
}
