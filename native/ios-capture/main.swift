// ios-capture — macOS helper that streams the screen of USB-connected
// iPhones/iPads. It uses the CoreMediaIO "screen capture device" QuickTime
// uses (no developer mode, no DDI), re-encodes frames with VideoToolbox to
// low-latency H.264, and writes framed packets to stdout.
//
// It runs as ONE long-lived process for the whole app session: when the
// process that enabled screen capture exits, macOS tears the iPhone's capture
// mode down and bringing it back takes 15–60 s. So the app starts the helper
// once and sends it commands instead of spawning one process per request.
//
// Commands (stdin, one JSON object per line):
//   {"cmd":"stream","id":1,"udid":"…","name":"iPhone 13","shortSide":1080,"bitRate":6000000,"fps":60}
//   {"cmd":"stop","id":1}
//   {"cmd":"snapshot","id":2,"udid":"…","name":"iPhone 13","maxSide":480}
//
// Output frames (stdout): [type u8][id u32 BE][length u32 BE][payload]
//   1 codec   utf8 WebCodecs codec string ("avc1.640033")
//   2 size    u32 width, u32 height (encoded size)
//   3 packet  u8 flags (bit0 key frame), u64 pts in µs, Annex-B H.264 data
//   4 error   utf8 message (the request is over)
//   5 image   JPEG (snapshot result, scaled to maxSide; the request is over)
//
// The helper exits when stdin closes, so it never outlives the app.

import AVFoundation
import CoreImage
import CoreMediaIO
import Foundation
import ImageIO
import UniformTypeIdentifiers
import VideoToolbox

// MARK: - Output

let outQueue = DispatchQueue(label: "out")

func be32(_ v: UInt32) -> Data { var x = v.bigEndian; return Data(bytes: &x, count: 4) }
func be64(_ v: UInt64) -> Data { var x = v.bigEndian; return Data(bytes: &x, count: 8) }

func emit(_ type: UInt8, _ id: UInt32, _ payload: Data) {
    outQueue.sync {
        let frame = Data([type]) + be32(id) + be32(UInt32(payload.count)) + payload
        do { try FileHandle.standardOutput.write(contentsOf: frame) } catch { exit(0) } // parent went away
    }
}

let debugEnabled = ProcessInfo.processInfo.environment["DM_DEBUG"] != nil
func debug(_ s: String) { if debugEnabled { FileHandle.standardError.write(Data("[ios-capture] \(s)\n".utf8)) } }

// MARK: - Device discovery

func enableScreenCaptureDevices() {
    var prop = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
    var allow: UInt32 = 1
    CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &prop, 0, nil, UInt32(MemoryLayout<UInt32>.size), &allow)
}

func normalize(_ id: String) -> String { id.replacingOccurrences(of: "-", with: "").lowercased() }

/// Recent macOS versions give the screen device a random uniqueID instead of
/// the UDID, so we also match by device name. Devices appear a few seconds
/// after plugging in, so this polls — on the main run loop: AVFoundation only
/// updates its device list there (polling from another thread never sees it).
func findDevice(udid: String, name: String, timeout: TimeInterval, _ done: @escaping (AVCaptureDevice?) -> Void) {
    let deadline = Date().addingTimeInterval(timeout)
    let wanted = normalize(udid)
    let types: [AVCaptureDevice.DeviceType]
    if #available(macOS 14.0, *) { types = [.external] } else { types = [.externalUnknown] }
    func attempt() {
        let devices = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .muxed, position: .unspecified).devices
        if let d = devices.first(where: { normalize($0.uniqueID) == wanted }) ?? devices.first(where: { $0.localizedName == name }) {
            done(d)
        } else if Date() >= deadline {
            done(nil)
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: attempt)
        }
    }
    attempt()
}

// MARK: - H.264 helpers

func codecString(sps: Data) -> String {
    guard sps.count >= 4 else { return "avc1.42e01f" }
    return String(format: "avc1.%02x%02x%02x", sps[1], sps[2], sps[3])
}

let startCode = Data([0, 0, 0, 1])

/// Converts AVCC (4-byte length prefixed) NAL units to Annex B.
func annexB(_ block: CMBlockBuffer) -> Data {
    var length = 0
    var pointer: UnsafeMutablePointer<CChar>?
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
          let base = pointer else { return Data() }
    var out = Data(capacity: length + 16)
    var offset = 0
    while offset + 4 <= length {
        let nalLength = base.advanced(by: offset).withMemoryRebound(to: UInt8.self, capacity: 4) { p in
            Int(p[0]) << 24 | Int(p[1]) << 16 | Int(p[2]) << 8 | Int(p[3])
        }
        offset += 4
        guard nalLength > 0, offset + nalLength <= length else { break }
        out.append(startCode)
        out.append(Data(bytes: base.advanced(by: offset), count: nalLength))
        offset += nalLength
    }
    return out
}

// MARK: - Encoder

final class Encoder {
    private var session: VTCompressionSession?
    private var lastCodec = ""
    private let id: UInt32

    init?(id: UInt32, width: Int32, height: Int32, bitRate: Int, fps: Int) {
        self.id = id
        let spec: CFDictionary = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true] as CFDictionary
        var s: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: nil, width: width, height: height, codecType: kCMVideoCodecType_H264,
            encoderSpecification: spec, imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: nil, refcon: nil, compressionSessionOut: &s)
        guard status == noErr, let session = s else { return nil }
        let props: [CFString: Any] = [
            kVTCompressionPropertyKey_RealTime: true,
            kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_High_AutoLevel,
            kVTCompressionPropertyKey_AllowFrameReordering: false,
            kVTCompressionPropertyKey_AverageBitRate: bitRate,
            kVTCompressionPropertyKey_ExpectedFrameRate: fps,
            kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 2,
            kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality: true,
        ]
        for (k, v) in props { VTSessionSetProperty(session, key: k, value: v as CFTypeRef) }
        VTCompressionSessionPrepareToEncodeFrames(session)
        self.session = session
    }

    deinit {
        if let s = session { VTCompressionSessionInvalidate(s) }
    }

    func encode(_ pixels: CVPixelBuffer, pts: CMTime, forceKey: Bool) {
        guard let session else { return }
        let opts: CFDictionary? = forceKey ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        VTCompressionSessionEncodeFrame(session, imageBuffer: pixels, presentationTimeStamp: pts, duration: .invalid,
                                        frameProperties: opts, infoFlagsOut: nil) { [weak self] status, _, sample in
            guard status == noErr, let sample, let self else { return }
            self.output(sample)
        }
    }

    private func output(_ sample: CMSampleBuffer) {
        guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let key = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        var data = Data()
        if key, let fmt = CMSampleBufferGetFormatDescription(sample) {
            var sets: [Data] = []
            for i in 0..<2 {
                var ptr: UnsafePointer<UInt8>?
                var size = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: &ptr,
                                                                       parameterSetSizeOut: &size, parameterSetCountOut: nil,
                                                                       nalUnitHeaderLengthOut: nil) == noErr, let ptr {
                    sets.append(Data(bytes: ptr, count: size))
                }
            }
            if let sps = sets.first {
                let codec = codecString(sps: sps)
                if codec != lastCodec {
                    lastCodec = codec
                    emit(1, id, Data(codec.utf8))
                }
            }
            for s in sets { data.append(startCode); data.append(s) }
        }
        data.append(annexB(block))
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        let micros = UInt64(max(0, CMTimeGetSeconds(pts)) * 1_000_000)
        emit(3, id, Data([key ? 1 : 0]) + be64(micros) + data)
    }
}

// MARK: - Device capture (one per physical device, shared by its requests)

/// What a request wants from a device capture.
final class Request {
    let id: UInt32
    let snapshot: Bool
    let shortSide: Int
    let bitRate: Int
    let minInterval: Double
    var encoder: Encoder?
    var sourceSize = (0, 0)
    var lastFrame = 0.0
    /** Snapshot: longest side of the JPEG (0 = 960). */
    var maxSide = 0

    init(id: UInt32, snapshot: Bool, shortSide: Int, bitRate: Int, fps: Int) {
        self.id = id
        self.snapshot = snapshot
        self.shortSide = shortSide
        self.bitRate = bitRate
        self.minInterval = 1.0 / Double(max(1, fps)) * 0.9
    }

    var fps: Int { Int((0.9 / minInterval).rounded()) }
}

final class DeviceCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let key: String
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "capture")
    private var requests: [UInt32: Request] = [:] // touched on `queue` only
    private var lastPixels: CVPixelBuffer?
    private var lastFrameTime = 0.0
    private var idleTimer: DispatchSourceTimer?
    private var frameCount = 0
    var onEmpty: (() -> Void)?

    init?(device: AVCaptureDevice, key: String) {
        self.key = key
        super.init()
        guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return nil }
        session.addInput(input)
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else { return nil }
        session.addOutput(output)
        NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { n in
            debug("runtime error \(String(describing: n.userInfo?[AVCaptureSessionErrorKey]))")
        }
        queue.sync { restart() }
        debug("capture \(device.localizedName) running=\(session.isRunning)")
    }

    /// Starts the session and the idle re-send timer (on `queue`).
    private func restart() {
        running = true
        session.startRunning()
        // iOS only sends frames when the screen changes; re-send the last frame
        // now and then so a freshly opened window is never left blank.
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { [weak self] in
            guard let self, let px = self.lastPixels, CACurrentMediaTime() - self.lastFrameTime > 1 else { return }
            for r in self.requests.values where !r.snapshot { self.encode(px, for: r, forceKey: true) }
        }
        t.resume()
        idleTimer = t
    }

    private var running = true

    /// True when no request uses this capture (safe to forget it).
    var isIdle: Bool { queue.sync { requests.isEmpty } }

    func add(_ r: Request) {
        queue.async {
            if !self.running { self.restart() }
            self.requests[r.id] = r
            // A snapshot can be answered right away from the last frame.
            if r.snapshot, let px = self.lastPixels { self.finishSnapshot(r, px) }
            else if !r.snapshot, let px = self.lastPixels { self.encode(px, for: r, forceKey: true) }
        }
    }

    func remove(_ id: UInt32) {
        queue.async {
            self.requests[id] = nil
            if self.requests.isEmpty { self.shutdown() }
        }
    }

    /// Stops the capture session (the process — and thus screen-capture mode — stays up).
    private func shutdown() {
        running = false
        idleTimer?.cancel()
        idleTimer = nil
        lastPixels = nil
        session.stopRunning()
        debug("capture \(key) stopped")
        DispatchQueue.main.async { self.onEmpty?() }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let px = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        frameCount += 1
        if frameCount <= 2 || frameCount % 300 == 0 { debug("frame \(frameCount)") }
        lastPixels = px
        lastFrameTime = CACurrentMediaTime()
        for r in requests.values {
            if r.snapshot { finishSnapshot(r, px); continue }
            if lastFrameTime - r.lastFrame < r.minInterval { continue }
            encode(px, for: r, forceKey: false)
        }
    }

    private func encode(_ px: CVPixelBuffer, for r: Request, forceKey: Bool) {
        r.lastFrame = CACurrentMediaTime()
        let w = CVPixelBufferGetWidth(px), h = CVPixelBufferGetHeight(px)
        var fresh = false
        if r.encoder == nil || r.sourceSize != (w, h) {
            r.sourceSize = (w, h)
            let (ew, eh) = targetSize(w, h, shortSide: r.shortSide)
            guard let enc = Encoder(id: r.id, width: Int32(ew), height: Int32(eh), bitRate: r.bitRate, fps: r.fps) else {
                emit(4, r.id, Data("Could not start the video encoder.".utf8))
                requests[r.id] = nil
                return
            }
            r.encoder = enc
            emit(2, r.id, be32(UInt32(ew)) + be32(UInt32(eh)))
            fresh = true
        }
        r.encoder?.encode(px, pts: CMTime(seconds: r.lastFrame, preferredTimescale: 1_000_000), forceKey: forceKey || fresh)
    }

    private func finishSnapshot(_ r: Request, _ px: CVPixelBuffer) {
        requests[r.id] = nil
        let image = CIImage(cvPixelBuffer: px)
        // Card previews are small: scale down here and send a JPEG, instead of
        // a full-size PNG that the app would shrink anyway.
        let longEdge = r.maxSide > 0 ? CGFloat(r.maxSide) : 960
        let scale = min(1, longEdge / max(image.extent.width, image.extent.height))
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let data = NSMutableData()
        if let cg = CIContext().createCGImage(scaled, from: scaled.extent),
           let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) {
            CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
            CGImageDestinationFinalize(dest)
            emit(5, r.id, data as Data)
        } else {
            emit(4, r.id, Data("Could not read a frame.".utf8))
        }
        if requests.isEmpty { shutdown() }
    }
}

/// Scales so the short side is at most `shortSide` (0 = native), keeping even dimensions.
func targetSize(_ w: Int, _ h: Int, shortSide: Int) -> (Int, Int) {
    let short = min(w, h)
    guard shortSide > 0, shortSide < short else { return (w & ~1, h & ~1) }
    let scale = Double(shortSide) / Double(short)
    return (Int((Double(w) * scale).rounded()) & ~1, Int((Double(h) * scale).rounded()) & ~1)
}

// MARK: - Command handling (main thread)

var captures: [String: DeviceCapture] = [:] // by normalized UDID
var owner: [UInt32: String] = [:] // request id → capture key

func cameraAccess(prompt: Bool, _ done: @escaping (String?) -> Void) {
    // macOS treats the iPhone screen as a camera-class device.
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
        done(nil)
    case .notDetermined where prompt:
        AVCaptureDevice.requestAccess(for: .video) { granted in
            DispatchQueue.main.async { done(granted ? nil : "Camera access was not allowed. Device Mirror needs it to read the iOS screen.") }
        }
    case .notDetermined:
        done("Camera access has not been granted yet.") // background previews never prompt
    default:
        done("Camera access is turned off for Device Mirror. Allow it in System Settings → Privacy & Security → Camera to mirror iOS devices.")
    }
}

func start(_ r: Request, udid: String, name: String) {
    cameraAccess(prompt: !r.snapshot) { error in
        if let error { emit(4, r.id, Data(error.utf8)); return }
        let key = normalize(udid)
        if let cap = captures[key] {
            owner[r.id] = key
            cap.add(r)
            return
        }
        // A stream waits up to 10 minutes: a sleeping iPhone offers no screen until
        // it is woken (the app shows a hint meanwhile).
        findDevice(udid: udid, name: name, timeout: r.snapshot ? 8 : 600) { device in
                if let cap = captures[key] { owner[r.id] = key; cap.add(r); return } // raced with another request
                guard let device, let cap = DeviceCapture(device: device, key: key) else {
                    emit(4, r.id, Data("The iOS screen did not become available. Unlock the device, make sure it trusts this computer, and try again.".utf8))
                    return
                }
                cap.onEmpty = { [weak cap] in
                    // Forget idle captures so a re-plugged device gets a fresh one.
                    if let cap, captures[key] === cap, cap.isIdle { captures[key] = nil }
                }
                captures[key] = cap
                owner[r.id] = key
                cap.add(r)
        }
    }
}

func handle(_ line: String) {
    guard let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
          let cmd = obj["cmd"] as? String, let idNum = obj["id"] as? NSNumber else { return }
    let id = idNum.uint32Value
    let udid = obj["udid"] as? String ?? ""
    let name = obj["name"] as? String ?? ""
    debug("cmd \(cmd) id=\(id)")
    switch cmd {
    case "stream":
        let r = Request(id: id, snapshot: false, shortSide: (obj["shortSide"] as? NSNumber)?.intValue ?? 0,
                        bitRate: (obj["bitRate"] as? NSNumber)?.intValue ?? 6_000_000, fps: (obj["fps"] as? NSNumber)?.intValue ?? 60)
        start(r, udid: udid, name: name)
    case "snapshot":
        let r = Request(id: id, snapshot: true, shortSide: 0, bitRate: 0, fps: 1)
        r.maxSide = (obj["maxSide"] as? NSNumber)?.intValue ?? 0
        start(r, udid: udid, name: name)
    case "stop":
        if let key = owner.removeValue(forKey: id) { captures[key]?.remove(id) }
    default:
        break
    }
}

// MARK: - Main

signal(SIGPIPE, SIG_IGN)
enableScreenCaptureDevices()

Thread.detachNewThread {
    var buffer = Data()
    while true {
        let chunk = FileHandle.standardInput.availableData
        if chunk.isEmpty { exit(0) } // parent closed stdin
        buffer.append(chunk)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self)
            buffer.removeSubrange(buffer.startIndex...nl)
            DispatchQueue.main.async { handle(line) }
        }
    }
}

RunLoop.main.run()
