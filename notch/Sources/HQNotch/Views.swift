import AppKit
import HQNotchCore
import SwiftUI

/// Notch outline: flush with the top edge, rounded at the bottom, with concave "shoulders" at
/// the top corners so the panel flows out of the bezel. The body is `shoulder` narrower than the
/// rect on each side.
struct NotchShape: Shape {
    var shoulder: CGFloat
    var radius: CGFloat
    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(shoulder, radius) }
        set { shoulder = newValue.first; radius = newValue.second }
    }
    func path(in r: CGRect) -> Path {
        var p = Path()
        let t = min(shoulder, r.height / 2, r.width / 4)
        let rad = min(radius, (r.height - t) / 2, (r.width - 2 * t) / 2)
        p.move(to: CGPoint(x: r.minX, y: r.minY))
        p.addQuadCurve(to: CGPoint(x: r.minX + t, y: r.minY + t), control: CGPoint(x: r.minX + t, y: r.minY))
        p.addLine(to: CGPoint(x: r.minX + t, y: r.maxY - rad))
        p.addQuadCurve(to: CGPoint(x: r.minX + t + rad, y: r.maxY), control: CGPoint(x: r.minX + t, y: r.maxY))
        p.addLine(to: CGPoint(x: r.maxX - t - rad, y: r.maxY))
        p.addQuadCurve(to: CGPoint(x: r.maxX - t, y: r.maxY - rad), control: CGPoint(x: r.maxX - t, y: r.maxY))
        p.addLine(to: CGPoint(x: r.maxX - t, y: r.minY + t))
        p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.minY), control: CGPoint(x: r.maxX - t, y: r.minY))
        p.closeSubpath()
        return p
    }
}

/// Content coming into the open panel: it sharpens and settles while the shape opens.
struct Reveal: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View {
        content.opacity(on ? 1 : 0).blur(radius: on ? 0 : 6).scaleEffect(on ? 1 : 0.97, anchor: .top)
    }
}

/// Rows of the open panel arrive one after another, 25 ms apart.
struct Cascade: ViewModifier {
    let on: Bool
    let index: Int
    let reduce: Bool
    func body(content: Content) -> some View {
        content.opacity(on || reduce ? 1 : 0).offset(y: on || reduce ? 0 : -6)
            .animation(reduce ? nil : Motion.item.delay(0.06 + Double(min(index, 8)) * 0.025), value: on)
    }
}

struct NotchRoot: View {
    @ObservedObject var model: AppModel
    let notch: CGSize          // the hardware notch (or a menu-bar sized stand-in)
    var gap: CGFloat           // the room left for the notch in the closed pill (0 beside it)
    var anchor: CGFloat = 0    // the pill's centre, from the panel's centre (beside the notch)
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The open panel's height, measured from its content; animating to it opens the shape.
    @State private var openHeight: CGFloat = 200
    @State private var appeared = false
    static let wing: CGFloat = 64
    static let expandedWidth: CGFloat = 500
    static let closedShoulder: CGFloat = 6
    static let openShoulder: CGFloat = 10
    /// How much the closed pill grows while the cursor rests on it.
    static let swell = CGSize(width: 12, height: 3)
    /// A banner's height below the notch.
    static let peekExtra: CGFloat = 40
    /// How far the expanded panel can slide within the window, each way.
    static let slack: CGFloat = (NotchController.panelSize.width - expandedWidth - 2 * openShoulder) / 2

    private enum Mode { case closed, peek, open }

    private var peekSession: (Peek, Session)? {
        guard let p = model.peek, let s = model.store.sessions[p.sessionId] else { return nil }
        return (p, s)
    }

    private var mode: Mode { model.expanded ? .open : peekSession != nil ? .peek : .closed }

    var body: some View {
        let m = mode
        let shoulder = m == .closed ? Self.closedShoulder : Self.openShoulder
        let shape = NotchShape(shoulder: shoulder, radius: m == .open ? 22 : m == .peek ? 18 : 12)
        let swell = m == .closed && model.hovering ? Self.swell : .zero
        let size: CGSize = switch m {
        case .open: CGSize(width: Self.expandedWidth, height: openHeight)
        case .peek: CGSize(width: PeekBanner.width, height: notch.height + Self.peekExtra)
        case .closed: CGSize(width: NotchController.pillWidth(notch: notch, beside: gap == 0) + swell.width,
                             height: notch.height + swell.height)
        }
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                if m == .open {
                    expanded.transition(contentTransition)
                } else if let ps = peekSession {
                    PeekBanner(model: model, peek: ps.0, session: ps.1, notch: notch).transition(contentTransition)
                } else {
                    closed.transition(reduceMotion ? .opacity : .asymmetric(
                        insertion: .opacity.animation(.easeOut(duration: 0.18).delay(0.1)),
                        removal: .opacity.animation(.easeIn(duration: 0.08))))
                }
            }
            // One shape whose size springs between pill, banner and panel; the content inside
            // keeps its own size and is revealed (or tucked away) by the shape's edge.
            .frame(width: size.width + 2 * shoulder, height: size.height, alignment: .top)
            .clipShape(shape)
            .background(shape.fill(Theme.bg)
                .shadow(color: .black.opacity(m == .open ? 0.45 : m == .peek ? 0.3 : 0), radius: 16, y: 8))
            .offset(x: m == .open ? min(max(anchor, -Self.slack), Self.slack) : anchor)   // beside the notch: under the pill
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .animation(reduceMotion ? Motion.calm : m == .closed ? Motion.close : Motion.open, value: m)
        .animation(reduceMotion ? nil : Motion.swell, value: model.hovering)
    }

    private var contentTransition: AnyTransition {
        reduceMotion ? .opacity : .asymmetric(
            insertion: .modifier(active: Reveal(on: false), identity: Reveal(on: true))
                .animation(.easeOut(duration: 0.24).delay(0.05)),
            removal: .modifier(active: Reveal(on: false), identity: Reveal(on: true))
                .animation(.easeIn(duration: 0.1)))
    }

    /// The content's natural size: it drives the shape's height and the hover hit area.
    private func measured(_ s: CGSize) {
        model.expandedSize = s
        guard abs(s.height - openHeight) > 0.5 else { return }
        if reduceMotion { openHeight = s.height } else { withAnimation(Motion.open) { openHeight = s.height } }
    }

    // MARK: closed

    private var closed: some View {
        let live = model.visibleSessions
        let needs = model.store.pending.count + live.filter { $0.status == .needs && !model.store.hasPending($0.id) }.count
        return HStack(spacing: 0) {
            HStack(spacing: -6) {
                // Orbs: just the top session's (the one that needs you first, else the busiest).
                ForEach(live.prefix(model.spriteSetting == .orb ? 1 : 3)) { s in
                    SessionAvatar(model: model, session: s, size: max(18, notch.height - 6))
                }
            }
            .frame(width: Self.wing, alignment: .leading)
            .padding(.leading, 10)
            Color.clear.frame(width: gap)
            HStack(spacing: 4) {
                if needs > 0 {
                    NeedsBadge(count: needs)
                } else if let s = live.first {
                    Circle().fill(Theme.color(s.status)).frame(width: 7, height: 7)
                    Text("\(live.count)").font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(Theme.subtle)
                }
            }
            .frame(width: Self.wing, alignment: .trailing)
            .padding(.trailing, 10)
        }
        .frame(height: notch.height)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(live.count) Claude sessions, \(needs) need you")
    }

    // MARK: expanded

    private var expanded: some View {
        VStack(alignment: .leading, spacing: 8) {
            header.modifier(Cascade(on: appeared, index: 0, reduce: reduceMotion))
            if let d = model.showDiff {
                DiffView(model: model, item: d.item, folder: d.folder)
            } else if model.showSettings {
                SettingsView(model: model)
            } else {
                // Oldest two requests as cards; the rest wait their turn.
                ForEach(Array(model.store.pending.prefix(2).enumerated()), id: \.element.id) { i, r in
                    RequestCard(model: model, request: r)
                        .modifier(Cascade(on: appeared, index: 1 + i, reduce: reduceMotion))
                }
                if model.store.pending.count > 2 {
                    Text("+\(model.store.pending.count - 2) more waiting").font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.alert)
                }
                FilterBar(model: model).modifier(Cascade(on: appeared, index: 1, reduce: reduceMotion))
                let list = model.visibleSessions
                if list.isEmpty {
                    Text(model.filter != .all ? "No \(model.filter.label.lowercased()) sessions."
                         : model.hqReachable ? "No live Claude sessions." : "No live Claude sessions. Start one and it shows up here.")
                        .font(.system(size: 12)).foregroundStyle(Theme.subtle)
                        .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 18)
                } else {
                    // Up to four cards at natural height; more scroll inside 380 pt.
                    if list.count <= 4 && model.store.pending.isEmpty {
                        cards(list)
                    } else {
                        ScrollView(.vertical, showsIndicators: false) { cards(list) }
                            .frame(height: model.store.pending.isEmpty ? 380 : 220)
                    }
                }
            }
        }
        .padding(.top, notch.height + 4)
        .padding(.horizontal, 14)
        .padding(.bottom, 14)
        .frame(width: Self.expandedWidth)
        .fixedSize(horizontal: false, vertical: true)
        .background(GeometryReader { g in
            Color.clear
                .onAppear { measured(g.size) }
                .onChange(of: g.size) { _, new in measured(new) }
        })
        .task { appeared = true }
        .onDisappear { appeared = false }
    }

    private func cards(_ list: [Session]) -> some View {
        VStack(spacing: 6) {
            ForEach(Array(list.enumerated()), id: \.element.id) { i, s in
                SessionCard(model: model, session: s)
                    .modifier(Cascade(on: appeared, index: 2 + i, reduce: reduceMotion))
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(.snappy(duration: 0.25), value: list.map(\.id))
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("Claude HQ").font(.system(size: 13, weight: .bold, design: .rounded)).foregroundStyle(Theme.text)
            Circle().fill(model.hqReachable ? Theme.ok : Theme.faint).frame(width: 6, height: 6)
                .help(model.hqReachable ? "Connected to Claude HQ" : "Claude HQ is not running: using local creatures")
            Text(summary).font(.system(size: 10.5, weight: .medium)).foregroundStyle(Theme.faint).lineLimit(1)
            Spacer()
            IconButton(symbol: "square.grid.2x2.fill", help: "Open Claude HQ") { model.openHQ() }
            IconButton(symbol: model.showSettings ? "xmark" : "gearshape.fill",
                       help: model.showSettings ? "Close settings" : "Settings") { model.showSettings.toggle() }
        }
    }

    /// "1 needs you · 2 working", or "all quiet".
    private var summary: String {
        let all = model.store.sessions.values
        let needs = model.store.pending.count + all.filter { $0.status == .needs && !model.store.hasPending($0.id) }.count
        let working = all.filter { $0.status == .working }.count
        var parts: [String] = []
        if needs > 0 { parts.append("\(needs) need\(needs == 1 ? "s" : "") you") }
        if working > 0 { parts.append("\(working) working") }
        return parts.isEmpty ? (all.isEmpty ? "" : "all quiet") : parts.joined(separator: " · ")
    }
}

/// The closed pill's count of sessions waiting on you, breathing softly.
struct NeedsBadge: View {
    let count: Int
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        Text("\(count)").font(.system(size: 11, weight: .heavy, design: .rounded))
            .foregroundStyle(Theme.alertText)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(Capsule().fill(Theme.alert))
            .background(Capsule().fill(Theme.alert).blur(radius: 5).opacity(pulse ? 0.75 : 0.15))
            .scaleEffect(pulse ? 1.06 : 1)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: pulse)
            .onAppear { if !reduceMotion { pulse = true } }
    }
}

/// The banner the pill widens into when a session finishes or fails. A click jumps to its
/// terminal; resting on it opens the whole panel, as on the pill.
struct PeekBanner: View {
    @ObservedObject var model: AppModel
    let peek: Peek
    let session: Session
    let notch: CGSize
    static let width: CGFloat = 360

    var body: some View {
        let failed = peek.kind == .failed
        let tint = failed ? Theme.danger : Theme.ok
        HStack(spacing: 10) {
            SessionAvatar(model: model, session: session, size: 26, status: failed ? .error : .done)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.label).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                Text(failed ? (session.now.isEmpty ? "Stopped with an error" : session.now) : "Finished")
                    .font(.system(size: 11)).foregroundStyle(tint).lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: 6)
            Image(systemName: failed ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .font(.system(size: 15, weight: .semibold)).foregroundStyle(tint)
        }
        .padding(.horizontal, 14)
        .padding(.top, notch.height + 4)
        .frame(width: Self.width, height: notch.height + NotchRoot.peekExtra, alignment: .top)
        .contentShape(Rectangle())
        .onTapGesture { model.jump(session); model.dismissPeek() }
        .help("Jump to this session's terminal")
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(session.label) \(failed ? "stopped with an error" : "finished")")
        .accessibilityAddTraits(.isButton)
    }
}

struct IconButton: View {
    let symbol: String
    let help: String
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 11, weight: .semibold))
                .foregroundStyle(hover ? Theme.text : Theme.subtle).frame(width: 22, height: 22)
                .background(Circle().fill(hover ? Theme.cardHover : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).help(help).accessibilityLabel(help)
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.12), value: hover)
    }
}

/// An SF Symbol for each tool on the ticker.
enum ToolIcon {
    static func symbol(_ tool: String) -> String {
        switch tool {
        case "Bash", "BashOutput", "KillShell": "terminal"
        case "Edit", "MultiEdit", "Write", "NotebookEdit": "pencil"
        case "Read", "Grep", "Glob", "LS": "doc.text.magnifyingglass"
        case "WebFetch", "WebSearch": "globe"
        case "Agent", "Task": "person.2"
        case "TodoWrite": "checklist"
        default: tool.hasPrefix("mcp__") ? "puzzlepiece.extension" : "sparkle"
        }
    }
}

// MARK: session card

/// The session's orb or Pokémon, whichever Settings picks. `status` overrides the session's own.
struct SessionAvatar: View {
    @ObservedObject var model: AppModel
    let session: Session
    var size: CGFloat
    var status: SessionStatus? = nil

    var body: some View {
        if model.spriteSetting == .orb {
            OrbView(session: session, status: status ?? session.status, size: size)
        } else {
            CreatureSprite(sessionId: session.id, creature: model.creature(session), status: status ?? session.status,
                           size: size, pack: model.pack)
        }
    }
}

struct SessionCard: View {
    @ObservedObject var model: AppModel
    let session: Session
    @State private var hover = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let cr = model.creature(session)
        HStack(alignment: .top, spacing: 10) {
            SessionAvatar(model: model, session: session, size: 46)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(session.label).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Theme.text)
                        .lineLimit(1)
                    Text(model.spriteSetting == .orb ? (session.title.isEmpty ? "" : session.folder)
                         : session.title.isEmpty ? cr.name(sessionId: session.id, pack: model.pack)
                                               : "\(session.folder) · \(cr.name(sessionId: session.id, pack: model.pack))")
                        .font(.system(size: 10.5)).foregroundStyle(Theme.faint).lineLimit(1).layoutPriority(-1)
                    if session.subagents > 0 {
                        Text("+\(session.subagents) agents").font(.system(size: 10, weight: .medium))
                            .foregroundStyle(Theme.subtle)
                    }
                    Spacer(minLength: 4)
                    StatusChip(status: session.status, stale: session.bucket == .stale)
                }
                if !session.now.isEmpty {
                    Text(session.now).font(.system(size: 11.5)).foregroundStyle(Theme.subtle).lineLimit(1)
                        .truncationMode(.middle)
                }
                if !session.lastPrompt.isEmpty {
                    Text("“\(session.lastPrompt)”").font(.system(size: 11)).foregroundStyle(Theme.faint).lineLimit(1)
                }
                ForEach(session.ticker.prefix(3)) { t in
                    TickerRow(item: t, onOpen: t.diff == nil ? nil : { model.openDiff(t, in: session) })
                }
                // A prompt only the terminal can answer (approvals off, or one the notch never saw).
                if session.status == .needs && !model.store.hasPending(session.id) {
                    Button("Answer in the terminal") { model.jump(session) }.buttonStyle(LinkStyle())
                }
            }
        }
        .padding(8)
        .padding(.leading, 4)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(hover ? Theme.cardHover : Theme.card))
        .overlay(alignment: .leading) {
            Capsule().fill(Theme.color(session.status).opacity(session.status == .idle ? 0.5 : 0.9))
                .frame(width: 3).padding(.vertical, 10).padding(.leading, 3)
        }
        .scaleEffect(hover && !reduceMotion ? 1.01 : 1)
        .animation(.snappy(duration: 0.18), value: hover)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { model.jump(session) }
        .help("Jump to this session's terminal")
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

/// All / Working / Idle / Stale, with a count on each.
struct FilterBar: View {
    @ObservedObject var model: AppModel
    @Namespace private var ns
    var body: some View {
        HStack(spacing: 4) {
            ForEach(SessionFilter.allCases) { f in
                let on = model.filter == f
                Button { withAnimation(.snappy(duration: 0.25)) { model.filter = f } } label: {
                    Text("\(f.label) \(model.count(f))").font(.system(size: 10.5, weight: .semibold, design: .rounded))
                        .foregroundStyle(on ? Theme.buttonText : Theme.subtle)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background {
                            // the selected highlight slides from tab to tab
                            ZStack {
                                Capsule().fill(Theme.card)
                                if on { Capsule().fill(Theme.text).matchedGeometryEffect(id: "filter", in: ns) }
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
            Spacer()
        }
    }
}

struct StatusChip: View {
    let status: SessionStatus
    var stale = false
    var body: some View {
        let base: String = switch status {
        case .working: "Working"
        case .needs: "Needs you"
        case .done: "Done"
        case .error: "Error"
        case .idle: "Idle"
        }
        let label = stale ? "Stale" : base
        Text(label).font(.system(size: 9.5, weight: .bold, design: .rounded))
            .foregroundStyle(status == .needs ? Theme.alertText : Theme.color(status))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Capsule().fill(status == .needs ? Theme.alert : Theme.color(status).opacity(0.16)))
    }
}

struct TickerRow: View {
    let item: TickerItem
    /// Set for an edit: a click opens its change in the diff view.
    var onOpen: (() -> Void)?
    @State private var hover = false
    var body: some View {
        let row = HStack(spacing: 5) {
            Image(systemName: ToolIcon.symbol(item.tool)).font(.system(size: 9, weight: .semibold))
                .foregroundStyle(item.failed ? Theme.danger : Theme.faint).frame(width: 12)
            Text(item.tool).font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                .foregroundStyle(item.failed ? Theme.danger : Theme.subtle)
            Text(item.target).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(Theme.faint)
                .lineLimit(1).truncationMode(.middle)
            if let p = item.plus, p > 0 {
                Text("+\(p)").font(.system(size: 10.5, weight: .semibold, design: .monospaced)).foregroundStyle(Theme.ok)
            }
            if let m = item.minus, m > 0 {
                Text("−\(m)").font(.system(size: 10.5, weight: .semibold, design: .monospaced)).foregroundStyle(Theme.danger)
            }
            if onOpen != nil {
                Image(systemName: "chevron.right").font(.system(size: 8.5, weight: .bold))
                    .foregroundStyle(hover ? Theme.text : Theme.faint)
            }
        }
        if let onOpen {
            // a click here opens the diff instead of jumping to the terminal (the card's tap)
            row.contentShape(Rectangle()).onHover { hover = $0 }.onTapGesture(perform: onOpen)
                .help("Show this change").accessibilityAddTraits(.isButton)
        } else {
            row
        }
    }
}

// MARK: diff view

/// What an edit changed: removed lines tinted red, added green, a few unchanged lines around.
struct DiffView: View {
    @ObservedObject var model: AppModel
    let item: TickerItem
    let folder: String

    var body: some View {
        let lines = item.diff.map(DiffBuilder.lines) ?? []
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Button { model.showDiff = nil } label: {
                    Label("Back", systemImage: "chevron.left").font(.system(size: 11, weight: .semibold))
                }
                .buttonStyle(LinkStyle()).keyboardShortcut(.escape, modifiers: [])
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.target.isEmpty ? item.tool : item.target)
                        .font(.system(size: 12, weight: .semibold, design: .monospaced)).foregroundStyle(Theme.text).lineLimit(1)
                    Text("\(item.tool) · \(folder)").font(.system(size: 10.5)).foregroundStyle(Theme.faint).lineLimit(1)
                }
                Spacer()
                if let p = item.plus, p > 0 { Text("+\(p)").font(.system(size: 11, weight: .bold, design: .monospaced)).foregroundStyle(Theme.ok) }
                if let m = item.minus, m > 0 { Text("−\(m)").font(.system(size: 11, weight: .bold, design: .monospaced)).foregroundStyle(Theme.danger) }
            }
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, l in DiffRow(line: l) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
            }
            .frame(height: min(380, max(60, CGFloat(lines.count)*15 + 12)))
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.card))
        }
    }
}

struct DiffRow: View {
    let line: DiffLine
    var body: some View {
        switch line {
        case .context(let s): text(" " + s, Theme.subtle, nil)
        case .removed(let s): text("−" + s, Theme.text, Theme.danger.opacity(0.22))
        case .added(let s): text("+" + s, Theme.text, Theme.ok.opacity(0.2))
        case .gap(let n):
            Text(n > 0 ? "⋯ \(n) unchanged line\(n == 1 ? "" : "s")" : "⋯")
                .font(.system(size: 10, design: .monospaced)).foregroundStyle(Theme.faint).padding(.vertical, 3).padding(.horizontal, 6)
        case .more:
            Text("… more than the notch shows: see the terminal").font(.system(size: 10)).foregroundStyle(Theme.faint)
                .padding(.vertical, 3).padding(.horizontal, 6)
        }
    }

    private func text(_ s: String, _ fg: Color, _ bg: Color?) -> some View {
        Text(s.isEmpty ? " " : s).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(fg)
            .lineLimit(1).truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(bg ?? .clear)
    }
}

// MARK: requests

struct RequestCard: View {
    @ObservedObject var model: AppModel
    let request: PendingRequest

    var body: some View {
        let s = model.store.sessions[request.sessionId]
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if let s {
                    SessionAvatar(model: model, session: s, size: 34, status: .needs)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(s?.label ?? "Claude").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.text)
                    Text(request.isPlan ? "Has a plan for you" : request.isQuestion ? "Has a question" : "Wants to run \(request.tool)")
                        .font(.system(size: 11)).foregroundStyle(Theme.alert)
                }
                Spacer()
            }
            if request.isPlan {
                PlanBody(model: model, request: request)
            } else if request.isQuestion {
                QuestionForm(model: model, request: request)
            } else {
                Text(RequestDetail.text(request)).font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Theme.text).lineLimit(6).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.card))
                    .textSelection(.enabled)
                HStack(spacing: 8) {
                    Button("Terminal") { model.passToTerminal(request) }.buttonStyle(LinkStyle())
                    Spacer()
                    Button("Deny") { model.deny(request) }.buttonStyle(PillStyle(fill: Theme.danger))
                        .keyboardShortcut(.escape, modifiers: [])
                    if request.canAlways {
                        Button("Always") { model.allow(request, always: true) }.buttonStyle(PillStyle(fill: Theme.working))
                    }
                    Button("Allow") { model.allow(request) }.buttonStyle(PillStyle(fill: Theme.ok))
                        .keyboardShortcut(.return, modifiers: [])
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.alert.opacity(0.07)))
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.alert.opacity(0.7), lineWidth: 1)
            .shadow(color: Theme.alert.opacity(0.35), radius: 6))
    }
}

/// A plan waiting for approval (ExitPlanMode): read it, then approve it, send it back, or answer
/// in the terminal.
struct PlanBody: View {
    @ObservedObject var model: AppModel
    let request: PendingRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.vertical) {
                Text(PlanText.render(request.plan ?? ""))
                    .font(.system(size: 11.5)).foregroundStyle(Theme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .textSelection(.enabled)
            }
            .frame(maxHeight: 220)
            .fixedSize(horizontal: false, vertical: (request.plan ?? "").count < 400)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.card))
            HStack(spacing: 8) {
                Button("Terminal") { model.passToTerminal(request) }.buttonStyle(LinkStyle())
                Spacer()
                Button("Keep planning") { model.keepPlanning(request) }.buttonStyle(PillStyle(fill: Theme.working))
                    .keyboardShortcut(.escape, modifiers: [])
                Button("Approve") { model.allow(request) }.buttonStyle(PillStyle(fill: Theme.ok))
                    .keyboardShortcut(.return, modifiers: [])
            }
        }
    }
}

/// A plan's markdown as text: inline styles (bold, code, links) rendered, line breaks kept; plain
/// text if it does not parse. Headings and bullets stay as written, which reads fine.
enum PlanText {
    static func render(_ md: String) -> AttributedString {
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: md, options: opts)) ?? AttributedString(md)
    }
}

/// What the permission card shows for a tool input.
enum RequestDetail {
    static func text(_ r: PendingRequest) -> String {
        let ti = r.toolInput
        switch r.tool {
        case "Bash": return "$ " + (ti?["command"]?.string ?? r.target)
        case "Edit", "MultiEdit", "Write", "NotebookEdit":
            var out = ti?["file_path"]?.string ?? ti?["notebook_path"]?.string ?? r.target
            if let old = ti?["old_string"]?.string, let new = ti?["new_string"]?.string {
                out += "\n" + diff(old, "-") + "\n" + diff(new, "+")
            } else if let c = ti?["content"]?.string {
                out += "\n" + diff(c, "+")
            }
            return out
        case "WebFetch": return ti?["url"]?.string ?? r.target
        default:
            if let ti, let d = try? JSONEncoder().encode(ti), let s = String(data: d, encoding: .utf8) {
                return s.count > 600 ? String(s.prefix(600)) + "…" : s
            }
            return r.target
        }
    }

    private static func diff(_ s: String, _ mark: String) -> String {
        let lines = s.split(separator: "\n", omittingEmptySubsequences: false).prefix(3)
        return lines.map { "\(mark) \($0)" }.joined(separator: "\n")
    }
}

struct QuestionForm: View {
    @ObservedObject var model: AppModel
    let request: PendingRequest
    @State private var picks: [String: [String]] = [:]

    private var complete: Bool { request.questions.allSatisfy { !(picks[$0.text] ?? []).isEmpty } }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(request.questions) { q in
                VStack(alignment: .leading, spacing: 5) {
                    if !q.header.isEmpty {
                        Text(q.header.uppercased()).font(.system(size: 9.5, weight: .bold)).foregroundStyle(Theme.faint)
                    }
                    Text(q.text).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.text)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(Array(q.options.enumerated()), id: \.offset) { _, o in
                        let on = (picks[q.text] ?? []).contains(o.label)
                        Button { toggle(q, o.label) } label: {
                            HStack(alignment: .top, spacing: 6) {
                                Image(systemName: q.multiSelect ? (on ? "checkmark.square.fill" : "square")
                                                                : (on ? "largecircle.fill.circle" : "circle"))
                                    .font(.system(size: 11)).foregroundStyle(on ? Theme.ok : Theme.subtle)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(o.label).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Theme.text)
                                    if !o.detail.isEmpty {
                                        Text(o.detail).font(.system(size: 10.5)).foregroundStyle(Theme.subtle)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(6)
                            .background(RoundedRectangle(cornerRadius: 8).fill(on ? Theme.cardHover : Theme.card))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(on ? .isSelected : [])
                    }
                }
            }
            HStack {
                Button("Answer in terminal") { model.passToTerminal(request) }.buttonStyle(LinkStyle())
                Spacer()
                Button("Send") { submit() }.buttonStyle(PillStyle(fill: complete ? Theme.ok : Theme.faint))
                    .disabled(!complete)
            }
        }
    }

    private func toggle(_ q: Question, _ label: String) {
        var cur = picks[q.text] ?? []
        if q.multiSelect {
            if let i = cur.firstIndex(of: label) { cur.remove(at: i) } else { cur.append(label) }
        } else {
            cur = [label]
        }
        picks[q.text] = cur
    }

    private func submit() {
        var answers: [String: Any] = [:]
        for q in request.questions {
            let p = picks[q.text] ?? []
            answers[q.text] = q.multiSelect ? p : (p.first ?? "")
        }
        model.answer(request, answers)
    }
}

struct PillStyle: ButtonStyle {
    let fill: Color
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 11.5, weight: .bold, design: .rounded))
            .foregroundStyle(Theme.buttonText)
            .padding(.horizontal, 12).padding(.vertical, 5)
            .background(Capsule().fill(fill.opacity(configuration.isPressed ? 0.7 : 1)))
    }
}

struct LinkStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 11, weight: .medium))
            .foregroundStyle(configuration.isPressed ? Theme.text : Theme.subtle)
            .underline()
    }
}

// MARK: settings

/// Phone alerts: a content-free push to an ntfy topic when a session needs you, finishes or
/// fails. Off until you turn it on.
struct PhoneSettings: View {
    @ObservedObject var model: AppModel
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingToggle(title: "Phone alerts",
                          detail: "A short push (\u{201C}A Claude session needs you\u{201D}, \u{201C}…finished\u{201D}) through ntfy. Never your prompts, files or session names.",
                          isOn: $model.phoneOn)
            if model.phoneOn {
                HStack(spacing: 6) {
                    Text("Server").font(.system(size: 10.5)).foregroundStyle(Theme.faint).frame(width: 46, alignment: .leading)
                    TextField("https://ntfy.sh", text: $model.phoneServer)
                        .textFieldStyle(.roundedBorder).font(.system(size: 11, design: .monospaced))
                        .disableAutocorrection(true)
                }
                HStack(spacing: 6) {
                    Text("Topic").font(.system(size: 10.5)).foregroundStyle(Theme.faint).frame(width: 46, alignment: .leading)
                    Text(model.phoneTopic).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.text)
                        .textSelection(.enabled)
                    Spacer(minLength: 4)
                    Button(copied ? "Copied" : "Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(model.phoneTopic, forType: .string)
                        copied = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                    }.buttonStyle(LinkStyle())
                    Button("New") { model.newPhoneTopic() }.buttonStyle(LinkStyle())
                        .help("Make a new random topic: anyone following the old one stops getting your alerts")
                }
                Text("Install the ntfy app on your phone and subscribe to this topic. Anyone who knows the topic can read the alerts, so keep it to yourself.")
                    .font(.system(size: 10.5)).foregroundStyle(Theme.faint).fixedSize(horizontal: false, vertical: true)
                if PhoneTopic.url(server: model.phoneServer, topic: model.phoneTopic) == nil {
                    Text("The server must be an http(s) address, like https://ntfy.sh.").font(.system(size: 10.5)).foregroundStyle(Theme.danger)
                }
                SettingToggle(title: "Only when I'm away from the Mac",
                              detail: "Skip the push if you used the keyboard or mouse in the last 2 minutes.",
                              isOn: $model.phoneAwayOnly)
                HStack(spacing: 8) {
                    Button("Send a test") { model.sendTestPush() }.buttonStyle(PillStyle(fill: Theme.working))
                    if let st = model.phoneStatus {
                        Text(st).font(.system(size: 10.5)).foregroundStyle(Theme.subtle).lineLimit(2)
                    }
                }
            }
        }
    }
}

/// The notch's own settings (the gear in the header). Every choice is saved at once.
struct SettingsView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionTitle(text: "Look")
            VStack(alignment: .leading, spacing: 6) {
                Text("Sprites").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.subtle)
                Picker("Sprites", selection: $model.spriteSetting) {
                    ForEach(SpriteSetting.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden()
                Text(spriteNote).font(.system(size: 10.5)).foregroundStyle(Theme.faint)
                    .fixedSize(horizontal: false, vertical: true)
                previewRow
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Position").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.subtle)
                Picker("Position", selection: $model.placement) {
                    ForEach(Placement.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden()
                Text(placementNote).font(.system(size: 10.5)).foregroundStyle(Theme.faint)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Divider().overlay(Theme.card)
            SectionTitle(text: "Behaviour")
            SettingToggle(title: "Sounds", detail: "A chime when a session needs you or finishes.", isOn: $model.soundsOn)
            SettingToggle(title: "Live banners",
                          detail: "The notch widens for a moment when a session finishes or fails.",
                          isOn: $model.banners)
            SettingToggle(title: "Show idle sessions", detail: "Sessions waiting for your next prompt.", isOn: $model.showIdle)
            SettingToggle(title: "Approve from the notch",
                          detail: "Off: every permission prompt and question goes straight to the terminal.",
                          isOn: $model.approvals)
            Divider().overlay(Theme.card)
            SectionTitle(text: "Phone")
            PhoneSettings(model: model)
            Divider().overlay(Theme.card)
            HStack {
                Circle().fill(model.hqReachable ? Theme.ok : Theme.faint).frame(width: 6, height: 6)
                Text(model.hqReachable ? "Connected to Claude HQ" : "Claude HQ isn't running: creatures are computed here")
                    .font(.system(size: 10.5)).foregroundStyle(Theme.subtle)
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }.buttonStyle(LinkStyle())
            }
        }
        .padding(.top, 2)
    }

    private var placementNote: String {
        let other = model.otherNotchApp
        switch model.placement {
        case .auto: return other.map { "\($0) is in the notch, so HQ Notch sits just left of it." }
            ?? "In the notch. If another notch app (Sapphire, NotchNook, ...) starts, HQ Notch steps aside."
        case .notch: return other.map { "\($0) is in the notch too: they may overlap." } ?? "Always in the notch."
        case .left: return "Always just left of the notch."
        case .right: return "Always just right of the notch."
        }
    }

    private var spriteNote: String {
        switch model.spriteSetting {
        case .orb: return "HQ's thinking orbs: the motion follows what the session is doing, the colour its status."
        case .twoD: return "Animated 2D sprites. Apex is the line's final form."
        case .threeD: return "Animated 3D sprites, as in HQ's 3D pack. Apex Pokémon with a Mega show their Mega form."
        case .matchHQ: return "Whatever HQ uses: now \(model.hqPack == .threeD ? "3D" : "2D")."
        }
    }

    /// The live sessions in the chosen style, so the switch shows what it does.
    private var previewRow: some View {
        HStack(spacing: 6) {
            ForEach(model.visibleSessions.prefix(6)) { s in
                SessionAvatar(model: model, session: s, size: 34, status: .working)
            }
        }
    }
}

struct SectionTitle: View {
    let text: String
    var body: some View {
        Text(text.uppercased()).font(.system(size: 9.5, weight: .bold)).tracking(0.6).foregroundStyle(Theme.faint)
    }
}

struct SettingToggle: View {
    let title: String
    let detail: String
    @Binding var isOn: Bool
    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.text)
                Text(detail).font(.system(size: 10.5)).foregroundStyle(Theme.faint)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Toggle(title, isOn: $isOn).labelsHidden()
                .toggleStyle(.switch).tint(Theme.ok).controlSize(.small)
        }
        .contentShape(Rectangle())
        .onTapGesture { isOn.toggle() }
    }
}
