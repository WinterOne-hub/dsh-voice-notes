import AppKit

final class CaptionPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class CaptionText: NSTextField {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

final class CaptionView: NSView {
    private enum Edge { case left, right, top, bottom }

    private let text = CaptionText(wrappingLabelWithString: "")
    private let toggle = NSButton(title: "−", target: nil, action: nil)
    private var dragOffset: NSPoint?
    private var dock: Edge?
    private var collapsed = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = NSColor(calibratedWhite: 0.10, alpha: 0.96).cgColor
        layer?.cornerRadius = 12
        text.textColor = .white
        text.font = .systemFont(ofSize: 16, weight: .medium)
        text.alignment = .center
        text.maximumNumberOfLines = 0
        text.lineBreakMode = .byWordWrapping
        addSubview(text)
        toggle.target = self
        toggle.action = #selector(changeSize)
        toggle.bezelStyle = .rounded
        toggle.refusesFirstResponder = true
        toggle.setAccessibilityLabel("Toggle captions")
        addSubview(toggle)
        needsLayout = true
    }

    required init?(coder: NSCoder) { nil }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let width = max(1, bounds.width - 60)
        let height = min(max(0, bounds.height - 16), measuredHeight(width: width))
        text.frame = NSRect(x: 12, y: (bounds.height - height) / 2, width: width, height: height)
        toggle.frame = NSRect(x: bounds.width - 39, y: (bounds.height - 28) / 2, width: 32, height: 28)
    }

    func update(_ line: String) {
        text.stringValue = line
        guard !collapsed, let window, let screen = window.screen else { return }
        let area = screen.visibleFrame
        let previous = window.frame
        let size = captionSize(in: area)
        needsLayout = true
        if abs(size.height - previous.height) < 1 && abs(size.width - previous.width) < 1 { return }
        let frame = NSRect(x: previous.midX - size.width / 2, y: previous.minY, width: size.width, height: size.height)
        window.setFrame(placed(frame, in: area, edge: dock), display: true)
    }

    private var textAttributes: [NSAttributedString.Key: Any] {
        [.font: text.font ?? .systemFont(ofSize: 16)]
    }

    private func measuredHeight(width: CGFloat) -> CGFloat {
        let limit = NSSize(width: max(1, width - 4), height: .greatestFiniteMagnitude)
        let rect = (text.stringValue as NSString).boundingRect(with: limit,
            options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: textAttributes)
        return ceil(rect.height) + 4
    }

    private func captionSize(in area: NSRect) -> NSSize {
        let unwrapped = (text.stringValue as NSString).size(withAttributes: textAttributes).width
        let width = min(area.width, 660, max(126, ceil(unwrapped) + 70))
        let height = min(area.height * 0.65, max(44, measuredHeight(width: width - 60) + 18))
        return NSSize(width: width, height: height)
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        let pointer = NSEvent.mouseLocation
        dragOffset = NSPoint(x: pointer.x - window.frame.minX, y: pointer.y - window.frame.minY)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window, let dragOffset else { return }
        let pointer = NSEvent.mouseLocation
        window.setFrameOrigin(NSPoint(x: pointer.x - dragOffset.x, y: pointer.y - dragOffset.y))
    }

    override func mouseUp(with event: NSEvent) {
        guard dragOffset != nil, let window, let screen = nearestScreen() else { return }
        dragOffset = nil
        dock = nearestEdge(window.frame, within: screen.visibleFrame, always: collapsed)
        window.setFrame(placed(window.frame, in: screen.visibleFrame, edge: dock), display: true)
    }

    private func nearestScreen() -> NSScreen? {
        NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? window?.screen ?? NSScreen.main
    }

    private func nearestEdge(_ frame: NSRect, within area: NSRect, always: Bool) -> Edge? {
        let distances: [(Edge, CGFloat)] = [
            (.left, abs(frame.minX - area.minX)), (.right, abs(frame.maxX - area.maxX)),
            (.top, abs(frame.maxY - area.maxY)), (.bottom, abs(frame.minY - area.minY)),
        ]
        guard let (edge, distance) = distances.min(by: { $0.1 < $1.1 }), always || distance <= 30 else { return nil }
        return edge
    }

    private func placed(_ frame: NSRect, in area: NSRect, edge: Edge?) -> NSRect {
        var result = frame
        result.size.width = min(area.width, frame.width)
        result.size.height = min(area.height, frame.height)
        result.origin.x = min(max(frame.minX, area.minX), area.maxX - result.width)
        result.origin.y = min(max(frame.minY, area.minY), area.maxY - result.height)
        switch edge {
        case .left: result.origin.x = area.minX
        case .right: result.origin.x = area.maxX - result.width
        case .top: result.origin.y = area.maxY - result.height
        case .bottom: result.origin.y = area.minY
        case nil: break
        }
        return result
    }

    @objc private func changeSize() {
        guard let window, let screen = window.screen ?? nearestScreen() else { return }
        let previous = window.frame
        let area = screen.visibleFrame
        dock = dock ?? nearestEdge(previous, within: area, always: true)
        collapsed.toggle()
        let size = collapsed ? NSSize(width: 48, height: 38) : captionSize(in: area)
        let frame = NSRect(x: previous.midX - size.width / 2, y: previous.midY - size.height / 2, width: size.width, height: size.height)
        text.isHidden = collapsed
        toggle.title = collapsed ? "+" : "−"
        window.setFrame(placed(frame, in: area, edge: dock), display: true)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
guard let screen = NSScreen.main else { exit(1) }
let area = screen.visibleFrame
let width = min(CGFloat(180), area.width)
let panel = CaptionPanel(contentRect: NSRect(x: area.midX - width / 2, y: area.minY + 18, width: width, height: 44),
    styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
panel.level = .floating
panel.backgroundColor = .clear
panel.isOpaque = false
panel.hasShadow = true
panel.hidesOnDeactivate = false
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
let view = CaptionView(frame: panel.contentView!.bounds)
panel.contentView = view
view.layoutSubtreeIfNeeded()
panel.orderFrontRegardless()
FileHandle.standardOutput.write(Data("ready\n".utf8))
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        DispatchQueue.main.async { view.update(line) }
    }
    DispatchQueue.main.async { app.terminate(nil) }
}
app.run()
