// ios-capture — small macOS helper that streams the screen of a USB-connected
// iPhone/iPad. It uses the same CoreMediaIO "screen capture device" QuickTime
// uses (no developer mode, no DDI), re-encodes frames with VideoToolbox to
// low-latency H.264, and writes framed packets to stdout for the Electron app.
//
//   ios-capture stream   <udid> <name> <shortSide|0> <bitRate> <maxFps>
//   ios-capture snapshot <udid> <name>
//
// Output frames: [type u8][length u32 BE][payload]
//   1 codec   utf8 WebCodecs codec string ("avc1.640033")
//   2 size    u32 width, u32 height (encoded size)
//   3 packet  u8 flags (bit0 key frame), u64 pts in µs, Annex-B H.264 data
//   4 error   utf8 message (process exits with status 1)
//   5 image   PNG (snapshot mode)
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

func emit(_ type: UInt8, _ payload: Data) {
    outQueue.sync {
        var header = Data([type])
        var len = UInt32(payload.count).bigEndian
        header.append(Data(bytes: &len, count: 4))
        do {
            try FileHandle.standardOutput.write(contentsOf: header + payload)
        } catch {
            exit(0) // parent went away
        }
    }
}

func fail(_ message: String) -> Never {
    emit(4, Data(message.utf8))
    exit(1)
}

func be32(_ v: UInt32) -> Data { var x = v.bigEndian; return Data(bytes: &x, count: 4) }
func be64(_ v: UInt64) -> Data { var x = v.bigEndian; return Data(bytes: &x, count: 8) }

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

/// Waits for the iOS device to show up as a muxed capture device (takes a few seconds after enabling).
/// Recent macOS versions give the screen device a random uniqueID instead of the
/// UDID, so we also match by device name, and accept the only device present.
func findDevice(udid: String, name: String, timeout: TimeInterval = 12) -> AVCaptureDevice? {
    enableScreenCaptureDevices()
    let deadline = Date().addingTimeInterval(timeout)
    let wanted = normalize(udid)
    while Date() < deadline {
        let types: [AVCaptureDevice.DeviceType]
        if #available(macOS 14.0, *) { types = [.external] } else { types = [.externalUnknown] }
        let devices = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .muxed, position: .unspecified).devices
        if let d = devices.first(where: { normalize($0.uniqueID) == wanted }) { return d }
        if let d = devices.first(where: { $0.localizedName == name }) { return d }
        if devices.count == 1, name.isEmpty { return devices[0] }
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    return nil
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
    let width: Int32
    let height: Int32

    init?(width: Int32, height: Int32, bitRate: Int, fps: Int) {
        self.width = width
        self.height = height
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
                    emit(1, Data(codec.utf8))
                }
            }
            for s in sets { data.append(startCode); data.append(s) }
        }
        data.append(annexB(block))
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        let micros = UInt64(max(0, CMTimeGetSeconds(pts)) * 1_000_000)
        emit(3, Data([key ? 1 : 0]) + be64(micros) + data)
    }
}

// MARK: - Capture

final class Capture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "capture")
    private let shortSide: Int
    private let bitRate: Int
    private let minInterval: Double
    private let snapshot: Bool
    private var encoder: Encoder?
    private var sourceSize = (0, 0)
    private var lastFrame = 0.0
    private var lastPixels: CVPixelBuffer?
    private var idleTimer: DispatchSourceTimer?

    init(device: AVCaptureDevice, shortSide: Int, bitRate: Int, fps: Int, snapshot: Bool) {
        self.shortSide = shortSide
        self.bitRate = bitRate
        self.minInterval = 1.0 / Double(max(1, fps)) * 0.9
        self.snapshot = snapshot
        super.init()
        guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
            fail("Could not open the iOS screen. Unlock the device and try again.")
        }
        session.addInput(input)
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else { fail("Could not read the iOS screen stream.") }
        session.addOutput(output)
    }

    func start() {
        session.startRunning()
        // iOS only sends frames when the screen changes; re-send the last frame
        // now and then so a freshly opened window is never left blank.
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { [weak self] in
            guard let self, let px = self.lastPixels, CACurrentMediaTime() - self.lastFrame > 1 else { return }
            self.process(px, forceKey: true)
        }
        t.resume()
        idleTimer = t
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let px = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        if snapshot { writeSnapshot(px) }
        let now = CACurrentMediaTime()
        if now - lastFrame < minInterval { return }
        lastPixels = px
        process(px, forceKey: false)
    }

    private func process(_ px: CVPixelBuffer, forceKey: Bool) {
        lastFrame = CACurrentMediaTime()
        let w = CVPixelBufferGetWidth(px), h = CVPixelBufferGetHeight(px)
        var newSession = false
        if encoder == nil || sourceSize != (w, h) {
            sourceSize = (w, h)
            let (ew, eh) = targetSize(w, h)
            guard let enc = Encoder(width: Int32(ew), height: Int32(eh), bitRate: bitRate, fps: Int(1 / (minInterval / 0.9))) else {
                fail("Could not start the video encoder.")
            }
            encoder = enc
            emit(2, be32(UInt32(ew)) + be32(UInt32(eh)))
            newSession = true
        }
        encoder?.encode(px, pts: CMTime(seconds: lastFrame, preferredTimescale: 1_000_000), forceKey: forceKey || newSession)
    }

    /// Scales so the short side is at most `shortSide` (0 = native), keeping even dimensions.
    private func targetSize(_ w: Int, _ h: Int) -> (Int, Int) {
        let short = min(w, h)
        guard shortSide > 0, shortSide < short else { return (w & ~1, h & ~1) }
        let scale = Double(shortSide) / Double(short)
        return (Int((Double(w) * scale).rounded()) & ~1, Int((Double(h) * scale).rounded()) & ~1)
    }

    private func writeSnapshot(_ px: CVPixelBuffer) {
        let image = CIImage(cvPixelBuffer: px)
        let scale = min(1, 960 / max(image.extent.width, image.extent.height))
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cg = CIContext().createCGImage(scaled, from: scaled.extent) else { fail("Could not read a frame.") }
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { fail("Could not encode the frame.") }
        CGImageDestinationAddImage(dest, cg, nil)
        CGImageDestinationFinalize(dest)
        emit(5, data as Data)
        exit(0)
    }
}

// MARK: - Main

signal(SIGPIPE, SIG_IGN)
let args = CommandLine.arguments
guard args.count >= 4, ["stream", "snapshot"].contains(args[1]) else {
    FileHandle.standardError.write(Data("usage: ios-capture stream <udid> <name> <shortSide> <bitRate> <fps> | snapshot <udid> <name>\n".utf8))
    exit(2)
}

// Exit as soon as the parent closes our stdin.
Thread.detachNewThread {
    while true {
        let chunk = FileHandle.standardInput.availableData
        if chunk.isEmpty { exit(0) }
    }
}

let snapshotMode = args[1] == "snapshot"
// macOS treats the iPhone screen as a camera-class device: reading it needs
// camera permission for the app (the prompt names Device Mirror).
switch AVCaptureDevice.authorizationStatus(for: .video) {
case .denied, .restricted:
    fail("Camera access is turned off for Device Mirror. Allow it in System Settings → Privacy & Security → Camera to mirror iOS devices.")
case .notDetermined where snapshotMode:
    // Background previews never trigger the permission prompt; the first
    // Mirror click does.
    fail("Camera access has not been granted yet.")
case .notDetermined:
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .video) { granted = $0; sem.signal() }
    sem.wait()
    if !granted { fail("Camera access was not allowed. Device Mirror needs it to read the iOS screen.") }
default:
    break
}

guard let device = findDevice(udid: args[2], name: args[3]) else {
    fail("The iOS screen did not become available. Unlock the device, make sure it trusts this computer, and try again.")
}

let capture = Capture(
    device: device,
    shortSide: snapshotMode ? 0 : Int(args.count > 4 ? args[4] : "0") ?? 0,
    bitRate: snapshotMode ? 1_000_000 : Int(args.count > 5 ? args[5] : "6000000") ?? 6_000_000,
    fps: snapshotMode ? 30 : Int(args.count > 6 ? args[6] : "60") ?? 60,
    snapshot: snapshotMode)
capture.start()
if snapshotMode {
    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { fail("No frame arrived from the iOS device. Unlock it and try again.") }
}
RunLoop.main.run()
