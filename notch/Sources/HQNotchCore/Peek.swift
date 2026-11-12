import Foundation

/// A moment-long banner the closed notch widens into: a session finished or failed. Prompts
/// never peek: they open the whole panel, which has room to answer them.
public struct Peek: Equatable, Sendable, Identifiable {
    public enum Kind: Int, Sendable { case finished, failed }   // a higher kind wins
    public let id: Int
    public let kind: Kind
    public let sessionId: String
    /// When it happened: news older than `PeekQueue.staleSecs` is dropped before it shows.
    public let at: Date
    /// Set when it starts showing.
    public var until: Date
}

/// Which peek shows now. Pure: `now` is passed in, so the self-test can replay it.
/// A failure beats a finish (the finish waits its turn); a newer peek of the same kind, or for
/// the same session, replaces the one showing.
public struct PeekQueue: Sendable {
    public private(set) var current: Peek?
    private var waiting: [Peek] = []
    private var serial = 0
    public static let staleSecs: TimeInterval = 10

    public init() {}

    public static func secs(_ k: Peek.Kind) -> TimeInterval { k == .failed ? 6 : 4 }

    public mutating func push(_ e: StoreEffect, now: Date = Date()) {
        let kind: Peek.Kind, sid: String
        switch e {
        case .finished(let s): kind = .finished; sid = s
        case .failed(let s): kind = .failed; sid = s
        case .needsYou: return
        }
        serial += 1
        let p = Peek(id: serial, kind: kind, sessionId: sid, at: now, until: now.addingTimeInterval(Self.secs(kind)))
        waiting.removeAll { $0.sessionId == sid }
        guard let c = current, c.until > now else { current = p; return }
        if c.sessionId == sid || kind == c.kind {
            current = p
        } else if kind.rawValue > c.kind.rawValue {
            waiting.insert(c, at: 0)
            current = p
        } else {
            waiting.append(p)
        }
    }

    /// Expire the one showing, then show the next that is still news and whose session is live.
    public mutating func tick(now: Date = Date(), live: Set<String>) {
        if let c = current, c.until <= now || !live.contains(c.sessionId) { current = nil }
        waiting.removeAll { now.timeIntervalSince($0.at) > Self.staleSecs || !live.contains($0.sessionId) }
        if current == nil, !waiting.isEmpty {
            var next = waiting.removeFirst()
            next.until = now.addingTimeInterval(Self.secs(next.kind))
            current = next
        }
    }

    /// The panel opened: it shows everything, so drop every peek.
    public mutating func dismiss() {
        current = nil
        waiting.removeAll()
    }
}
