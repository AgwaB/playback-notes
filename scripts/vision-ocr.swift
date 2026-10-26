// Apple Vision text recognizer for the video-summarizer OCR path (macOS only).
// Build once:  swiftc -O -o "$PRIVATE/vision-ocr" scripts/vision-ocr.swift
// Usage:       vision-ocr <image> [lang,lang]   e.g. vision-ocr frame.jpg ko-KR,en-US
// Output:      one TSV line per recognized string: confidence, x, y, width, height, text
//              (Vision normalized coordinates, origin bottom-left). Exit 2 usage, 3 recognition error.
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
func fail(_ message: String, _ code: Int32) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}
guard args.count >= 2 else { fail("usage: vision-ocr <image> [languages]", 2) }
guard let image = NSImage(contentsOfFile: args[1]),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  fail("vision-ocr: cannot decode image", 2)
}
let request = VNRecognizeTextRequest { req, err in
  if let err { fail("vision-ocr: \(err.localizedDescription)", 3) }
  for obs in (req.results as? [VNRecognizedTextObservation]) ?? [] {
    guard let top = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox
    let text = top.string.replacingOccurrences(of: "\t", with: " ").replacingOccurrences(of: "\n", with: " ")
    print(String(format: "%.3f\t%.3f\t%.3f\t%.3f\t%.3f\t%@", top.confidence, b.minX, b.minY, b.width, b.height, text))
  }
}
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
if args.count >= 3 {
  let wanted = args[2].split(separator: ",").map(String.init)
  let supported = (try? request.supportedRecognitionLanguages()) ?? []
  // Vision silently ignores unknown languages and recognizes garbage; refuse instead.
  let unknown = wanted.filter { !supported.contains($0) }
  if !unknown.isEmpty { fail("vision-ocr: unsupported language(s) \(unknown.joined(separator: ",")); supported: \(supported.joined(separator: ","))", 2) }
  request.recognitionLanguages = wanted
}
do {
  try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
} catch {
  fail("vision-ocr: \(error.localizedDescription)", 3)
}
