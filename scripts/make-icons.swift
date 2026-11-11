// Renders the Device Mirror logo (two phones, teal on navy) as PNG app icons.
//   swift scripts/make-icons.swift <outdir> <size:name>...          full-bleed squares (iOS masks the corners)
//   swift scripts/make-icons.swift --mac <outdir> <size:name>...    macOS style: rounded tile on the
//                                                                   standard icon grid, with a soft shadow
import AppKit

let navy = NSColor(srgbRed: 0x14 / 255, green: 0x1b / 255, blue: 0x2d / 255, alpha: 1)
let teal = NSColor(srgbRed: 0x6b / 255, green: 0xb3 / 255, blue: 0xa3 / 255, alpha: 1)

var macStyle = false

func render(_ size: Int) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                             hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  var s = CGFloat(size)
  var base = CGPoint.zero
  if macStyle {
    // macOS grid: an 824/1024 tile with ~22% corner radius, centred, with a soft drop shadow.
    let full = s
    let tile = full * 824 / 1024
    base = CGPoint(x: (full - tile) / 2, y: (full - tile) / 2 + full * 0.012)
    let shape = NSBezierPath(roundedRect: NSRect(x: base.x, y: base.y, width: tile, height: tile), xRadius: tile * 0.225, yRadius: tile * 0.225)
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
    shadow.shadowOffset = NSSize(width: 0, height: -full * 0.01)
    shadow.shadowBlurRadius = full * 0.02
    shadow.set()
    navy.setFill(); shape.fill()
    NSGraphicsContext.restoreGraphicsState()
    shape.addClip()
    s = tile
  } else {
    navy.setFill()
    NSRect(x: 0, y: 0, width: s, height: s).fill() // iOS masks the corners itself
  }
  // Logo drawn in a 24-unit box (same geometry as the app's SVG mark), y flipped.
  let unit = s * 0.62 / 24
  let origin = CGPoint(x: base.x + (s - 24 * unit) / 2, y: base.y + (s - 24 * unit) / 2)
  func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSRect {
    NSRect(x: origin.x + x * unit, y: origin.y + (24 - y - h) * unit, width: w * unit, height: h * unit)
  }
  let line = 1.6 * unit
  let back = NSBezierPath(roundedRect: rect(3.5, 5, 9, 15), xRadius: 2 * unit, yRadius: 2 * unit)
  back.lineWidth = line
  teal.setStroke(); back.stroke()
  let front = NSBezierPath(roundedRect: rect(11.5, 3, 9, 15), xRadius: 2 * unit, yRadius: 2 * unit)
  navy.setFill(); front.fill() // hide the back phone's line behind the front one
  teal.withAlphaComponent(0.25).setFill(); front.fill()
  front.lineWidth = line
  teal.setStroke(); front.stroke()
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

var args = Array(CommandLine.arguments.dropFirst())
if args.first == "--mac" { macStyle = true; args.removeFirst() }
let out = URL(fileURLWithPath: args[0])
for spec in args.dropFirst() {
  let parts = spec.split(separator: ":")
  try! render(Int(parts[0])!).write(to: out.appendingPathComponent(String(parts[1])))
}
print("icons written to \(out.path)")
