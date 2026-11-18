import Foundation
import CoreAudio
import AVFoundation
import Darwin

// stdout: mono 16 kHz signed PCM16LE. stderr: bounded, non-personal status JSON.
func event(_ name: String, _ code: String? = nil) {
    var value = ["event": name]
    if let code { value["code"] = code }
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardError.write(data + Data([10]))
    }
}
func output(_ data: Data) -> Bool {
    return data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let count = Darwin.write(STDOUT_FILENO, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if count <= 0 { return false }
            offset += count
        }
        return true
    }
}
signal(SIGPIPE, SIG_IGN)
if CommandLine.arguments == [CommandLine.arguments[0], "--self-test"] {
    event("ready")
    for block in 0..<150 {
        var samples = [Int16](repeating: 0, count: 320)
        for i in samples.indices { samples[i] = Int16(sin(Double(block * 320 + i) * 2 * .pi * 440 / 16000) * 4000) }
        guard output(samples.withUnsafeBytes { Data($0) }) else { exit(1) }
        usleep(20_000)
    }
    event("stopped"); exit(0)
}
if CommandLine.arguments == [CommandLine.arguments[0], "--probe"] {
    if #available(macOS 14.2, *) { event("supported"); exit(0) }
    event("error", "unsupported"); exit(1)
}
guard CommandLine.arguments == [CommandLine.arguments[0], "--capture"] else { exit(64) }

@available(macOS 14.2, *)
final class Capture {
    let ended = DispatchSemaphore(value: 0)
    let queue = DispatchQueue(label: "voice-notes.system-audio")
    let lock = NSLock()
    var reason: String? = nil
    var stopped = false
    var tap: AudioObjectID = 0
    var device: AudioObjectID = 0
    var io: AudioDeviceIOProcID? = nil
    var timer: DispatchSourceTimer?
    var listener: AudioObjectPropertyListenerBlock?
    var converter: AVAudioConverter?
    var inputFormat: AVAudioFormat?
    let destination = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

    func stop(_ code: String? = nil) {
        lock.lock(); defer { lock.unlock() }
        if stopped { return }
        stopped = true; reason = code; ended.signal()
    }
    func check(_ status: OSStatus) throws {
        if status != noErr { throw NSError(domain: "capture", code: Int(status)) }
    }
    func run() throws {
        let description = CATapDescription(monoGlobalTapButExcludeProcesses: [])
        description.name = "Voice Notes system audio"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        try check(AudioHardwareCreateProcessTap(description, &tap))
        defer { AudioHardwareDestroyProcessTap(tap) }
        var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &format))
        guard let source = AVAudioFormat(streamDescription: &format), let converter = AVAudioConverter(from: source, to: destination) else {
            throw NSError(domain: "format", code: 1)
        }
        self.converter = converter; self.inputFormat = source
        let configuration: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Voice Notes private capture",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: description.uuid.uuidString, kAudioSubTapDriftCompensationKey: true]],
        ]
        try check(AudioHardwareCreateAggregateDevice(configuration as CFDictionary, &device))
        defer { AudioHardwareDestroyAggregateDevice(device) }
        try check(AudioDeviceCreateIOProcIDWithBlock(&io, device, queue) { [weak self] _, input, _, _, _ in
            self?.consume(input)
        })
        defer { if let io { AudioDeviceDestroyIOProcID(device, io) } }
        var outputAddress = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        let changed: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.stop("deviceChanged") }
        listener = changed
        try check(AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &outputAddress, queue, changed))
        defer { AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &outputAddress, queue, changed) }
        try check(AudioDeviceStart(device, io))
        defer { AudioDeviceStop(device, io) }
        event("ready")
        let parent = getppid()
        let timer = DispatchSource.makeTimerSource(queue: .global())
        self.timer = timer
        let deadline = Date().addingTimeInterval(3600)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            if getppid() != parent { self?.stop("disconnected") }
            else if Date() >= deadline { self?.stop("limit") }
        }
        timer.resume()
        DispatchQueue.global().async { [weak self] in
            _ = readLine(); self?.stop()
        }
        ended.wait(); timer.cancel()
    }
    func consume(_ input: UnsafePointer<AudioBufferList>) {
        guard let format = inputFormat, let converter else { return }
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        guard let first = buffers.first, first.mDataByteSize > 0 else { return }
        let frames = first.mDataByteSize / format.streamDescription.pointee.mBytesPerFrame
        guard let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { stop("captureFailed"); return }
        pcm.frameLength = frames
        let target = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
        for i in 0..<min(buffers.count, target.count) {
            guard let src = buffers[i].mData, let dst = target[i].mData else { stop("captureFailed"); return }
            memcpy(dst, src, Int(buffers[i].mDataByteSize))
        }
        let capacity = AVAudioFrameCount(ceil(Double(frames) * 16000 / format.sampleRate)) + 64
        guard let result = AVAudioPCMBuffer(pcmFormat: destination, frameCapacity: capacity) else { stop("captureFailed"); return }
        var provided = false
        var error: NSError?
        let status = converter.convert(to: result, error: &error) { _, state in
            if provided { state.pointee = .noDataNow; return nil }
            provided = true; state.pointee = .haveData; return pcm
        }
        if status == .error || error != nil { stop("captureFailed"); return }
        if result.frameLength > 0, let pointer = result.int16ChannelData {
            let bytes = Data(bytes: pointer[0], count: Int(result.frameLength) * 2)
            if !output(bytes) { stop("slowConsumer") }
        }
    }
}
if #available(macOS 14.2, *) {
    _ = fcntl(STDOUT_FILENO, F_SETFL, O_NONBLOCK)
    let capture = Capture()
    do {
        try capture.run()
        if let code = capture.reason { event("error", code); exit(1) }
        event("stopped"); exit(0)
    } catch { event("error", "captureFailed"); exit(1) }
} else { event("error", "unsupported"); exit(1) }
