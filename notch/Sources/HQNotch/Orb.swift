import HQNotchCore
import JavaScriptCore
import SwiftUI

/// HQ's thinking orbs: the vendored engine (OrbEngineJS) runs unchanged in JavaScriptCore with a
/// stand-in canvas that records each dot, and SwiftUI paints the dots.
@MainActor
final class OrbEngine {
    static let shared = OrbEngine()
    private let frame: JSValue?

    private init() {
        let ctx = JSContext()
        ctx?.evaluateScript(OrbEngineJS.source)
        // One frame as a flat list: x, y, r, grey (0-1), alpha per dot.
        ctx?.evaluateScript("""
        function hqOrbFrame(state, px, secs, still) {
          var E = ThinkingOrbsEngine, r = E.resolvePreset(state, px >= 40 ? 64 : 20), out = [], g = 1, a = 1;
          var c = { beginPath: function(){}, fill: function(){},
                    arc: function(x, y, rad){ out.push(x, y, rad, g, a); } };
          Object.defineProperty(c, "fillStyle", { set: function(v){
            var m = v.match(/[\\d.]+/g); g = m[0] / 255; a = m.length > 3 ? +m[3] : 1; } });
          E.MODE_DRAWS[r.mode](c, px, still ? 0.6 : secs * r.speed, true, r.opts);
          return out;
        }
        """)
        frame = ctx?.objectForKeyedSubscript("hqOrbFrame")
    }

    struct Dot { var x, y, r, grey, alpha: Double }

    func dots(_ state: String, px: Double, secs: Double, still: Bool) -> [Dot] {
        guard let raw = frame?.call(withArguments: [state, px, secs, still])?.toArray() as? [Double] else { return [] }
        return stride(from: 0, to: raw.count - 4, by: 5).map {
            Dot(x: raw[$0], y: raw[$0 + 1], r: raw[$0 + 2], grey: raw[$0 + 3], alpha: raw[$0 + 4])
        }
    }

    /// HQ's orbStateFor(): the animation follows the tool the session is running.
    static func state(_ s: Session) -> String {
        if s.status == .needs { return "listening" }
        let tool = s.now.components(separatedBy: " · ").first?.components(separatedBy: ":").first?
            .trimmingCharacters(in: .whitespaces) ?? ""
        if tool.isEmpty || tool == "Thinking" { return "composing" }
        if ["Read", "Grep", "Glob", "LS", "WebSearch", "WebFetch", "ToolSearch"].contains(tool) { return "searching" }
        if tool.hasPrefix("mcp__"), ["search", "find", "read", "get", "list", "query"].contains(where: tool.lowercased().contains) {
            return "searching"
        }
        if ["Edit", "MultiEdit", "Write", "NotebookEdit"].contains(tool) { return "shaping" }
        if ["Agent", "Task", "Workflow", "TodoWrite", "Plan"].contains(where: tool.hasPrefix) { return "solving" }
        if tool == "AskUserQuestion" { return "listening" }
        return "working"
    }
}

/// A session's orb: animated while it works or needs you, a still frame otherwise, tinted by status.
struct OrbView: View {
    let session: Session
    let status: SessionStatus
    var size: CGFloat = 44
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let moving = (status == .working || status == .needs) && !reduceMotion
        let state = status == .needs ? "listening" : OrbEngine.state(session)
        let tint: Color = switch status {
        case .working: Theme.text
        case .needs: Theme.alert
        case .done: Theme.ok
        case .error: Theme.danger
        case .idle: Theme.text.opacity(session.stale ? 0.35 : 0.6)
        }
        TimelineView(.animation(minimumInterval: 1 / 30, paused: !moving)) { tl in
            let dots = OrbEngine.shared.dots(state, px: Double(size),
                                             secs: tl.date.timeIntervalSinceReferenceDate, still: !moving)
            Canvas { ctx, _ in
                for d in dots where d.alpha >= 0.02 {
                    let r = max(0.3, d.r)
                    ctx.fill(Path(ellipseIn: CGRect(x: d.x - r, y: d.y - r, width: 2 * r, height: 2 * r)),
                             with: .color(tint.opacity(d.grey * d.alpha)))
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel("\(session.label), \(state)")
    }
}
