import Foundation

// Общий вывод помощника: одна JSON-строка на сообщение в stdout.

private let outLock = NSLock()

func send(_ object: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) else { return }
    data.append(0x0A)
    outLock.lock()
    defer { outLock.unlock() }
    // Родитель закрыл трубу — писать некому.
    if !writeAll(STDOUT_FILENO, data) { exit(0) }
}

func sendError(_ message: String, code: String) {
    send(["type": "error", "message": message, "code": code])
}

/// Записать все байты в дескриптор; `false`, если запись не удалась.
func writeAll(_ descriptor: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { raw -> Bool in
        guard let base = raw.baseAddress else { return true }
        var offset = 0
        while offset < raw.count {
            let written = write(descriptor, base + offset, raw.count - offset)
            if written <= 0 { return false }
            offset += written
        }
        return true
    }
}

/// stdin закрылся — приложение-родитель закрылось, помощник тоже уходит.
func watchParent() {
    signal(SIGPIPE, SIG_IGN)
    DispatchQueue.global().async {
        while readLine(strippingNewline: false) != nil {}
        exit(0)
    }
}
