// Génère assets/icon-1024.png : squircle rouge Todoist + coche + étincelles IA.
// Usage : swift scripts/make-icon.swift <chemin de sortie>

import AppKit
import CoreGraphics
import Foundation

let size: CGFloat = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "assets/icon-1024.png"

guard let ctx = CGContext(
  data: nil,
  width: Int(size),
  height: Int(size),
  bitsPerComponent: 8,
  bytesPerRow: 0,
  space: CGColorSpace(name: CGColorSpace.sRGB)!,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
  fatalError("contexte graphique indisponible")
}

ctx.setAllowsAntialiasing(true)
ctx.interpolationQuality = .high

// --- Squircle : marge façon icône macOS (le glyphe occupe ~80 % du canevas)
let inset: CGFloat = size * 0.098
let rect = CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let radius = rect.width * 0.2237
let squircle = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)

// Dégradé corail
ctx.saveGState()
ctx.addPath(squircle)
ctx.clip()
// Rouge Todoist (#E44332) encadre d'une variante claire et d'une variante profonde.
let colors = [
  CGColor(red: 0.933, green: 0.333, blue: 0.267, alpha: 1),
  CGColor(red: 0.894, green: 0.263, blue: 0.196, alpha: 1),
  CGColor(red: 0.690, green: 0.114, blue: 0.067, alpha: 1),
] as CFArray
let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                          colors: colors, locations: [0, 0.45, 1])!
ctx.drawLinearGradient(gradient,
                       start: CGPoint(x: rect.minX, y: rect.maxY),
                       end: CGPoint(x: rect.maxX, y: rect.minY),
                       options: [])

// Voile lumineux en haut à gauche
let glow = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                      colors: [CGColor(red: 1, green: 1, blue: 1, alpha: 0.11),
                               CGColor(red: 1, green: 1, blue: 1, alpha: 0)] as CFArray,
                      locations: [0, 1])!
ctx.drawRadialGradient(glow,
                       startCenter: CGPoint(x: rect.minX + rect.width * 0.28, y: rect.maxY - rect.height * 0.18),
                       startRadius: 0,
                       endCenter: CGPoint(x: rect.minX + rect.width * 0.28, y: rect.maxY - rect.height * 0.18),
                       endRadius: rect.width * 0.72,
                       options: [])
ctx.restoreGState()

// --- Coche blanche
let cx = size / 2
let cy = size / 2 - size * 0.015
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -size * 0.012), blur: size * 0.034,
              color: CGColor(red: 0.40, green: 0.09, blue: 0.04, alpha: 0.20))
ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
ctx.setLineWidth(size * 0.090)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)
ctx.move(to: CGPoint(x: cx - size * 0.180, y: cy + size * 0.000))
ctx.addLine(to: CGPoint(x: cx - size * 0.048, y: cy - size * 0.128))
ctx.addLine(to: CGPoint(x: cx + size * 0.168, y: cy + size * 0.128))
ctx.strokePath()
ctx.restoreGState()

// --- Étincelle (côté « assistant »)
func sparkle(at center: CGPoint, radius r: CGFloat, alpha: CGFloat) {
  let waist = r * 0.30
  let path = CGMutablePath()
  path.move(to: CGPoint(x: center.x, y: center.y + r))
  path.addQuadCurve(to: CGPoint(x: center.x + r, y: center.y),
                    control: CGPoint(x: center.x + waist, y: center.y + waist))
  path.addQuadCurve(to: CGPoint(x: center.x, y: center.y - r),
                    control: CGPoint(x: center.x + waist, y: center.y - waist))
  path.addQuadCurve(to: CGPoint(x: center.x - r, y: center.y),
                    control: CGPoint(x: center.x - waist, y: center.y - waist))
  path.addQuadCurve(to: CGPoint(x: center.x, y: center.y + r),
                    control: CGPoint(x: center.x - waist, y: center.y + waist))
  path.closeSubpath()
  ctx.addPath(path)
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: alpha))
  ctx.fillPath()
}

// Le clin d'oeil IA : l'etincelle a quatre branches, poser en exposant de la coche.
sparkle(at: CGPoint(x: cx + size * 0.245, y: cy + size * 0.268), radius: size * 0.070, alpha: 0.97)
sparkle(at: CGPoint(x: cx + size * 0.340, y: cy + size * 0.158), radius: size * 0.032, alpha: 0.78)

// --- Écriture du PNG
guard let image = ctx.makeImage() else { fatalError("rendu impossible") }
let rep = NSBitmapImageRep(cgImage: image)
rep.size = NSSize(width: size, height: size)
guard let data = rep.representation(using: .png, properties: [:]) else { fatalError("encodage PNG impossible") }
try data.write(to: URL(fileURLWithPath: out))
print("icône écrite : \(out)")
