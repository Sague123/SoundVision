// Захват системного звука на macOS через Core Audio tap (macOS 14.2+).
//
// Что делает: создаёт «tap» всех процессов (то, что играет через колонки),
// оборачивает его в приватное агрегатное устройство и читает из него блоки.
// Блоки уходят в дескриптор 3 как «сырой» PCM: float32, два канала подряд
// (L R L R …). Формат и ошибки идут обычным JSON в stdout.
//
// Права: система один раз спросит разрешение «Запись системного звука» для
// приложения SoundVision (текст вопроса — NSAudioCaptureUsageDescription).
// Запись экрана не нужна. Если разрешения нет, tap создаётся, но приходит
// тишина — это видно в самопроверке.

import AudioToolbox
import CoreAudio
import Foundation

/// Дескриптор, куда идёт PCM. Его создаёт родитель: stdio[3].
private let pcmDescriptor: Int32 = 3

struct TapError: Error {
    let step: String
    let status: OSStatus

    var message: String { "\(step): OSStatus \(status)" }
}

func runAudioTap() -> Never {
    watchParent()
    send(["type": "hello", "helper": "macos-audio-tap", "version": "1"])

    guard #available(macOS 14.2, *) else {
        sendError("Захват системного звука требует macOS 14.2 или новее", code: "unsupported")
        exit(1)
    }

    let tap = SystemAudioTap()
    do {
        try tap.start()
    } catch let error as TapError {
        sendError("Не удалось начать захват системного звука — \(error.message)", code: "failed")
        exit(1)
    } catch {
        sendError("Не удалось начать захват системного звука: \(error.localizedDescription)", code: "failed")
        exit(1)
    }
    // Работаем, пока не закроется stdin или не сменится устройство вывода.
    dispatchMain()
}

@available(macOS 14.2, *)
final class SystemAudioTap {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let ioQueue = DispatchQueue(label: "soundvision.tap.io", qos: .userInteractive)
    // Запись в трубу — отдельно от аудио-потока: если родитель читает медленно,
    // потоку ввода-вывода нельзя вставать.
    private let writeQueue = DispatchQueue(label: "soundvision.tap.write")
    private var channels = 2
    private var nonInterleaved = false

    func start() throws {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.name = "SoundVision"
        description.uuid = UUID()
        description.isPrivate = true
        description.muteBehavior = .unmuted

        var status = AudioHardwareCreateProcessTap(description, &tapID)
        guard status == noErr else { throw TapError(step: "AudioHardwareCreateProcessTap", status: status) }

        let format = try tapFormat()
        guard format.mFormatID == kAudioFormatLinearPCM,
              format.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              format.mBitsPerChannel == 32 else {
            throw TapError(step: "формат tap не float32 (ID \(format.mFormatID), бит \(format.mBitsPerChannel))", status: -1)
        }
        channels = max(1, Int(format.mChannelsPerFrame))
        nonInterleaved = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0

        let outputUID = try defaultOutputDeviceUID()
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "SoundVision Tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: description.uuid.uuidString,
            ]],
        ]
        status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
        guard status == noErr else { throw TapError(step: "AudioHardwareCreateAggregateDevice", status: status) }

        status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, ioQueue) { [weak self] _, input, _, _, _ in
            self?.handle(input)
        }
        guard status == noErr else { throw TapError(step: "AudioDeviceCreateIOProcIDWithBlock", status: status) }

        status = AudioDeviceStart(aggregateID, procID)
        guard status == noErr else { throw TapError(step: "AudioDeviceStart", status: status) }

        send(["type": "audio-format", "sampleRate": Int(format.mSampleRate), "channels": 2])
        watchOutputDevice()
    }

    private func tapFormat() throws -> AudioStreamBasicDescription {
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &format)
        guard status == noErr else { throw TapError(step: "чтение формата tap", status: status) }
        return format
    }

    private func defaultOutputDeviceUID() throws -> String {
        var device = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
        guard status == noErr, device != kAudioObjectUnknown else {
            throw TapError(step: "устройство вывода по умолчанию", status: status)
        }

        var uid: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var uidAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        status = AudioObjectGetPropertyData(device, &uidAddress, 0, nil, &size, &uid)
        guard status == noErr, let value = uid?.takeRetainedValue() else {
            throw TapError(step: "UID устройства вывода", status: status)
        }
        return value as String
    }

    /// Сменили устройство вывода (подключили наушники) — агрегат привязан к старому.
    /// Выходим: приложение перезапустит помощника, и захват пересоберётся.
    private func watchOutputDevice() {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, DispatchQueue.main) { _, _ in
            sendError("Устройство вывода сменилось, захват перезапускается", code: "failed")
            exit(75)
        }
    }

    /// Блок из аудио-потока → интерлив float32 стерео → труба.
    private func handle(_ list: UnsafePointer<AudioBufferList>?) {
        guard let list else { return }
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
        guard buffers.count > 0 else { return }

        let frames: Int
        if nonInterleaved {
            frames = Int(buffers[0].mDataByteSize) / MemoryLayout<Float>.size
        } else {
            frames = Int(buffers[0].mDataByteSize) / (MemoryLayout<Float>.size * channels)
        }
        guard frames > 0 else { return }

        var out = [Float](repeating: 0, count: frames * 2)
        if nonInterleaved {
            guard let left = buffers[0].mData?.assumingMemoryBound(to: Float.self) else { return }
            let right = buffers.count > 1 ? buffers[1].mData?.assumingMemoryBound(to: Float.self) : nil
            for i in 0..<frames {
                out[i * 2] = left[i]
                out[i * 2 + 1] = right?[i] ?? left[i]
            }
        } else {
            guard let samples = buffers[0].mData?.assumingMemoryBound(to: Float.self) else { return }
            for i in 0..<frames {
                let l = samples[i * channels]
                out[i * 2] = l
                out[i * 2 + 1] = channels > 1 ? samples[i * channels + 1] : l
            }
        }

        let data = out.withUnsafeBufferPointer { Data(buffer: $0) }
        writeQueue.async {
            // Родитель закрыл трубу — писать некому.
            if !writeAll(pcmDescriptor, data) { exit(0) }
        }
    }
}
