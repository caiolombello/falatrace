import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Recording 1.0

ApplicationWindow {
    id: window
    width: 1320; height: 820
    minimumWidth: 900; minimumHeight: 640
    visible: true
    title: "FalaTrace Studio · " + Qt.application.version
    font.pixelSize: 14
    color: canvas
    property real position: 0
    property real duration: 0
    property string location: ""
    property bool mediaReady: false
    property string errorText: ""
    // Follows the desktop color scheme until the theme is switched in the header.
    property bool lightTheme: Qt.styleHints.colorScheme === Qt.ColorScheme.Light
    property bool compactLayout: width < 1100 || height < 720
    // FalaTrace identity: paper/ink surfaces with mint (dark) or deep mint (light) as the source accent.
    property color canvas: lightTheme ? "#F4F1E9" : "#0B1716"
    property color chrome: lightTheme ? "#EDE9DF" : "#0E1D1C"
    property color surface: lightTheme ? "#FFFFFF" : "#132826"
    property color surfaceAlt: lightTheme ? "#F8F6F0" : "#172F2D"
    property color fieldSurface: lightTheme ? "#FFFFFF" : "#0F2120"
    property color panel: lightTheme ? "#ECF1EC" : "#172F2D"
    property color divider: lightTheme ? "#D6DDD6" : "#24423D"
    property color dividerStrong: lightTheme ? "#B5C4BA" : "#33605A"
    property color buttonSurface: lightTheme ? "#E3ECE5" : "#1E3B36"
    property color selectedSurface: lightTheme ? "#DDEFE4" : "#1D4139"
    property color hoverSurface: lightTheme ? "#E9EFEA" : "#18322E"
    property color warningColor: lightTheme ? "#A34125" : "#FFB377"
    property color errorColor: lightTheme ? "#B42318" : "#FFB4AB"
    property color recordingColor: lightTheme ? "#B62234" : "#FF7373"
    property color ink: lightTheme ? "#102B2A" : "#F4F1E9"
    property color muted: lightTheme ? "#566B66" : "#AAC0B8"
    property color accent: lightTheme ? "#0F705A" : "#57D5B0"
    property color onAccent: lightTheme ? "#FFFFFF" : "#0B1716"
    property color accentSoft: lightTheme ? "#DDEFE6" : "#173D35"
    property color warningSoft: lightTheme ? "#F7E6D7" : "#33291F"
    property color errorSoft: lightTheme ? "#F6E1DC" : "#3A2422"
    property color recordingSoft: lightTheme ? "#F8E0E2" : "#3A1E22"
    property double statusNow: Date.now()
    property var items: []
    property var filtered: items.filter(item => (item.title + " " + item.fileName).toLocaleLowerCase().includes(search.text.toLocaleLowerCase()))
    property var selected: ({})
    property var detail: ({transcript: {segments: [], text: "", timing: "none"}, diarization: {state: "idle"}})
    property var pending: ({})
    property int generation: 0
    property bool loading: true
    // The last saved list is shown at startup until the fresh list replaces it.
    property bool libraryRefreshing: false
    property bool libraryFresh: false
    property bool resolving: false
    property bool detailLoading: false
    property bool paused: true
    property bool playerInitialized: false
    property bool captions: true
    property bool subtitleQueued: false
    property string notice: ""
    property string processingWait: ""
    property string pendingPath: ""
    property string playbackOperation: ""
    property bool operationPolling: false
    property bool diarizationQueued: false
    property string initialTranscriptTiming: ""
    property string transcriptTiming: detail.transcript.timing
    property int transcriptSegments: (detail.transcript.segments || []).length
    property int activeSegment: -1
    property var captionTrack: detail.captionTranscript || detail.transcript
    property bool captionAvailable: captionTrack.timing === "segment" && (captionTrack.segments || []).length > 0
    property string activeCaptionText: captionTextAt(position)
    property string captionStatusText: {
        if (detailLoading) return "Carregando a faixa de legendas…"
        if (captionAvailable) {
            const source = detail.captionSource === "diarization"
                ? "Falas automáticas · revise texto e horários" + (detail.captionPartial ? " · faixa parcial" : "")
                : "Faixa de legendas por segmento"
            const label=source+(detail.captionOriginalText?" · texto da faixa original; correções na aba Transcrição":"")
            return captions ? label : "Legendas desativadas · " + label
        }
        if (detail.subtitleState === "running") return "Legendas em preparação; ainda não há faixa disponível."
        return (captions ? "Preferência de legendas ativada. " : "Legendas desativadas. ")
            + (detail.subtitleMessage || "Sem faixa temporizada disponível; a transcrição original continua na aba Transcrição.")
    }
    property int diarizationTurns: (detail.diarization.turns || []).length
    property bool diarizationTab: tabs.currentIndex === 2
    property var captureStatus: ({active: false, session: null, audio: {configured: false}})
    property var jobs: []
    property var selectedJob: ({})
    property string contextText: ""
    property string contextCopyText: ""
    property string contextPath: ""
    property var contextCitations: []
    property bool contextLoading: false
    property int reviewGeneration: 0
    property var reviewTarget: ({})
    property string reviewError: ""
    property bool reviewNeedsReload: false
    property bool revisionSpeakerExplicit: false
    property var exportResult: ({})
    property string exportError: ""
    property int exportGeneration: 0
    property var summaryPlan: ({})
    property string summaryError: ""
    property int summaryGeneration: 0
    property string summaryRequestId: ""
    property string summaryJobId: ""
    property bool summaryRunning: false
    property bool summaryNeedsReload: false
    property bool summaryCompleted: false
    property bool captureBusy: false
    property bool captureKnown: false
    property var speakerRows: {
        const labels=detail.review&&detail.review.speakerLabels
        if(labels)return Object.keys(labels).sort().map(function(id){return {speakerId:id,label:labels[id],anonymous:false}})
        const rows = []
        const seen = ({})
        for (const turn of (detail.diarization.turns || [])) {
            const id = turn.speaker || turn.label || "anonymous"
            if (seen[id]) continue
            seen[id] = true
            rows.push({speakerId: id, label: turn.label || "", anonymous: !turn.label})
        }
        return rows
    }
    palette.window: canvas
    palette.windowText: ink
    palette.base: fieldSurface
    palette.alternateBase: surfaceAlt
    palette.text: ink
    palette.placeholderText: muted
    palette.disabled.text: muted
    palette.disabled.buttonText: muted
    palette.disabled.windowText: muted
    palette.button: buttonSurface
    palette.buttonText: ink
    palette.dark: ink
    palette.mid: dividerStrong
    palette.midlight: divider
    palette.light: surface
    palette.highlight: accent
    palette.highlightedText: onAccent
    palette.toolTipBase: surface
    palette.toolTipText: ink

    // ── Design system ───────────────────────────────────────────────────────
    // Original 24px stroke icons rendered from inline SVG: no icon fonts or external files.
    property var iconPaths: ({
        "alert": '<path d="M12 4l9 16H3z"/><path d="M12 10v4.2M12 17.2v.1"/>',
        "automation-pause": '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
        "automation-play": '<circle cx="12" cy="12" r="9"/><path d="M10.2 8.6v6.8l5.4-3.4z" fill="%C"/>',
        "back": '<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>',
        "check": '<path d="M5 12.5l4.5 4.5L19 7.5" stroke-width="2.6"/>',
        "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
        "context": '<path d="M9 4H8a2 2 0 0 0-2 2v3.5L4.5 12 6 14.5V18a2 2 0 0 0 2 2h1"/><path d="M15 4h1a2 2 0 0 1 2 2v3.5l1.5 2.5-1.5 2.5V18a2 2 0 0 1-2 2h-1"/>',
        "copy": '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
        "edit": '<path d="M5 19l1-4 9.5-9.5a2.1 2.1 0 0 1 3 3L9 18z"/><path d="M14 7l3 3"/>',
        "export": '<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/>',
        "frames": '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-5-5-8.5 8"/>',
        "info": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.1"/>',
        "key": '<circle cx="8" cy="15" r="3.6"/><path d="M10.6 12.4L19 4M15.5 7.5l2.2 2.2M13.3 9.7l1.7 1.7"/>',
        "keyboard": '<rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M7 10h.1M10.3 10h.1M13.6 10h.1M17 10h.1M8 14h8"/>',
        "moon": '<path d="M19.5 14.6A7.8 7.8 0 0 1 9.4 4.5 8 8 0 1 0 19.5 14.6z"/>',
        "note": '<path d="M5 4.5h14v11l-4.5 4.5H5z"/><path d="M14.5 20v-4.5H19"/><path d="M8.5 9h7M8.5 12.5h4"/>',
        "pause": '<rect x="7" y="5.5" width="3.6" height="13" rx="1" fill="%C" stroke="none"/><rect x="13.4" y="5.5" width="3.6" height="13" rx="1" fill="%C" stroke="none"/>',
        "play": '<path d="M8 5.5v13l10.5-6.5z" fill="%C" stroke="none"/>',
        "plug": '<path d="M9 3v4M15 3v4M7 7h10v3a5 5 0 0 1-10 0z"/><path d="M12 15v6"/>',
        "record": '<circle cx="12" cy="12" r="6" fill="%C" stroke="none"/>',
        "refresh": '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>',
        "search": '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
        "shield": '<path d="M12 3.2l7 2.8v5.2c0 4.3-2.9 7.7-7 9.6-4.1-1.9-7-5.3-7-9.6V6z"/><path d="M8.8 12.2l2.3 2.3 4.2-4.6"/>',
        "spark": '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1-5.1-1.9 5.1-1.9z"/>',
        "stop": '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="%C" stroke="none"/>',
        "sun": '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
        "tools": '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
        "transcript": '<path d="M5 6h14M5 10h14M5 14h9M5 18h6"/>',
        "undo": '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
        "users": '<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="16.5" cy="10" r="2.6"/><path d="M15.5 14.2a4.5 4.5 0 0 1 5 4.8"/>'
    })
    function iconUri(name, tint) {
        const body = iconPaths[name]
        if (!body) return ""
        const color = String(tint)
        return "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="' + color
            + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + body.replace(/%C/g, color) + '</svg>')
    }
    function shade(base, amount) { return lightTheme ? Qt.darker(base, 1 + amount) : Qt.lighter(base, 1 + amount) }
    function statusKind(value) {
        if (value === "completed" || value === "archived") return "accent"
        if (value === "failed") return "danger"
        if (["queued", "processing", "transferring", "pending", "archive-pending"].includes(value)) return "warning"
        return "neutral"
    }
    function kindColor(kind) { return kind === "accent" ? accent : kind === "warning" ? warningColor : kind === "danger" ? errorColor : kind === "recording" ? recordingColor : muted }
    function shortDate(value) { const date = new Date(value); return isNaN(date.getTime()) ? "" : Qt.formatDateTime(date, "dd/MM · HH:mm") }
    function longDate(value) { const date = new Date(value); return isNaN(date.getTime()) ? "" : Qt.formatDateTime(date, "dd/MM/yyyy · HH:mm") }
    function artifactParts(value) { return String(value || "").split(" · ").filter(part => part.length > 0) }
    function audioLabel() {
        const configured = captureStatus.audio && captureStatus.audio.configured
        if (!configured) return "Áudio não validado"
        return ({both: "Microfone + áudio do sistema", microphone: "Somente microfone", desktop: "Somente áudio do sistema", none: "Áudio desativado"})[configured.audioSource] || "Áudio: " + configured.audioSource
    }
    function captureNeedsAttention() { return !!(captureStatus.warning || (captureStatus.audio && captureStatus.audio.error)) }
    // Plain-text structure for model Markdown: never rendered as rich text, links or images.
    function sourceSeconds(text) {
        const match = String(text || "").match(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?/)
        if (!match) return -1
        return match[3] !== undefined ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : Number(match[1]) * 60 + Number(match[2])
    }
    function summaryBlocks(markdown) {
        const blocks = []
        for (const raw of String(markdown || "").split("\n")) {
            const line = raw.trim()
            if (!line) continue
            if (line.startsWith("# ")) blocks.push({kind: "title", text: line.slice(2), seconds: -1})
            else if (line.startsWith("## ")) blocks.push({kind: "heading", text: line.slice(3), seconds: -1})
            else if (/^[-*] /.test(line)) blocks.push({kind: "bullet", text: line.slice(2), seconds: sourceSeconds(line)})
            else blocks.push({kind: "paragraph", text: line, seconds: -1})
        }
        return blocks
    }
    property var contextData: {
        if (!contextCopyText) return null
        try {
            const value = JSON.parse(contextCopyText)
            return value && Array.isArray(value.excerpts) ? value : null
        } catch (error) {
            return null
        }
    }
    // Bridge timestamps are epoch numbers; Date.parse on a number falls back to Qt's slow string parser for every comparison.
    function timeValue(value) { return typeof value === "number" ? value : (Date.parse(value) || 0) }
    property var recentItems: items.map(item => ({item: item, at: timeValue(item.modifiedAt)})).sort((a, b) => b.at - a.at).slice(0, 6).map(entry => entry.item)
    property var libraryStats: {
        let transcripts = 0, active = 0, attention = 0
        for (const item of items) {
            if (String(item.artifactStatus || "").startsWith("Transcrição pronta")) transcripts += 1
            if (["queued", "processing", "transferring", "pending", "archive-pending"].includes(item.status)) active += 1
            if (item.status === "failed" || item.location === "missing") attention += 1
        }
        return {total: items.length, transcripts: transcripts, active: active, attention: attention}
    }

    component FtIcon: Item {
        id: iconItem
        property string name: ""
        property color tint: ink
        property int size: 18
        width: size; height: size
        implicitWidth: size; implicitHeight: size
        visible: name !== ""
        Accessible.ignored: true
        Image {
            anchors.fill: parent
            sourceSize.width: iconItem.size * 2; sourceSize.height: iconItem.size * 2
            fillMode: Image.PreserveAspectFit
            smooth: true
            source: iconItem.name !== "" ? iconUri(iconItem.name, iconItem.tint) : ""
        }
    }
    component BrandMark: Item {
        id: brandMark
        property int size: 28
        property color markColor: ink
        property color dotColor: accent
        width: size; height: size
        implicitWidth: size; implicitHeight: size
        Accessible.ignored: true
        Rectangle { x: brandMark.size * 11 / 64; y: brandMark.size * 7 / 64; width: brandMark.size * 22 / 64; height: brandMark.size * 6 / 64; color: brandMark.markColor }
        Rectangle { x: brandMark.size * 11 / 64; y: brandMark.size * 7 / 64; width: brandMark.size * 6 / 64; height: brandMark.size * 50 / 64; color: brandMark.markColor }
        Rectangle { x: brandMark.size * 11 / 64; y: brandMark.size * 51 / 64; width: brandMark.size * 22 / 64; height: brandMark.size * 6 / 64; color: brandMark.markColor }
        Rectangle { x: brandMark.size * 38 / 64; y: brandMark.size * 26 / 64; width: brandMark.size * 12 / 64; height: width; radius: width / 2; color: brandMark.dotColor }
    }
    component FtButton: Button {
        id: buttonControl
        property string variant: highlighted ? "primary" : "secondary"
        property string iconName: ""
        property color iconTint: foreground
        property bool iconOnly: false
        property bool compact: false
        readonly property bool flatVariant: variant === "ghost" || variant === "outline"
        readonly property color baseColor: variant === "primary" ? accent : variant === "danger" ? recordingColor : buttonSurface
        readonly property color foreground: variant === "primary" ? onAccent : variant === "danger" ? (lightTheme ? "#FFFFFF" : "#2B0B0E") : ink
        implicitHeight: compact ? 32 : 36
        implicitWidth: iconOnly ? implicitHeight : Math.max(implicitHeight, implicitContentWidth + leftPadding + rightPadding)
        leftPadding: iconOnly ? 0 : (compact ? 10 : 14)
        rightPadding: iconOnly ? 0 : (compact ? 10 : 14)
        topPadding: 0
        bottomPadding: 0
        font.pixelSize: compact ? 13 : 14
        font.weight: Font.DemiBold
        hoverEnabled: true
        opacity: enabled ? 1 : 0.45
        ToolTip.visible: iconOnly && hovered && text !== ""
        ToolTip.text: text
        ToolTip.delay: 400
        contentItem: Item {
            implicitWidth: (buttonIcon.visible ? buttonIcon.width : 0) + (buttonLabel.visible ? buttonLabel.implicitWidth + (buttonIcon.visible ? 7 : 0) : 0)
            implicitHeight: Math.max(buttonIcon.visible ? buttonIcon.height : 0, buttonLabel.implicitHeight)
            Row {
                anchors.centerIn: parent
                spacing: 7
                FtIcon { id: buttonIcon; name: buttonControl.iconName; tint: buttonControl.iconTint; size: buttonControl.compact ? 15 : 16; anchors.verticalCenter: parent.verticalCenter }
                Label {
                    id: buttonLabel
                    visible: !buttonControl.iconOnly && buttonControl.text !== ""
                    width: Math.min(implicitWidth, Math.max(0, buttonControl.availableWidth - (buttonIcon.visible ? buttonIcon.width + 7 : 0)))
                    text: buttonControl.text
                    font: buttonControl.font
                    color: buttonControl.foreground
                    elide: Text.ElideRight
                    textFormat: Text.PlainText
                    anchors.verticalCenter: parent.verticalCenter
                }
            }
        }
        background: Rectangle {
            radius: 8
            color: buttonControl.flatVariant
                ? (buttonControl.down ? selectedSurface : buttonControl.hovered ? hoverSurface : "transparent")
                : (buttonControl.down ? shade(buttonControl.baseColor, 0.16) : buttonControl.hovered ? shade(buttonControl.baseColor, 0.08) : buttonControl.baseColor)
            border.width: buttonControl.variant === "outline" ? 1 : 0
            border.color: dividerStrong
            Rectangle {
                anchors.fill: parent
                anchors.margins: -3
                radius: 11
                color: "transparent"
                border.width: 2
                border.color: accent
                visible: buttonControl.visualFocus
            }
        }
    }
    component FtNavButton: Button {
        id: navControl
        property string iconName: ""
        Layout.fillWidth: true
        implicitHeight: 38
        leftPadding: 10
        rightPadding: 10
        hoverEnabled: true
        font.pixelSize: 14
        opacity: enabled ? 1 : 0.45
        contentItem: RowLayout {
            spacing: 10
            FtIcon { name: navControl.iconName; tint: accent; size: 17 }
            Label { text: navControl.text; font: navControl.font; color: ink; elide: Text.ElideRight; textFormat: Text.PlainText; Layout.fillWidth: true }
        }
        background: Rectangle {
            radius: 8
            color: navControl.down ? selectedSurface : navControl.hovered ? hoverSurface : "transparent"
            border.width: navControl.visualFocus ? 2 : 0
            border.color: accent
        }
    }
    component FtTextField: TextField {
        id: fieldControl
        property string leadingIcon: ""
        implicitHeight: 38
        leftPadding: leadingIcon ? 36 : 12
        rightPadding: 12
        color: ink
        placeholderTextColor: muted
        selectionColor: accent
        selectedTextColor: onAccent
        font.pixelSize: 14
        background: Rectangle {
            radius: 8
            color: fieldSurface
            opacity: fieldControl.enabled ? 1 : 0.6
            border.width: fieldControl.activeFocus ? 2 : 1
            border.color: fieldControl.activeFocus ? accent : fieldControl.hovered ? dividerStrong : divider
            FtIcon { name: fieldControl.leadingIcon; tint: muted; size: 16; anchors.left: parent.left; anchors.leftMargin: 12; anchors.verticalCenter: parent.verticalCenter }
        }
    }
    component FtComboBox: ComboBox {
        id: comboControl
        implicitHeight: 38
        font.pixelSize: 14
        background: Rectangle {
            implicitWidth: 140
            implicitHeight: 38
            radius: 8
            color: fieldSurface
            border.width: comboControl.visualFocus ? 2 : 1
            border.color: comboControl.visualFocus ? accent : comboControl.hovered ? dividerStrong : divider
        }
    }
    component FtCard: Rectangle {
        radius: 12
        color: surface
        border.width: 1
        border.color: divider
    }
    component FtChip: Rectangle {
        id: chipControl
        property string text: ""
        property string kind: "neutral"
        property string iconName: ""
        property real maximumWidth: 420
        readonly property color foreground: kindColor(kind)
        implicitHeight: 24
        implicitWidth: Math.min(maximumWidth, (chipIcon.visible ? 27 : 10) + chipLabel.implicitWidth + 10)
        radius: 12
        color: kind === "accent" ? accentSoft : kind === "warning" ? warningSoft : kind === "danger" ? errorSoft : kind === "recording" ? recordingSoft : surfaceAlt
        border.width: kind === "neutral" ? 1 : 0
        border.color: divider
        FtIcon { id: chipIcon; name: chipControl.iconName; tint: chipControl.foreground; size: 13; anchors.left: parent.left; anchors.leftMargin: 9; anchors.verticalCenter: parent.verticalCenter }
        Label {
            id: chipLabel
            anchors.left: parent.left
            anchors.leftMargin: chipIcon.visible ? 27 : 10
            anchors.right: parent.right
            anchors.rightMargin: 10
            anchors.verticalCenter: parent.verticalCenter
            text: chipControl.text
            textFormat: Text.PlainText
            color: chipControl.foreground
            font.pixelSize: 12
            font.weight: Font.Medium
            elide: Text.ElideRight
        }
    }
    component FtOverline: Label {
        color: muted
        font.pixelSize: 11
        font.weight: Font.DemiBold
        font.letterSpacing: 0.8
        font.capitalization: Font.AllUppercase
    }
    component FtDialog: Dialog {
        id: dialogControl
        padding: 20
        topPadding: 6
        palette.window: surface
        palette.base: fieldSurface
        palette.button: buttonSurface
        background: Rectangle { radius: 14; color: surface; border.width: 1; border.color: divider }
        header: Label {
            text: dialogControl.title
            visible: text !== ""
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: ink
            font.pixelSize: 18
            font.weight: Font.DemiBold
            leftPadding: 20
            rightPadding: 20
            topPadding: 18
            bottomPadding: 10
            background: Item {}
        }
        Overlay.modal: Rectangle { color: lightTheme ? "#80102B2A" : "#B3030808" }
    }

    property bool mockFramesEnabled: false
    property bool realFramesEnabled: false
    property var frameCapability: ({})
    property var frameScope: ({})
    property var framePlan: ({})
    property var framePreview: ({})
    property var frameResult: ({})
    property bool showVisualSummary: false
    property real sourceReferenceSeconds: -1
    property int frameGeneration: 0
    property var onboardingDraft: ({})
    property int onboardingGeneration: 0
    property string onboardingError: ""
    property bool onboardingNeedsReload: false
    property bool onboardingSaveUncertain: false
    property string uxError: ""
    property bool showAgentSetup: false
    property bool agentLoaded: false
    property int agentGeneration: 0
    property string preferredGrantId: ""
    property var agentState: ({grants:[], budget:({}), capabilities:({})})
    property var agentResult: ({})
    property string agentError: ""
    property var visibleGrants: agentState.grants.filter(function(g){return g.recipient.kind === (agentMode.currentIndex===0?"agent":"provider")})
    property var activeGrant: visibleGrants.length && grantPicker.currentIndex >= 0 ? visibleGrants[grantPicker.currentIndex] : ({})
    function changeAgentAccess(action) { cancelProvider(); const id=activeGrant.id; if(hasPending("agent-frames"))send("agent-cancel",selected.key,{grantId:id}); agentResult=({});agentGeneration+=1;agentError="";send(action,selected.key,{grantId:id}) }
    property var providerResult: ({})
    property string providerRequestUUID: ""
    property string providerPendingGrant: ""
    function newRequestUUID(){return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){const r=Math.floor(Math.random()*16);return (c==="x"?r:(r&3|8)).toString(16)})}
    function providerOptions(){const price=function(field){return field.text.trim()===""?null:Number(field.text)};return {maxRequests:Number(providerRequests.value),maxContextCharacters:providerContext.checked?1000:0,maxOutputTokens:512,timeoutMs:10000,estimatedBudgetUsd:price(providerCostLimit),acceptUnknownCost:providerUnknown.checked,rates:{inputUsdPerMillion:price(providerInputRate),outputUsdPerMillion:price(providerOutputRate),imageInputTokens:price(providerImageTokens),source:providerTariffSource.text||"unknown",asOf:null}}}
    function authorizeProvider(){send("provider-authorize",selected.key,{provider:providerPicker.currentIndex===0?"openai":"google",model:providerModel.text,analysis:providerOptions(),context:providerContext.checked,maxFrames:2,maxBytes:2097152,consent:true})}
    function cancelProvider(){if(providerPendingGrant && hasPending("provider-analyze"))send("provider-cancel",selected.key,{grantId:providerPendingGrant});providerPendingGrant="";providerResult=({});}
    property string frameGrantPending: ""
    function changeAgentGrant() { cancelProvider(); providerRequestUUID=""; if(frameGrantPending && hasPending("agent-frames")){send("agent-cancel",selected.key,{grantId:frameGrantPending});}agentGeneration+=1;frameGrantPending="";agentResult=({});agentError="";if(agentDialog.visible)send("agent-status",selected.key) }
    function openAgentAccess() { agentDialog.open() }
    function closeAgentAccess() { cancelProvider(); if (activeGrant.id && hasPending("agent-frames")) send("agent-cancel", selected.key, {grantId:activeGrant.id}); agentDialog.close() }
    property string cliVersion: ""
    property var releaseInfo: ({})
    property bool uxModal: aboutDialog.visible || captureConsent.visible || framesDialog.visible || onboardingDialog.visible || agentDialog.visible || recordingTools.visible || reviewDialog.visible || exportDialog.visible || summaryDialog.visible
    function summaryBusy() { return summaryRunning || hasPending("summary-plan") || hasPending("summary-run") }
    function summaryPlanText() {
        const p=summaryPlan
        if (!p.requestId) return hasPending("summary-plan") ? "Preparando plano local; nenhum modelo chamado…" : "Escolha o limite e prepare o plano. Nenhum modelo é chamado nesta etapa."
        const provider=p.provider||({}), cost=p.cost||({})
        return "Modelo: "+provider.provider+" / "+provider.model+"\nDestino: "+(provider.endpoint||"Indisponível")+
            "\nRevisão "+p.revision+" · "+p.inputCharacters+" caracteres de transcrição · "+p.chunkCount+" partes · limite "+p.maxRequests+" chamadas"+
            "\nContexto do job: "+(p.contextIncluded?"incluído":"omitido")+". Notas humanas sem tempo e rótulos acústicos não entram no modelo."+
            "\nCusto: "+(cost.state==="known"?String(cost.estimatedUsd)+" USD":"desconhecido; processamento local consome recursos, sem estimativa monetária")+
            "\nLimite persistente: 32 pedidos por gravação, até 8 chamadas por plano. Nova sessão não repõe o limite."
    }
    function abandonSummary() {
        if (!summaryCompleted && summaryRequestId && summaryJobId && backend.available) send("summary-cancel",summaryJobId,{requestId:summaryRequestId})
        summaryGeneration+=1;summaryPlan=({});summaryConsent.checked=false;summaryRequestId="";summaryJobId="";summaryRunning=false;summaryCompleted=false
    }
    function summaryConnectionLost() {
        summaryGeneration+=1;summaryPlan=({});summaryConsent.checked=false;summaryRunning=false;summaryNeedsReload=true
        if(summaryDialog.visible)summaryError="Conexão perdida; a geração pode ter iniciado. Releia o resumo antes de preparar outro pedido. O original foi preservado."
    }
    function openSummary() {
        if(!backend.available || !detail.review || revisionPending() || summaryBusy())return
        summaryDialog.open()
    }
    function prepareSummary() {
        if(!backend.available || !summaryJobId || summaryBusy() || summaryNeedsReload || summaryPlan.requestId)return
        summaryRequestId=newRequestUUID();summaryError="";summaryConsent.checked=false
        send("summary-plan",summaryJobId,{requestId:summaryRequestId,maxRequests:Number(summaryBudget.value)})
    }
    function generateSummary() {
        if(!backend.available || summaryBusy() || summaryNeedsReload || !summaryConsent.checked || !summaryPlan.requestId)return
        summaryRunning=true;summaryError=""
        if(send("summary-run",summaryJobId,{requestId:summaryPlan.requestId,consent:true,consentKey:summaryPlan.consentKey})<0)summaryConnectionLost()
    }
    function cancelFramePreview() {
        if (framePlan.id || framePreview.id || hasPending("frames-preview") || hasPending("frames-plan") || hasPending("frames-preview-plan") || hasPending("frames-scope")) send("frames-cancel", selected.key, {previewId: framePreview.id || ""})
        frameGeneration += 1; framePlan = ({}); framePreview = ({}); frameResult = ({})
    }
    function prepareFrames() {
        cancelFramePreview(); uxError = ""
        send("frames-preview", selected.key, {question: frameQuestion.text, seconds: Number(frameSeconds.text), capabilityId: frameCapability.id || ""})
    }
    function selectionChanged() {
        const id=frameScope.id || ""; cancelFramePreview();
        send("frames-cancel",selected.key,{previewId:"",scopeId:id})
        frameScope=({}); plannerTranscriptConsent.checked=false
    }
    function prepareTranscriptScope() {
        selectionChanged(); uxError=""
        send("frames-scope",selected.key,{startSeconds:Number(scopeStart.text),endSeconds:Number(scopeEnd.text)})
    }
    function planFrames() {
        cancelFramePreview(); uxError = ""
        send("frames-plan",selected.key,{capabilityId:frameCapability.id || "",consentTranscript:plannerTranscriptConsent.checked,scopeId:frameScope.id || ""})
    }
    function previewPlannedFrames() {
        framePreview=({}); frameResult=({}); uxError=""
        send("frames-preview-plan",selected.key,{planId:framePlan.id || ""})
    }
    function followAt(time) {
        sourceReferenceSeconds=time; framesDialog.close(); if(mediaReady)seek(time); else notice="Referência selecionada em " + preciseClock(time) + ". Playback físico não validado."
    }
    function followFrameReference() {
        if (!frameResult.sourceKey || frameResult.sourceKey !== selected.key) return
        const time = frameResult.timestampSeconds
        sourceReferenceSeconds = time; framesDialog.close()
        if (mediaReady) seek(time)
        else notice = "Referência selecionada em " + preciseClock(time) + ". Abra o vídeo para reproduzir; playback não validado no fixture."
    }
    function confirmFrames() {
        if (framePreview.id && !hasPending("frames-confirm")) send("frames-confirm", selected.key, {previewId: framePreview.id, consent: true, consentKey: framePreview.consentKey || ""})
    }
    FtDialog {
        id: framesDialog; objectName: "framesDialog"
        title: mockFramesEnabled ? "Frames · ensaio local com mock" : "Frames · análise local sob consentimento"
        anchors.centerIn: parent; width: Math.min(window.width - 64, 560)
        height: Math.min(implicitHeight, window.height - 64)
        modal: true; closePolicy: Popup.CloseOnEscape
        onOpened: { frameQuestion.text = "O que falta verificar neste momento?"; frameSeconds.text = "0"; frameScope=({}); scopeStart.text="0"; scopeEnd.text=""; plannerTranscriptConsent.checked=false; uxError = "" }
        onClosed: selectionChanged()
        contentItem: ScrollView {
          id: frameScroll; clip: true; contentWidth: availableWidth; implicitHeight: frameColumn.implicitHeight
          ColumnLayout {
            id: frameColumn; width: frameScroll.availableWidth; spacing: 12
            Label { objectName: "processingWaitLabel"; visible: !!processingWait; text: "Fila global · " + processingWait; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: warningColor; Layout.fillWidth: true }
            Label { text: mockFramesEnabled ? "Preview: extração local limitada · provider mock-local, nenhuma IA real. Preview baseado no transcript, tempo aproximado. Budget: 8 previews/4 inferências mock por sessão. Abrir esta tela não chama o mock." : "Ollama loopback apenas. Verificar modelos consulta metadados; preview extrai localmente. Só Confirmar envia o frame/pergunta à visão e transcrição/observações ao resumo. Budget comum da instalação: limites e período abaixo após verificar modelos. 24/16 são defaults temporários alpha, configuráveis explicitamente; não são orçamento financeiro. Falhas consomem; sem reset por sessão. Nenhuma assinatura/API externa é usada."; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: muted; Layout.fillWidth: true }
            Label { visible: !mockFramesEnabled; text: "Provider: Ollama local · modelos explícitos (não salva configuração)"; wrapMode: Text.WordWrap; color: ink; Layout.fillWidth: true }
            FtTextField { id: frameVisionModel; objectName: "frameVisionModel"; visible: !mockFramesEnabled; placeholderText: "Modelo instalado com capability vision"; Accessible.name: "Modelo local de visão"; Layout.fillWidth: true; maximumLength: 200; onTextEdited: { cancelFramePreview(); frameCapability=({}) } }
            FtTextField { id: frameSummaryModel; objectName: "frameSummaryModel"; visible: !mockFramesEnabled; placeholderText: "Modelo instalado com capability completion"; Accessible.name: "Modelo local para resumo"; Layout.fillWidth: true; maximumLength: 200; onTextEdited: { cancelFramePreview(); frameCapability=({}) } }
            FtButton { visible: !mockFramesEnabled; text: hasPending("frames-check-models") ? "Verificando…" : "Verificar modelos locais"; enabled: !!selected.key && !!frameVisionModel.text && !!frameSummaryModel.text && !hasPending("frames-check-models") && !hasPending("frames-confirm"); onClicked: { cancelFramePreview(); frameCapability=({}); send("frames-check-models",selected.key,{visionModel:frameVisionModel.text,summaryModel:frameSummaryModel.text}) } }
            Label { visible: !mockFramesEnabled && !!frameCapability.id; text: "Capabilities observadas: vision / completion · " + (frameCapability.endpoint || "") + " · " + frameCapability.visionModel + " / " + frameCapability.summaryModel + " · verificação expira em 5 min"; wrapMode: Text.WordWrap; textFormat: Text.PlainText; color: accent; Layout.fillWidth: true }
            Label { visible: !mockFramesEnabled && !!frameCapability.id; text: "Budget · usuário/instalação · período lifetime (sem renovação): " + (frameCapability.budgetLimits ? frameCapability.budgetLimits.maxInferences + " inferências / " + frameCapability.budgetLimits.maxPreviews + " previews" : "indisponível") + (frameCapability.temporaryAlphaDefaults ? " · defaults temporários alpha" : " · configuração explícita, mudanças auditadas") + ". Modelo local usa recursos da máquina; nenhum preço monetário estimado."; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: muted; Layout.fillWidth: true }
            Label { visible: !mockFramesEnabled; text: "Seleção explícita da transcrição · segundos absolutos do vídeo. Somente segmentos inteiros dentro do intervalo; trechos que cruzam bordas ficam omitidos."; wrapMode: Text.WordWrap; textFormat: Text.PlainText; color: muted; Layout.fillWidth: true }
            RowLayout { visible: !mockFramesEnabled; Layout.fillWidth:true; FtTextField { id:scopeStart; objectName:"scopeStart"; placeholderText:"Início (s)"; text:"0"; maximumLength:16; Layout.fillWidth:true; Accessible.name:"Início absoluto da seleção em segundos"; onTextEdited:selectionChanged() } FtTextField { id:scopeEnd; objectName:"scopeEnd"; placeholderText:"Fim (s)"; maximumLength:16; Layout.fillWidth:true; Accessible.name:"Fim absoluto da seleção em segundos"; onTextEdited:selectionChanged() } }
            FtButton { objectName:"prepareScopeButton"; visible:!mockFramesEnabled; text:hasPending("frames-scope")?"Preparando trecho…":"Revisar trecho incluído e omitido"; enabled:!!selected.key && !!scopeEnd.text && !hasPending("frames-scope") && !hasPending("frames-confirm"); onClicked:prepareTranscriptScope() }
            Label { objectName:"scopeSummaryLabel"; visible:!!frameScope.id; text:frameScope.id?"Incluído: " + preciseClock(frameScope.startSeconds) + "–" + preciseClock(frameScope.endSeconds) + " · " + frameScope.includedCount + " de " + frameScope.totalSegments + " segmentos · " + frameScope.characters + "/" + frameScope.maxCharacters + " caracteres serializados\nOmitido: " + frameScope.omittedCount + " (antes " + frameScope.omittedBefore + ", depois " + frameScope.omittedAfter + ", cruzam borda " + frameScope.omittedIntersecting + "). Limite: " + frameScope.maxSegments + " segmentos. " + (frameScope.withinLimits?"Trecho abaixo disponível para revisar; nada enviado ao planner.":"Acima do limite ou vazio: nenhum conteúdo enviado; reduza/ajuste a seleção. Sem truncamento automático."):""; wrapMode:Text.WordWrap; textFormat:Text.PlainText; color:frameScope.withinLimits?ink:warningColor; Layout.fillWidth:true }
            Repeater { model: frameScope.segments || []; delegate: Label { required property var modelData; text:modelData.id + " · " + preciseClock(modelData.start) + "–" + preciseClock(modelData.end) + " · " + modelData.text; wrapMode:Text.WordWrap; textFormat:Text.PlainText; color:muted; Layout.fillWidth:true } }
            CheckBox { id: plannerTranscriptConsent; objectName: "plannerTranscriptConsent"; visible: !mockFramesEnabled; text: "Autorizar somente o trecho revisado ao planner local (sem imagens)"; checked: false; enabled:!!frameScope.id && frameScope.withinLimits; Layout.fillWidth: true; onToggled: { if (!checked) cancelFramePreview() } }
            FtButton { objectName: "planFramesButton"; visible: !mockFramesEnabled; text: hasPending("frames-plan") ? "Planejando…" : "Decidir pelo transcript: precisa de frames?"; enabled: !!frameCapability.id && !!frameScope.id && frameScope.withinLimits && plannerTranscriptConsent.checked && !hasPending("frames-plan") && !hasPending("frames-confirm"); onClicked: planFrames() }
            Label { objectName: "plannerDecisionLabel"; visible: !!framePlan.id; text: framePlan.id ? "Decisão: " + framePlan.decision + " · " + framePlan.rationale + (framePlan.plannerCacheHit ? "\nPlano reutilizado do cache; nenhuma nova inferência de planejamento." : "\nUma tentativa de planner local consumida.") + (framePlan.decision === "frames" ? "\nPlano proposto; nenhum frame enviado. Revisar fonte → preview → consentimento." : "\nNenhum frame solicitado/enviado; resumo existente preservado.") : ""; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: ink; Layout.fillWidth: true }
            Repeater { model: framePlan.sources || []; delegate: Label { required property var modelData; text: modelData.segmentId + " · citação: " + modelData.quote; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: muted; Layout.fillWidth: true } }
            Repeater { model: framePlan.plan ? framePlan.plan.requests : []; delegate: Label { required property var modelData; text: preciseClock(modelData.timestampSeconds) + " · " + modelData.reason + " · " + modelData.segmentIds.join(", ") + "\nPergunta visual: " + modelData.question; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: ink; Layout.fillWidth: true } }
            FtButton { visible: framePlan.decision === "frames"; text: "Preparar previews do plano revisado"; enabled: !!framePlan.id && !hasPending("frames-preview-plan") && !hasPending("frames-confirm"); onClicked: previewPlannedFrames() }
            Label { text: "Pergunta"; color: ink }
            FtTextField { id: frameQuestion; objectName: "frameQuestion"; Layout.fillWidth: true; maximumLength: 1000; Accessible.name: "Pergunta para evidência visual"; onTextEdited: cancelFramePreview() }
            Label { text: "Horário em segundos, dentro de um segmento"; color: ink }
            FtTextField { id: frameSeconds; objectName: "frameSeconds"; Layout.fillWidth: true; maximumLength: 10; Accessible.name: "Timestamp em segundos"; onTextEdited: cancelFramePreview() }
            FtButton { text: hasPending("frames-preview") ? "Preview pendente…" : "Preparar preview"; enabled: !!selected.key && (mockFramesEnabled || !!frameCapability.id) && !hasPending("frames-preview") && !hasPending("frames-confirm"); onClicked: prepareFrames() }
            Label { visible: !!framePreview.id; text: framePreview.id ? "Origem: item selecionado · " + preciseClock(framePreview.plan.requests[0].timestampSeconds) + " · " + framePreview.plan.requests[0].segmentIds.join(", ") + (mockFramesEnabled ? "\n1 pedido · provider mock-local · sem custo de modelo · expira em 5 min" : "\nDestino: " + framePreview.endpoint + "\nVisão: " + framePreview.visionModel + " · resumo: " + framePreview.summaryModel + "\nEnviar: " + (framePreview.frames ? framePreview.frames.length : 1) + " JPEG(s); primeiro (" + framePreview.frameBytes + " bytes), pergunta e metadata; depois " + (framePreview.scope ? "somente trecho selecionado + observações para resumo parcial." : "transcrição completa + observações para resumo.") + "\nHash mídia: " + framePreview.mediaHash + "\nHash transcrição: " + framePreview.transcriptHash + "\nFrames: " + (framePreview.frames || []).map(function(f){return preciseClock(f.timestampSeconds) + " · " + f.bytes + " bytes · " + f.sha256}).join("\n") + "\nSaldo no preview (antes de confirmar): " + framePreview.remainingInferences + " inferências comuns / " + framePreview.remainingPreviews + " previews. Consentimento expira em até 5 min.") : ""; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: accent; Layout.fillWidth: true }
            Image { visible: !!framePreview.frameData; source: framePreview.frameData || ""; Layout.fillWidth: true; Layout.preferredHeight: visible ? 100 : 0; fillMode: Image.PreserveAspectFit; Accessible.name: "Frame local do timestamp solicitado; não é resultado de IA" }
            Repeater { model: framePreview.framePreviews ? framePreview.framePreviews.slice(1) : []; delegate: Image { required property var modelData; source: modelData.frameData; Layout.fillWidth: true; Layout.preferredHeight: 100; fillMode: Image.PreserveAspectFit; Accessible.name: "Frame adicional do plano consentido" } }
            FtButton { text: hasPending("frames-confirm") ? "Pedido pendente…" : (mockFramesEnabled ? "Confirmar uso do mock local" : "Autorizar visão + novo resumo local"); enabled: !!framePreview.id && !hasPending("frames-confirm") && !frameResult.sourceKey; onClicked: confirmFrames() }
            Label { visible: !!frameResult.sourceKey; text: (frameResult.synthetic ? "Resultado sintético · requer revisão\n" : "Observação do adapter local · requer revisão\n") + (frameResult.text || ""); textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: ink; Layout.fillWidth: true }
            Label { visible: !!frameResult.summaryMarkdown; text: frameResult.scope ? "Resumo parcial do intervalo selecionado · requer revisão\n" + frameResult.summaryMarkdown : "Resumo visual solicitado · requer revisão\n" + (frameResult.summaryMarkdown || ""); textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: ink; Layout.fillWidth: true }
            FtButton { visible: !!frameResult.sourceKey; text: "Ir à origem " + preciseClock(frameResult.timestampSeconds); onClicked: followFrameReference() }
            Repeater { model: frameResult.observations || []; delegate: FtButton { required property var modelData; text: "Origem " + preciseClock(modelData.timestampSeconds) + " · " + modelData.uncertainty; onClicked: followAt(modelData.timestampSeconds) } }
            Label { visible: !!uxError; text: uxError; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: errorColor; Layout.fillWidth: true }
          }
        }
        footer: Item { implicitHeight: 52; FtButton { id: frameCancelButton; objectName: "frameCancelButton"; anchors.right: parent.right; anchors.rightMargin: 12; anchors.verticalCenter: parent.verticalCenter; text: "Cancelar / fechar"; onClicked: framesDialog.reject() } }
    }

    component WrappedCheck: CheckBox {
        id:checkControl; Layout.fillWidth:true
        spacing: 10
        indicator: Rectangle {
            implicitWidth: 22; implicitHeight: 22
            x: checkControl.leftPadding; y: checkControl.topPadding + (checkControl.availableHeight - height) / 2
            radius: 6
            color: checkControl.checked ? accent : fieldSurface
            border.width: checkControl.visualFocus ? 3 : 2
            border.color: checkControl.visualFocus || checkControl.checked ? accent : muted
            opacity: checkControl.enabled ? 1 : 0.5
            FtIcon { anchors.centerIn: parent; name: "check"; size: 16; tint: onAccent; visible: checkControl.checked }
        }
        background:Rectangle { color:"transparent"; radius:6; border.width:checkControl.visualFocus?2:0; border.color:accent }
        contentItem:Text { text:checkControl.text; font:checkControl.font; color:checkControl.enabled?ink:muted; wrapMode:Text.WordWrap; leftPadding:checkControl.indicator.width+checkControl.spacing; verticalAlignment:Text.AlignVCenter }
    }

    FtDialog {
        id:agentDialog; objectName:"agentDialog"; title:"Acesso para IA"
        anchors.centerIn:parent; width:Math.min(window.width-48,720); height:Math.min(window.height-48,740); modal:true
        property bool saving: hasPending("provider-authorize") || hasPending("agent-authorize") || hasPending("agent-revoke") || hasPending("agent-pause") || hasPending("agent-resume")
        property bool detailsOpen:false
        closePolicy:saving ? Popup.NoAutoClose : Popup.CloseOnEscape
        onOpened:{agentLoaded=false;showAgentSetup=false;detailsOpen=false;preferredGrantId="";agentGeneration+=1;agentState=({grants:[],budget:({}),capabilities:({})});agentResult=({});agentError="";agentConsent.checked=false;send("agent-status",selected.key);agentMode.forceActiveFocus(Qt.TabFocusReason)}
        onClosed:{cancelProvider();if(activeGrant.id && hasPending("agent-frames"))send("agent-cancel",selected.key,{grantId:activeGrant.id});agentGeneration+=1;agentConsent.checked=false;agentResult=({});agentAccessButton.forceActiveFocus(Qt.TabFocusReason)}
        contentItem:ScrollView {
          id:agentScrollView; clip:true; contentWidth:availableWidth
          ColumnLayout {
            width:agentScrollView.availableWidth; spacing:12
            Label { text:selected.title||selected.fileName||"Gravação selecionada"; font.pixelSize:20; font.weight:Font.DemiBold; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:ink }
            Label { text:"Escolha quem pode consultar esta gravação. A autorização continua após fechar o Studio; você pode pausar ou revogar a qualquer momento."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
            Label { text:"COMO USAR"; font.pixelSize:11; font.letterSpacing:1; color:accent }
            FtComboBox { id:agentMode; objectName:"agentMode"; enabled:!agentDialog.saving; model:["Meu agente · contexto e imagens locais","Analisar com OpenAI ou Google · API"]; Layout.fillWidth:true; onCurrentIndexChanged:{cancelProvider();providerRequestUUID="";agentGeneration+=1;agentConsent.checked=false;providerConsent.checked=false;agentResult=({});showAgentSetup=visibleGrants.length===0;if(agentDialog.visible)send("agent-status",selected.key)} Accessible.name:"Como usar a gravação com IA" }
            Label { visible:agentMode.currentIndex===0; text:"O agente recebe apenas os dados autorizados. Consultar um frame não executa um modelo de IA. A conexão do seu agente com a CLI é configurada separadamente."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
            Label { visible:agentMode.currentIndex===1; text:agentState.providerAnalysis && agentState.providerAnalysis.available ? "Envio API habilitado. Confira o acesso ao modelo e a tarifa antes de analisar. Assinatura de chat não inclui uso de API." : "Envio API desativado nesta instalação. Você pode preparar a autorização; nenhuma análise será enviada. Acesso ao modelo e tarifas ainda não foram verificados."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:warningColor }
            BusyIndicator { running:hasPending("agent-status")&&!agentLoaded; visible:running; Layout.alignment:Qt.AlignHCenter }

            FtComboBox { id:grantPicker; objectName:"grantPicker"; visible:visibleGrants.length>1; Layout.fillWidth:true; model:visibleGrants.map(function(g){return g.recipient.id+(g.recipient.model?" · "+g.recipient.model:"")+" · "+(g.revoked?"revogado":g.paused?"pausado":"ativo")}); Accessible.name:"Autorizações existentes"; onActivated:changeAgentGrant() }
            Frame { visible:!!activeGrant.id; Layout.fillWidth:true; padding:16
             background:Rectangle { color:surface; radius:10; border.color:divider }
             ColumnLayout { width:parent.width; spacing:10
              Label { text:activeGrant.id ? (activeGrant.revoked?"Acesso revogado":activeGrant.paused?"Acesso pausado":agentMode.currentIndex===1&&(!agentState.providerAnalysis||!agentState.providerAnalysis.available)?"Autorização salva · envio desativado":"Acesso autorizado") : ""; color:activeGrant.paused||activeGrant.revoked||(agentMode.currentIndex===1&&(!agentState.providerAnalysis||!agentState.providerAnalysis.available))?warningColor:accent; font.pixelSize:17; font.weight:Font.DemiBold }
              Label { objectName:"agentGrantLabel"; text:activeGrant.id ? activeGrant.recipient.id+(activeGrant.recipient.model?" · "+activeGrant.recipient.model:"")+"\n"+activeGrant.data.map(function(d){return d==="frames"?"Frames sob pedido":"Transcrição, resumo e busca"}).join(" + ")+"\n"+(activeGrant.scope.includesFuture?"Gravações registradas atuais e futuras · exclusões respeitadas":activeGrant.scope.recordingIds.length===1?"Somente esta gravação":activeGrant.scope.recordingIds.length+" gravações autorizadas")+" · até "+activeGrant.limits.maxFrames+" frames / "+Math.round(activeGrant.limits.maxBytes/1048576)+" MiB por pedido" : ""; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:ink }
              Label { visible:!!activeGrant.scope&&!!activeGrant.scope.includesFuture; text:"Não há filtro garantido de segredos. Exclua gravações sensíveis para cada destinatário antes de consultar frames."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:warningColor }
              Label { visible:!!activeGrant.revoked; text:"Consultas futuras foram bloqueadas. Para autorizar novamente, faça uma nova escolha abaixo. Cópias já entregues não são recolhidas."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
              RowLayout {
               FtButton { objectName:"agentPauseButton"; text:activeGrant.paused?"Retomar acesso":"Pausar acesso"; enabled:!!activeGrant.id&&!activeGrant.revoked&&!agentDialog.saving; onClicked:changeAgentAccess(activeGrant.paused?"agent-resume":"agent-pause") }
               FtButton { objectName:"agentRevokeButton"; text:"Revogar acesso"; enabled:!!activeGrant.id&&!activeGrant.revoked&&!agentDialog.saving; onClicked:changeAgentAccess("agent-revoke") }
              }
             }
            }
            Label { objectName:"agentUsageLabel"; text:agentState.budget.budgetLimits ? "Saldo local: "+agentState.budget.remainingPreviews+" extrações de frame · "+agentState.budget.remainingInferences+" análises. Reiniciar ou criar outra autorização não renova o saldo." : "Lendo limites…"; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
            FtButton { visible:visibleGrants.length>0; text:showAgentSetup?"Ocultar nova autorização":"Autorizar outro destinatário ou outros dados…"; enabled:!agentDialog.saving; onClicked:{showAgentSetup=!showAgentSetup;agentConsent.checked=false;providerConsent.checked=false} }

            ColumnLayout { visible:showAgentSetup && agentMode.currentIndex===0; Layout.fillWidth:true; spacing:10
             Label { text:"1. Destinatário e dados"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
             Label { text:"Nome do agente local"; color:muted }
             FtTextField { id:agentRecipient; objectName:"agentRecipient"; text:"local-agent"; placeholderText:"Ex.: meu-assistente"; enabled:!agentDialog.saving; Layout.fillWidth:true; onTextChanged:agentConsent.checked=false; Accessible.name:"Nome do agente local autorizado" }
             WrappedCheck { id:agentContextData; objectName:"agentContextData"; text:"Consultar transcrição, resumo e buscar esta gravação"; checked:true; enabled:!agentDialog.saving; onCheckedChanged:agentConsent.checked=false }
             WrappedCheck { id:agentFrameData; objectName:"agentFrameData"; text:"Pedir frames, inclusive quando não há transcrição"; checked:true; enabled:!agentDialog.saving; onCheckedChanged:agentConsent.checked=false }
             Label { text:"2. Autorizar uma vez"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
             Label { text:"Somente esta gravação e sua versão atual. Até 2 frames / 2 MiB por pedido, com cache privado de 5 minutos. Futuras gravações não são incluídas. O agente não precisa pedir nova confirmação a cada frame dentro desses limites."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
             WrappedCheck { id:agentConsent; objectName:"agentConsent"; text:"Autorizo este agente a consultar os dados selecionados"; enabled:!agentDialog.saving }
            }

            ColumnLayout { visible:agentMode.currentIndex===1 && showAgentSetup; enabled:!agentDialog.saving; Layout.fillWidth:true; spacing:10
             Label { text:"1. Destino e modelo"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
             FtComboBox { id:providerPicker; objectName:"providerPicker"; model:["OpenAI","Google"]; Layout.fillWidth:true; onCurrentIndexChanged:providerConsent.checked=false }
             Label { text:providerPicker.currentIndex===0?"Destino: https://api.openai.com/v1/responses":"Destino: https://generativelanguage.googleapis.com/v1beta"; textFormat:Text.PlainText; wrapMode:Text.WrapAnywhere; Layout.fillWidth:true; color:muted; font.pixelSize:12 }
             FtTextField { id:providerModel; objectName:"providerModel"; placeholderText:"Nome do modelo com suporte a imagens e JSON"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:"Modelo escolhido para a análise" }
             WrappedCheck { id:providerCapabilities; text:"O modelo escolhido aceita imagens e JSON. O acesso ainda não foi verificado aqui."; onCheckedChanged:providerConsent.checked=false }
             WrappedCheck { id:providerContext; text:"Incluir até 1.000 caracteres da transcrição existente"; onCheckedChanged:providerConsent.checked=false }
             Label { text:"2. Limites e custo"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
             RowLayout { Label { text:"Máximo de pedidos"; color:ink } SpinBox { id:providerRequests; objectName:"providerRequests"; from:1; to:24; value:2; onValueModified:providerConsent.checked=false; Accessible.name:"Máximo de pedidos desta autorização" } }
             Label { text:"Até 2 frames / 2 MiB por pedido e 512 tokens de resposta. Esses pedidos também consomem o saldo local da instalação. A estimativa abaixo não é um limite de cobrança na conta do provider."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
             Label { text:"Tarifas opcionais · deixe em branco se desconhecidas"; color:ink; wrapMode:Text.WordWrap; Layout.fillWidth:true }
             Label { text:"Entrada · USD por milhão de tokens"; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
             FtTextField { id:providerInputRate; placeholderText:"Entrada: USD por milhão de tokens"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:placeholderText }
             Label { text:"Saída · USD por milhão de tokens"; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
             FtTextField { id:providerOutputRate; placeholderText:"Saída: USD por milhão de tokens"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:placeholderText }
             Label { text:"Estimativa de tokens por imagem"; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
             FtTextField { id:providerImageTokens; placeholderText:"Estimativa de tokens por imagem"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:placeholderText }
             Label { text:"Fonte e data das tarifas"; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
             FtTextField { id:providerTariffSource; placeholderText:"Fonte e data das tarifas informadas"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:placeholderText }
             Label { text:"Teto estimado acumulado local · USD"; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
             FtTextField { id:providerCostLimit; placeholderText:"Teto estimado acumulado local em USD (opcional)"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:placeholderText }
             WrappedCheck { id:providerUnknown; objectName:"providerUnknown"; text:"Aceito custo desconhecido. Não significa uso gratuito."; onCheckedChanged:providerConsent.checked=false }
             Label { text:"3. Autorizar uma vez"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
             WrappedCheck { id:providerConsent; objectName:"providerConsent"; text:"Autorizo o destino, modelo, dados e limites acima para esta gravação" }
            }

            ColumnLayout { id:providerQuestionForm; objectName:"providerQuestionForm"; visible:agentMode.currentIndex===1 && !!activeGrant.id && !!agentState.providerAnalysis && agentState.providerAnalysis.available; Layout.fillWidth:true; spacing:10
             Label { text:"Perguntar sobre um momento"; color:ink; font.pixelSize:17; font.weight:Font.DemiBold }
             Label { text:activeGrant.analysis ? "Até "+activeGrant.analysis.maxRequests+" pedidos nesta autorização · "+activeGrant.analysis.maxContextCharacters+" caracteres de contexto\nCusto desconhecido: "+(activeGrant.analysis.acceptUnknownCost?"aceito explicitamente":"análise bloqueada se não houver tarifa") : ""; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
             FtTextField { id:providerQuestion; objectName:"providerQuestion"; placeholderText:"O que você precisa conferir na imagem?"; Layout.fillWidth:true; onTextChanged:providerRequestUUID=""; Accessible.name:"Pergunta sobre a imagem" }
             RowLayout { Label { text:"Instante (segundos)"; color:muted } FtTextField { id:providerSeconds; text:"0"; Layout.fillWidth:true; onTextChanged:providerRequestUUID=""; Accessible.name:"Instante da imagem em segundos" } }
             FtButton { objectName:"providerAnalyzeButton"; text:hasPending("provider-analyze")?"Analisando…":!agentState.providerAnalysis||!agentState.providerAnalysis.available?"Envio API desativado":"Analisar este momento"; enabled:!!agentState.providerAnalysis&&agentState.providerAnalysis.available&&!activeGrant.paused&&!activeGrant.revoked&&!hasPending("provider-analyze")&&!!providerQuestion.text&&isFinite(Number(providerSeconds.text))&&Number(providerSeconds.text)>=0&&providerResult.status!=="uncertain"; onClicked:{agentError="";if(!providerRequestUUID)providerRequestUUID=newRequestUUID();providerPendingGrant=activeGrant.id;send("provider-analyze",selected.key,{grantId:activeGrant.id,requestId:providerRequestUUID,question:providerQuestion.text,timestamps:[Number(providerSeconds.text)]})} }
             FtButton { visible:hasPending("provider-analyze"); text:"Cancelar pedido"; onClicked:{cancelProvider();agentGeneration+=1;agentError="Pedido cancelado. Se já enviado, confira o estado e a cobrança no provider antes de tentar novamente.";send("agent-status",selected.key)} }
             Label { objectName:"providerResultLabel"; visible:!!providerResult.requestId; text:providerResult.requestId ? (providerResult.status==="uncertain"?"Resultado incerto. Confira o estado e a cobrança no provider antes de fazer outro pedido.":providerResult.overview||providerResult.cost||providerResult.status||"")+"\n"+(providerResult.observations||[]).map(function(o){return o.text+"\nFonte: frame "+(o.frameIndex+1)+" em "+(o.decodedTimestampSeconds===null?"instante não verificado":preciseClock(o.decodedTimestampSeconds))+" · incerteza "+o.uncertainty}).join("\n\n")+"\nObservações parciais. Confira a gravação; o resumo completo não foi alterado." : ""; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:ink }
            }

            ColumnLayout { visible:agentMode.currentIndex===0 && !!activeGrant.id && activeGrant.data.includes("frames"); Layout.fillWidth:true; spacing:10
             Label { text:"Preview opcional"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
             Label { text:"Confira um frame local. Seu agente também pode solicitar imagens dentro dos limites autorizados, sem passar por este preview."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
             RowLayout { Label { text:"Instante (segundos)"; color:muted } FtTextField { id:agentTime; objectName:"agentTime"; text:"0"; Layout.fillWidth:true; Accessible.name:"Instante para preview opcional" } }
             FtButton { id:agentPreviewButton; objectName:"agentPreviewButton"; text:hasPending("agent-frames")?"Consultando frame…":"Ver frame local"; enabled:!!activeGrant.id&&!activeGrant.revoked&&!activeGrant.paused&&activeGrant.data.includes("frames")&&!hasPending("agent-frames")&&!agentDialog.saving&&!!agentTime.text&&isFinite(Number(agentTime.text))&&Number(agentTime.text)>=0; onClicked:{agentError="";frameGrantPending=activeGrant.id;send("agent-frames",selected.key,{grantId:activeGrant.id,timestamps:[Number(agentTime.text)]})} }
             FtButton { id:agentCancelPreview; visible:hasPending("agent-frames"); text:"Cancelar consulta"; onClicked:{if(frameGrantPending)send("agent-cancel",selected.key,{grantId:frameGrantPending});agentGeneration+=1;frameGrantPending="";agentResult=({});agentError="Consulta cancelada; autorização preservada.";send("agent-status",selected.key)} }
             Label { id:agentResultLabel; objectName:"agentResultLabel"; text:agentResult.recordingId ? (agentResult.cacheHit?"Cache local reutilizado":"Frame extraído localmente")+"\n"+agentResult.frames.map(function(f){return "Pedido em "+preciseClock(f.requestedTimestampSeconds)+" → "+(f.decodedTimestampSeconds===null?"instante decodificado desconhecido":preciseClock(f.decodedTimestampSeconds))+" · "+(f.precision==="decoded-pts"?"instante verificado do frame":"instante não verificado")}).join("\n") : ""; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:accent }
             Image { objectName:"agentFrameImage"; visible:!!agentResult.frames&&agentResult.frames.length>0; source:visible?"file://"+agentResult.frames[0].file:""; fillMode:Image.PreserveAspectFit; Layout.fillWidth:true; Layout.preferredHeight:190; Accessible.name:"Frame local consultado, com origem temporal exibida" }
            }
            FtButton { text:agentDialog.detailsOpen?"Ocultar detalhes técnicos":"Origem, retenção e detalhes técnicos"; visible:!!activeGrant.id; onClicked:agentDialog.detailsOpen=!agentDialog.detailsOpen }
            Label { visible:agentDialog.detailsOpen; text:activeGrant.id ? "Autorização: "+activeGrant.id+"\nGravação: "+(activeGrant.scope.includesFuture?"Escopo desta instalação, incluindo futuras; destinatário vinculado pelo launcher local, sem autenticação do provedor. Exclua gravações sensíveis; não há detector garantido de segredos.":activeGrant.scope.recordingIds.join(", "))+"\nCache privado: "+(activeGrant.limits.cacheTtlMs/1000)+"s; remoção ao consultar após expirar. Revogar bloqueia consultas futuras, sem recolher cópias já entregues."+(activeGrant.recipient.endpoint?"\nDestino: "+activeGrant.recipient.endpoint:"")+(activeGrant.analysis?"\nTarifas informadas: "+JSON.stringify(activeGrant.analysis.rates)+"\nTeto estimado acumulado: "+(activeGrant.analysis.estimatedBudgetUsd===null?"não configurado":activeGrant.analysis.estimatedBudgetUsd+" USD"):"")+(agentResult.mediaHash?"\nOrigem SHA256: "+agentResult.mediaHash:"")+"\n"+(providerResult.observations||[]).map(function(o){return "Fonte SHA256: "+o.mediaHash+"\nFrame SHA256: "+o.frameSha256+" · precisão "+o.precision}).join("\n")+(agentResult.frames||[]).map(function(f){return "\nFrame SHA256: "+f.sha256+" · precisão "+f.precision}).join("") : ""; textFormat:Text.PlainText; wrapMode:Text.WrapAnywhere; Layout.fillWidth:true; color:muted; font.pixelSize:12 }
            Label { visible:agentMode.currentIndex===1 && agentDialog.detailsOpen; text:agentState.providerAnalysis && agentState.providerAnalysis.usage ? "Registro local: "+agentState.providerAnalysis.usage.attempts+" tentativas · estimado conhecido USD "+agentState.providerAnalysis.usage.knownEstimatedUsd+" · "+agentState.providerAnalysis.usage.unknownCostAttempts+" custos desconhecidos · "+agentState.providerAnalysis.usage.uncertainOutcomes+" resultados incertos. Não é o saldo global da conta do provider." : ""; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
          }
        }
        footer:Item { implicitHeight:agentFooter.implicitHeight+24; ColumnLayout { id:agentFooter; anchors.fill:parent; anchors.margins:12; spacing:8
          Label { id:agentErrorLabel; objectName:"agentErrorLabel"; visible:!!agentError; text:agentError; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:errorColor; Accessible.role:Accessible.AlertMessage }
          RowLayout { Layout.fillWidth:true; spacing:10
          Label { text:agentDialog.saving?"Salvando…":showAgentSetup?"A nova escolha só vale após autorizar.":activeGrant.id?"Fechar mantém a autorização.":"Nenhum acesso autorizado."; color:muted; font.pixelSize:12; Layout.fillWidth:true; wrapMode:Text.WordWrap }
          FtButton { text:"Fechar"; enabled:!agentDialog.saving; onClicked:closeAgentAccess() }
          FtButton { visible:showAgentSetup && agentMode.currentIndex===0; objectName:"agentAuthorizeButton"; highlighted:enabled;  text:agentDialog.saving?"Salvando…":"Autorizar acesso"; enabled:agentConsent.checked && /^[-a-z0-9._]{1,64}$/.test(agentRecipient.text) && (agentContextData.checked||agentFrameData.checked) && !agentDialog.saving; onClicked:send("agent-authorize",selected.key,{recipientId:agentRecipient.text,data:(agentContextData.checked?["context"]:[]).concat(agentFrameData.checked?["frames"]:[]),consent:true}) }
          FtButton { visible:showAgentSetup && agentMode.currentIndex===1; objectName:"providerAuthorizeButton"; highlighted:enabled;  text:hasPending("provider-authorize")?"Salvando…":"Salvar autorização de análise"; enabled:providerConsent.checked&&providerCapabilities.checked&&/^[-a-zA-Z0-9._]{1,160}$/.test(providerModel.text)&&!hasPending("provider-authorize"); onClicked:authorizeProvider() }
        } } }
    }

    FtDialog {
        id:recordingTools; objectName:"recordingTools"; title:"Gravação e processamento"
        anchors.centerIn:parent; width:Math.min(window.width-48,560); height:Math.min(window.height-64,620); modal:true
        closePolicy:Popup.CloseOnEscape
        contentItem:ScrollView { id:toolsScroll; clip:true; contentWidth:availableWidth
            ColumnLayout { width:toolsScroll.availableWidth; spacing:14
                Label { text:"Confira a origem do áudio e as permissões antes de gravar. Pausar a automação não encerra uma captura em andamento."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
                Rectangle {
                    Layout.fillWidth: true
                    implicitHeight: captureToolsColumn.implicitHeight + 32
                    radius: 12; color: surfaceAlt; border.width: 1; border.color: divider
                    ColumnLayout {
                        id: captureToolsColumn
                        anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 16
                        spacing: 10
                        RowLayout {
                            Layout.fillWidth: true; spacing: 8
                            FtIcon { name: "record"; tint: captureStatus.active ? recordingColor : muted; size: 18 }
                            Label { text: "Captura"; color: ink; font.pixelSize: 15; font.weight: Font.DemiBold; Layout.fillWidth: true }
                            FtChip { kind: captureStatus.active ? "recording" : "neutral"; text: !captureKnown ? "Estado desconhecido" : captureStatus.active ? "Ativa" : "Parada" }
                        }
                        Label { textFormat: Text.PlainText; text: captureStatus.warning || (captureStatus.audio && captureStatus.audio.error) || audioSummary(); color: captureNeedsAttention() ? warningColor : muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                        Flow {
                            Layout.fillWidth: true; spacing: 8
                            FtButton { text: "Iniciar…"; iconName: "record"; iconTint: recordingColor; enabled: backend.available && captureKnown && !captureBusy && !captureStatus.active; onClicked: { captureConsent.intent = "capture"; captureConsent.open() } }
                            FtButton { text: "Parar"; variant: "danger"; iconName: "stop"; enabled: backend.available && captureKnown && !captureBusy && captureStatus.active; onClicked: { captureBusy = true; if (send("capture-stop", "") < 0) captureBusy = false } }
                            FtButton { text: "Recuperar"; variant: "outline"; enabled: backend.available && captureKnown && !captureBusy && !captureStatus.active; onClicked: { captureBusy = true; if (send("capture-recover", "") < 0) captureBusy = false } ToolTip.visible: hovered; ToolTip.text: "Finaliza uma captura interrompida sem iniciar outra." }
                        }
                        Rectangle { Layout.fillWidth: true; Layout.preferredHeight: 1; color: divider }
                        Label { text: captureStatus.paused ? "Automação pausada · captura atual continua" : "Automação: confira suas regras"; color: muted; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 12 }
                        Flow {
                            Layout.fillWidth: true; spacing: 8
                            FtButton { text: captureStatus.paused ? "Retomar automação…" : "Pausar novas gravações"; iconName: captureStatus.paused ? "automation-play" : "automation-pause"; enabled: backend.available && !captureBusy; onClicked: { if (captureStatus.paused) { captureConsent.intent = "resume"; captureConsent.open() } else { captureBusy = true; if (send("automation-pause", "") < 0) captureBusy = false } } }
                            FtButton { text: "Configurar áudio"; variant: "outline"; iconName: "tools"; enabled: backend.available && !captureBusy; onClicked: { captureBusy = true; if (send("audio-defaults", "") < 0) captureBusy = false } }
                        }
                    }
                }
                Rectangle {
                    visible: jobs.length > 0
                    Layout.fillWidth: true
                    implicitHeight: jobsColumn.implicitHeight + 32
                    radius: 12; color: surfaceAlt; border.width: 1; border.color: divider
                    ColumnLayout {
                        id: jobsColumn
                        anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 16
                        spacing: 10
                        RowLayout {
                            Layout.fillWidth: true; spacing: 8
                            FtIcon { name: "transcript"; tint: accent; size: 18 }
                            Label { text: "Processamento"; color: ink; font.pixelSize: 15; font.weight: Font.DemiBold; Layout.fillWidth: true }
                            FtChip { text: jobs.length === 1 ? "1 tarefa" : jobs.length + " tarefas" }
                        }
                        FtComboBox { id: jobPicker; Layout.fillWidth: true; model: jobs; textRole: "title"; currentIndex: jobs.findIndex(job => job.id === selectedJob.id); displayText: selectedJob.title || "Selecione uma tarefa"; enabled: backend.available; onActivated: selectedJob = jobs[index] || ({}) }
                        Label { textFormat: Text.PlainText; text: selectedJob.id ? (statusText(selectedJob.state) + (selectedJob.error ? " · " + selectedJob.error : "")) : "Selecione uma tarefa"; color: selectedJob.error ? errorColor : muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                        Label { visible: !!selectedJob.artifactStatus; text: selectedJob.artifactStatus || ""; textFormat: Text.PlainText; color: muted; font.pixelSize: 12; wrapMode: Text.Wrap; Layout.fillWidth: true }
                        Flow {
                            Layout.fillWidth: true; spacing: 8
                            FtButton { text: "Processar"; enabled: backend.available && !hasPending("job-process") && !hasPending("job-retry") && !!selectedJob.id && ["pending", "queued", "transferring"].includes(selectedJob.state); onClicked: send("job-process", selectedJob.id) }
                            FtButton { text: "Repetir"; variant: "outline"; enabled: backend.available && !hasPending("job-process") && !hasPending("job-retry") && !!selectedJob.id && selectedJob.state === "failed"; onClicked: send("job-retry", selectedJob.id) }
                        }
                    }
                }
            }
        }
        footer:Item { implicitHeight:64; FtButton { text:"Fechar"; anchors.right:parent.right; anchors.rightMargin:20; anchors.verticalCenter:parent.verticalCenter; onClicked:recordingTools.close() } }
    }

    FtDialog {
        id:onboardingDialog; objectName:"onboardingDialog"; title:"Configuração e privacidade"
        anchors.centerIn:parent; width:Math.min(window.width-48,580); height:Math.min(window.height-64,600); modal:true
        closePolicy:hasOnboardingPending("onboarding-save-local")?Popup.NoAutoClose:Popup.CloseOnEscape
        onOpened:{onboardingError="";onboardingNeedsReload=false;onboardingSaveUncertain=false;loadOnboarding();onboardingCancel.forceActiveFocus(Qt.TabFocusReason)}
        onClosed:{onboardingGeneration+=1;onboardingDraft=({});localChoice.checked=false;onboardingButton.forceActiveFocus(Qt.TabFocusReason)}
        contentItem:ColumnLayout { spacing:12
         Label { objectName:"onboardingError"; visible:!!onboardingError; text:onboardingError; textFormat:Text.PlainText; wrapMode:Text.WordWrap; color:errorColor; Layout.fillWidth:true; Accessible.name:text }
         ScrollView { id:onboardingScroll; objectName:"onboardingScroll"; clip:true; contentWidth:availableWidth; Layout.fillWidth:true; Layout.fillHeight:true
         ColumnLayout { width:onboardingScroll.availableWidth; spacing:16
          Label { text:onboardingDraft.revision?(onboardingDraft.exists?"Suas escolhas atuais":"Comece neste computador"):(hasOnboardingPending("onboarding-read")?"Lendo configuração…":"Releia a configuração"); color:ink; font.pixelSize:22; font.weight:Font.DemiBold; wrapMode:Text.WordWrap; Layout.fillWidth:true }
          Label { text:onboardingDraft.exists?"Você só altera a configuração ao salvar. Cancelar mantém tudo como está.":"Escolha o processamento local para a primeira configuração. Esta tela não instala modelos nem inicia uma gravação."; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
          Frame { visible:!!onboardingDraft.revision; Layout.fillWidth:true; padding:14
           background:Rectangle { color:surface; radius:8; border.color:divider }
           ColumnLayout { width:parent.width; spacing:8
            Label { text:"ROTAS ATUAIS DE PROCESSAMENTO"; font.pixelSize:11; font.letterSpacing:1; color:accent }
            Label { text:onboardingDraft.revision?"Transcrição: "+onboardingDraft.transcriptionDestination:""; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:onboardingDraft.transcriptionLocal?ink:warningColor }
            Label { text:onboardingDraft.revision ? "Resumo: "+onboardingDraft.summaryProvider+" · "+onboardingDraft.destination : ""; textFormat:Text.PlainText; wrapMode:Text.WrapAnywhere; Layout.fillWidth:true; color:onboardingDraft.local?ink:warningColor }
            Label { text:onboardingDraft.revision?"Execução: "+onboardingDraft.processingDestination:""; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:onboardingDraft.processingTarget==="local"?ink:warningColor }
            Label { text:"Processamento automático após gravação: "+(onboardingDraft.automaticEnqueue?"ativado":"desativado"); wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
            Label { text:"Arquivamento: "+(onboardingDraft.archiveEnabled?(onboardingDraft.archiveDestinations||[]).join(", "):"desativado")+". S3: "+(onboardingDraft.s3Enabled?"ativado":"desativado")+". Integração Proton: "+(onboardingDraft.protonEnabled?"ativada":"desativada")+"."; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
            Label { visible:!!onboardingDraft.timesheetAIExternal; text:"Classificação de atividades com IA externa está ativada."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:warningColor }
            Label { text:(!onboardingDraft.local||!onboardingDraft.transcriptionLocal||onboardingDraft.processingTarget!=="local"||onboardingDraft.archiveExternal||onboardingDraft.s3Enabled||onboardingDraft.protonEnabled||onboardingDraft.timesheetAIExternal)?"Há rotas externas configuradas. Confira antes de processar ou arquivar conteúdo.":"Rotas de transcrição e resumo configuradas para este computador. Modelos ainda não validados."; color:warningColor; wrapMode:Text.WordWrap; Layout.fillWidth:true }
           }
          }
          WrappedCheck { id:localChoice; objectName:"localChoice"; text:"Usar Whisper.cpp para transcrição e Ollama neste computador para resumos"; enabled:backend.available&&!!onboardingDraft.revision&&!hasOnboardingPending("onboarding-read")&&!hasOnboardingPending("onboarding-save-local"); Accessible.name:text
          }
          Label { text:"Ao salvar esta escolha"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
          Label { text:"• A transcrição, os resumos e a execução ficam configurados para este computador. O processamento automático após gravação fica desativado.\n• As demais opções, incluindo arquivamento, S3, Proton, classificação de atividades e regras de gravação, são preservadas.\n• Se já há configuração, é criada uma cópia privada de segurança. Serviços existentes podem usar a nova escolha nas próximas execuções."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
          Label { text:"Whisper.cpp, Ollama e os modelos precisam estar instalados separadamente. Esta tela não instala modelos, não verifica o comportamento de comandos personalizados nem valida a qualidade dos resultados. Uma assinatura de chat não inclui uso de API."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted; font.pixelSize:12 }
          Label { visible:!!onboardingDraft.retention; text:onboardingDraft.retention?"Retenção configurada (dias; 0 desativa o prazo): dados de trabalho locais concluídos "+onboardingDraft.retention.localCompletedWorkDays+"; worker — entradas parciais "+onboardingDraft.retention.remoteIncomingDays+", resultados "+onboardingDraft.retention.remoteResultsDays+", falhas "+onboardingDraft.retention.remoteFailuresDays+".":""; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted; font.pixelSize:12 }
          Label { text:"A limpeza local atua em dados de trabalho de jobs concluídos elegíveis. Ela não é uma exclusão completa da gravação: cópias remotas, exports e outros derivados podem permanecer. Revise o alcance sem apagar arquivos: falatrace jobs cleanup --dry-run."; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted; font.pixelSize:12 }
         }
         }
        }
        footer:Item { implicitHeight:60; RowLayout { anchors.fill:parent; anchors.margins:12; spacing:10
         Item { Layout.fillWidth:true }
         FtButton { id:onboardingCancel; objectName:"onboardingCancel"; text:"Cancelar"; enabled:!hasOnboardingPending("onboarding-save-local"); onClicked:onboardingDialog.reject() }
         FtButton { id:onboardingReload; objectName:"onboardingReload"; visible:onboardingNeedsReload||!!onboardingError; text:backend.available?"Reler configuração":"Reconectar"; enabled:!hasOnboardingPending("onboarding-read")&&!hasOnboardingPending("onboarding-save-local"); onClicked:{if(backend.available)loadOnboarding();else backend.reconnect()} }
         FtButton { id:onboardingSaveButton; objectName:"onboardingSaveButton"; highlighted:enabled;  text:hasOnboardingPending("onboarding-save-local")?"Salvando…":"Salvar escolha local"; enabled:backend.available&&localChoice.checked&&!!onboardingDraft.revision&&!hasOnboardingPending("onboarding-read")&&!hasOnboardingPending("onboarding-save-local"); onClicked:{if(enabled)send("onboarding-save-local","",{revision:onboardingDraft.revision})} }
        } }
    }

    function hasOnboardingPending(op) {
        return Object.keys(pending).some(id => pending[id].op===op && pending[id].onboardingGeneration===onboardingGeneration)
    }
    function loadOnboarding() {
        if(hasOnboardingPending("onboarding-save-local")||hasOnboardingPending("onboarding-read"))return
        onboardingGeneration+=1;onboardingDraft=({});localChoice.checked=false
        if(!backend.available){invalidateOnboarding("Serviço indisponível. Reconecte e releia a configuração antes de salvar.");return}
        onboardingError="";onboardingNeedsReload=false;send("onboarding-read","")
    }
    function invalidateOnboarding(message) {
        onboardingGeneration+=1;onboardingDraft=({});localChoice.checked=false;onboardingNeedsReload=true;onboardingError=message
    }
    function onboardingConnectionLost() {
        if(!onboardingDialog.visible)return
        onboardingSaveUncertain=onboardingSaveUncertain||hasOnboardingPending("onboarding-save-local")
        invalidateOnboarding(onboardingSaveUncertain?"Conexão perdida durante o salvamento; o resultado ainda não foi confirmado. Reconecte e releia a configuração antes de tentar novamente.":"Serviço desconectado. Reconecte e releia a configuração antes de salvar.")
    }

    function revealFocusedControl(scroll) {
        const item=window.activeFocusItem
        if(!item || !scroll.visible || !scroll.contentItem || typeof scroll.contentItem.contentY!=="number")return
        let parentItem=item
        while(parentItem && parentItem!==scroll)parentItem=parentItem.parent
        if(parentItem!==scroll)return
        const viewport=scroll.contentItem, point=item.mapToItem(viewport,0,0)
        let y=viewport.contentY
        if(point.y<8)y+=point.y-8
        else if(point.y+item.height>viewport.height-8)y+=point.y+item.height-viewport.height+8
        viewport.contentY=Math.max(0,Math.min(y,Math.max(0,viewport.contentHeight-viewport.height)))
    }
    function revealFocusedListControl(list) {
        const item=window.activeFocusItem
        if(!item||!list.visible)return
        let parentItem=item
        while(parentItem&&parentItem!==list)parentItem=parentItem.parent
        if(parentItem!==list)return
        const point=item.mapToItem(list,0,0)
        let y=list.contentY
        if(point.y<4)y+=point.y-4
        else if(point.y+item.height>list.height-4)y+=point.y+item.height-list.height+4
        list.contentY=Math.max(list.originY,Math.min(y,Math.max(list.originY,list.originY+list.contentHeight-list.height)))
    }
    onActiveFocusItemChanged:Qt.callLater(function(){
        if(agentDialog.visible)revealFocusedControl(agentScrollView)
        if(onboardingDialog.visible)revealFocusedControl(onboardingScroll)
        if(recordingTools.visible)revealFocusedControl(toolsScroll)
        if(framesDialog.visible)revealFocusedControl(frameScroll)
        revealFocusedListControl(revisionSegmentsList);revealFocusedListControl(revisionSpeakersList);revealFocusedListControl(revisionTurnsList)
    })
    onClosing:event=>{if(revisionPending()||hasPending("export-save")){event.accepted=false;notice="Aguarde a confirmação da operação local antes de fechar."}}

    property bool textHasFocus: !!activeFocusItem && typeof activeFocusItem.cursorPosition === "number"

    function clock(seconds) {
        const value = Math.max(0, Math.floor(seconds || 0))
        return Math.floor(value / 60).toString().padStart(2, "0") + ":" + (value % 60).toString().padStart(2, "0")
    }
    function preciseClock(seconds) {
        const value = Math.max(0, Number(seconds) || 0)
        const ms = Math.round(value * 1000)
        return clock(Math.floor(ms / 1000)) + "." + (ms % 1000).toString().padStart(3, "0")
    }
    function origin(value) { return ({local: "Neste computador", vaio: "Worker remoto", proton: "Proton Drive", missing: "Mídia indisponível"})[value] || "" }
    function statusText(value) { return ({completed: "Processada", archived: "Backup concluído", failed: "Processamento falhou", queued: "Na fila", processing: "Processando", "archive-pending": "Backup pendente", unprocessed: "Sem processamento"})[value] || value }
    function speakerLabel(segment) { return segment.speaker || "Falante incerto" }
    function captionTextAt(seconds) {
        if (captionTrack.timing !== "segment") return ""
        return (captionTrack.segments || [])
            .filter(segment => segment.start <= seconds && seconds < segment.end)
            .map(segment => (segment.speaker ? segment.speaker + ": " : "") + segment.text)
            .join("\n")
    }
    function captionHasFocus() {
        if (!captionOverlay.visible) return false
        for (let item = activeFocusItem; item; item = item.parent) {
            if (item === captionViewport) return true
        }
        return false
    }
    function audioSummary() {
        const configured = captureStatus.audio && captureStatus.audio.configured
        if (!configured) return "Áudio ainda não validado"
        if (configured.audioSource === "none") return "Áudio desativado na configuração"
        const selected = captureStatus.audio.selected || {}
        const mic = selected.microphone || configured.microphone || "Padrão do sistema"
        const desktop = selected.desktop || configured.desktop || "Padrão do sistema"
        return "Mic: " + mic + " · Desktop: " + desktop
    }
    function diarizationKey() { return detail.diarizationId || detail.jobId || "" }
    function hasPending(op) { return Object.keys(pending).some(id => pending[id].op === op) }
    function revisionPending() { return hasPending("revision-save") || hasPending("revision-undo") }
    function clearDerivedView() { contextLoading=false; contextText=""; contextCopyText=""; contextPath=""; contextCitations=[]; showVisualSummary=false; exportResult=({}); exportGeneration+=1 }
    function openReview(kind, target) {
        if (!backend.available || !detail.review || revisionPending()) return
        reviewTarget=Object.assign({kind:kind},target||({})); reviewError=""; reviewNeedsReload=false; revisionSpeakerExplicit=false
        revisionText.text=kind==="speaker-label" ? target.label || "" : kind==="segment-text" ? target.text || "" : ""
        const speaker=target&&target.speakerId || target&&target.speaker || ""
        revisionSpeaker.currentIndex=Math.max(0,revisionSpeaker.model.findIndex(function(row){return row.speakerId===speaker}))
        reviewDialog.open()
    }
    function submitRevision() {
        if (!detail.review || revisionPending() || reviewNeedsReload || !backend.available) return
        const target=reviewTarget, operation={kind:target.kind}
        if (target.kind==="segment-text") { operation.segmentId=target.id; operation.text=revisionText.text }
        else if(target.kind==="speaker-label") { operation.speakerId=target.speakerId; operation.label=revisionText.text.trim() }
        else if(target.kind==="turn-speaker") { operation.turnId=target.id; operation.speakerId=revisionSpeaker.model[revisionSpeaker.currentIndex].speakerId || null }
        else { operation.text=revisionText.text }
        reviewGeneration+=1; clearDerivedView(); reviewError=""
        const operations=[operation]
        if(target.kind==="segment-text"&&speakerRows.length){const speaker=revisionSpeaker.model[revisionSpeaker.currentIndex].speakerId||null;if(speaker!==(target.speakerId||null)||revisionSpeakerExplicit)operations.push({kind:"segment-speaker",segmentId:target.id,speakerId:speaker})}
        send("revision-save",diarizationKey(),{expectedRevision:detail.review.revision.revision,base:detail.review.revision.base,operations:operations})
    }
    function undoRevision() {
        if (!detail.review || !detail.review.canUndo || revisionPending() || !backend.available) return
        reviewGeneration+=1; clearDerivedView()
        send("revision-undo",diarizationKey(),{expectedRevision:detail.review.revision.revision,base:detail.review.revision.base})
    }
    function revisionConnectionLost() {
        if(reviewDialog.visible || revisionPending()) { reviewNeedsReload=true; reviewError="Conexão perdida; o salvamento pode ter ocorrido. Releia antes de tentar novamente." }
        if(exportDialog.visible) { exportError="Conexão perdida; confira a exportação após reconectar antes de salvar novamente."; exportResult=({}) }
        reviewGeneration+=1; exportGeneration+=1; clearDerivedView()
    }
    function previewExport() {
        exportGeneration+=1; exportResult=({}); exportError=""
        if(backend.available && detail.review)send("export-preview",diarizationKey(),{format:exportFormat.currentValue,track:exportTrack.currentValue})
    }
    function activeSpeakerLabels(seconds) {
        const turns = (detail.diarization && detail.diarization.turns) || []
        const labels = turns.filter(turn => Number(turn.start) <= seconds && seconds < Number(turn.end)).map(turn => turn.label || turn.speaker || "Falante incerto")
        return labels.filter((label, index) => labels.indexOf(label) === index).join(" + ")
    }
    function send(op, key, payload) {
        if (["agent-authorize","provider-authorize","agent-frames","provider-analyze"].includes(op)) agentError=""
        const id = backend.request(op, key || "", payload || ({}))
        if (id < 0) { if(op.startsWith("summary-"))summaryConnectionLost();if(op.startsWith("revision-")){reviewNeedsReload=true;reviewError="Pedido sem confirmação; reconecte e releia antes de tentar novamente."}if(op.startsWith("export-")){exportError="Pedido sem confirmação; atualize a prévia após reconectar.";exportResult=({})}if(op.startsWith("agent-")||op.startsWith("provider-"))agentError="Serviço indisponível; dados preservados. Feche e reconecte para continuar."; if(op.startsWith("frames-"))uxError="Serviço indisponível; dados preservados. Reabra após reconectar.";if(op.startsWith("onboarding-"))invalidateOnboarding("O serviço não recebeu este pedido. Reconecte e releia a configuração antes de salvar."); errorText = "O serviço da biblioteca está indisponível. Reabra esta janela."; return -1 }
        const next = Object.assign({}, pending)
        next[id] = {op: op, key: key, generation: generation, frameGeneration: frameGeneration, onboardingGeneration: onboardingGeneration, agentGeneration:agentGeneration, reviewGeneration:reviewGeneration,exportGeneration:exportGeneration,summaryGeneration:summaryGeneration}
        pending = next
        return id
    }
    function backToLibrary() {
        if(revisionPending() || hasPending("export-save"))return
        summaryDialog.close(); reviewDialog.close(); exportDialog.close(); reviewGeneration+=1; exportGeneration+=1
        closeAgentAccess(); framesDialog.close(); cancelFramePreview()
        generation += 1; sourceReferenceSeconds = -1; selected = ({}); detail = {transcript: {segments: [], text: "", timing: "none"}, diarization: {state: "idle"}}
        detailLoading = false; resolving = false; contextLoading = false; contextText = ""; contextCopyText = ""; contextPath = ""; contextCitations = []
        mediaReady = false; pendingPath = ""; position = 0; duration = 0; location = ""; playbackOperation = ""; operationPolling = false; errorText = ""; notice = ""
        if (playerInitialized) video.commandAsync(["stop"])
        search.forceActiveFocus(Qt.TabFocusReason)
    }
    function selectRecording(item) { showVisualSummary=false;
        if(revisionPending() || hasPending("export-save"))return
        summaryDialog.close(); reviewDialog.close(); exportDialog.close(); reviewGeneration+=1; exportGeneration+=1
        closeAgentAccess(); framesDialog.close(); cancelFramePreview()
        generation += 1; sourceReferenceSeconds = -1
        selected = item
        detail = {transcript: {segments: [], text: "", timing: "none"}, diarization: {state: "idle"}}
        detailLoading = true; errorText = ""; notice = ""; subtitleQueued = false
        mediaReady = false; pendingPath = ""; position = 0; duration = 0; location = ""
        resolving = false; playbackOperation = ""; operationPolling = false; initialTranscriptTiming = ""; diarizationQueued = false
        contextText = ""; contextCopyText = ""; contextPath = ""; contextCitations = []; contextLoading = false
        if (playerInitialized) video.commandAsync(["stop"])
        send("detail", item.key)
        // Explicit open keeps remote retrieval under the user's control.
        if (item.location === "local" || smokeKey) openRecording()
    }
    function openRecording() {
        if (!backend.available || !selected.key || resolving) return
        resolving = true; errorText = ""; notice = "Verificando e recuperando a mídia…"
        if (send("resolve", selected.key) < 0) { resolving = false; notice = "" }
    }
    function loadMedia() {
        if (!playerInitialized || !pendingPath) return
        video.setPropertyAsync("pause", true)
        video.commandAsync(["loadfile", pendingPath, "replace"])
        pendingPath = ""
    }
    function seek(seconds) {
        if (mediaReady) video.commandAsync(["seek", String(Math.max(0, Math.min(duration, seconds))), "absolute+exact"])
    }
    function togglePlay() { if (mediaReady) video.setPropertyAsync("pause", !paused) }
    function requestMeetingContext() {
        const id = diarizationKey()
        if (!backend.available || !id || contextLoading || revisionPending()) return
        contextLoading = true; contextText = ""; contextCopyText = ""; tabs.currentIndex = 3
        if (send("context-meeting", id, {maxCharacters: 10000}) < 0) contextLoading = false
    }
    Shortcut { sequence: "Space"; enabled: mediaReady && !textHasFocus && !uxModal && !captionToggle.activeFocus && !captionHasFocus(); onActivated: togglePlay() }
    Shortcut { sequence: "Right"; enabled: mediaReady && !textHasFocus && !uxModal && !captionHasFocus(); onActivated: seek(position + 5) }
    Shortcut { sequence: "Left"; enabled: mediaReady && !textHasFocus && !uxModal && !captionHasFocus(); onActivated: seek(position - 5) }
    FtDialog {
        id:summaryDialog; objectName:"summaryDialog"; title:"Regenerar resumo da transcrição atual"
        anchors.centerIn:parent; width:Math.min(680,window.width-48); height:Math.min(540,window.height-48); modal:true; closePolicy:Popup.CloseOnEscape
        onOpened:{summaryGeneration+=1;summaryPlan=({});summaryError="";summaryNeedsReload=false;summaryCompleted=false;summaryRunning=false;summaryRequestId="";summaryJobId=detail.review.revision.base.jobId;summaryConsent.checked=false;summaryBudget.value=1;summaryCancelButton.forceActiveFocus(Qt.TabFocusReason)}
        onClosed:{abandonSummary();summaryRegenerateButton.forceActiveFocus(Qt.TabFocusReason)}
        contentItem:ColumnLayout {
            spacing:10
            RowLayout {
                Layout.fillWidth:true
                Label { text:"Máximo de chamadas ao modelo"; color:ink; Layout.fillWidth:true }
                SpinBox { id:summaryBudget; objectName:"summaryBudget";Keys.priority:Keys.BeforeItem
                    Keys.onTabPressed:function(event){event.accepted=true;(event.modifiers&Qt.ShiftModifier?summaryCancelButton:summaryPlanButton).forceActiveFocus(event.modifiers&Qt.ShiftModifier?Qt.BacktabFocusReason:Qt.TabFocusReason)}
                    Keys.onBacktabPressed:function(event){summaryCancelButton.forceActiveFocus(Qt.BacktabFocusReason);event.accepted=true} from:1;to:8;value:1;editable:false;enabled:!summaryBusy()&&!summaryPlan.requestId&&!summaryNeedsReload;Accessible.name:"Limite explícito de chamadas para este resumo"
                    contentItem:TextInput { objectName:"summaryBudgetValue";text:String(summaryBudget.value);font:summaryBudget.font;color:ink;readOnly:true;horizontalAlignment:Text.AlignHCenter;verticalAlignment:Text.AlignVCenter;Keys.priority:Keys.BeforeItem
                        Keys.onTabPressed:function(event){event.accepted=true;(event.modifiers&Qt.ShiftModifier?summaryCancelButton:summaryPlanButton).forceActiveFocus(event.modifiers&Qt.ShiftModifier?Qt.BacktabFocusReason:Qt.TabFocusReason)}
                        Keys.onBacktabPressed:function(event){summaryCancelButton.forceActiveFocus(Qt.BacktabFocusReason);event.accepted=true}
                    }
                }
                FtButton { id:summaryPlanButton;objectName:"summaryPlanButton";Keys.priority:Keys.BeforeItem
                    Keys.onTabPressed:function(event){event.accepted=true;if(event.modifiers&Qt.ShiftModifier)summaryBudget.forceActiveFocus(Qt.BacktabFocusReason);else (summaryConsent.enabled?summaryConsent:summaryCancelButton).forceActiveFocus(Qt.TabFocusReason)}
                    Keys.onBacktabPressed:function(event){summaryBudget.forceActiveFocus(Qt.BacktabFocusReason);event.accepted=true} text:hasPending("summary-plan")?"Preparando…":"Preparar plano";enabled:backend.available&&!summaryBusy()&&!summaryPlan.requestId&&!summaryNeedsReload;onClicked:prepareSummary() }
            }
            ScrollView { id:summaryScroll;Layout.fillWidth:true;Layout.fillHeight:true;clip:true
                ColumnLayout { width:summaryScroll.availableWidth; spacing:10
                    Label { objectName:"summaryPlanInfo"; text:summaryPlanText();textFormat:Text.PlainText;wrapMode:Text.WrapAnywhere;color:ink;Layout.fillWidth:true;Accessible.name:"Modelo, destino, entrada e custo do plano de resumo" }
                    Label { text:"O resumo novo será ligado à revisão e preservará o original. Não grava mídia, não envia frames e não ativa automações ou configurações desligadas. Resultado de IA exige revisão da fonte.";textFormat:Text.PlainText;wrapMode:Text.WordWrap;color:muted;Layout.fillWidth:true }
                    Label { objectName:"summaryError";visible:!!summaryError;text:summaryError;textFormat:Text.PlainText;wrapMode:Text.WordWrap;color:errorColor;Layout.fillWidth:true }
                }
            }
            CheckBox { id:summaryConsent;objectName:"summaryConsent";KeyNavigation.priority:KeyNavigation.BeforeItem;KeyNavigation.backtab:summaryPlanButton.enabled?summaryPlanButton:summaryCancelButton;KeyNavigation.tab:summaryCancelButton;text:"Autorizo esta geração com o plano exibido";enabled:!!summaryPlan.requestId&&!summaryBusy()&&!summaryNeedsReload;Layout.fillWidth:true;Accessible.name:"Consentimento para gerar este resumo com o destino e limite exibidos"
                indicator:Rectangle { objectName:"summaryConsentIndicator";implicitWidth:24;implicitHeight:24;x:summaryConsent.leftPadding;y:(summaryConsent.height-height)/2;radius:3;color:summaryConsent.checked?accent:(lightTheme?"#FFFFFF":surface);border.width:summaryConsent.visualFocus?3:2;border.color:summaryConsent.visualFocus?accent:muted
                    Text { anchors.centerIn:parent;text:summaryConsent.checked?"✓":"";font.pixelSize:17;font.bold:true;color:lightTheme?"#FFFFFF":"#0B1716" }
                }
            }
            Label { visible:summaryRunning;text:processingWait||"Gerando… Cancelar bloqueia respostas pendentes; um resultado já concluído continua salvo. Uma chamada enviada pode continuar no modelo.";textFormat:Text.PlainText;wrapMode:Text.WordWrap;color:warningColor;Layout.fillWidth:true }
        }
        footer:Item { implicitHeight:summaryFooter.implicitHeight+28
          RowLayout { id:summaryFooter; anchors.fill:parent; anchors.leftMargin:20; anchors.rightMargin:20
            spacing:8
            FtButton { id:summaryCancelButton;objectName:"summaryCancelButton";KeyNavigation.priority:KeyNavigation.BeforeItem;KeyNavigation.backtab:summaryConsent.enabled?summaryConsent:(summaryPlanButton.enabled?summaryPlanButton:summaryBudget);KeyNavigation.tab:summaryReloadButton.visible&&summaryReloadButton.enabled?summaryReloadButton:(summaryRunButton.enabled?summaryRunButton:(summaryBudget.enabled?summaryBudget:summaryConsent));text:summaryBusy()?"Cancelar pedido e fechar":"Cancelar";onClicked:summaryDialog.close() }
            Item { Layout.fillWidth:true }
            FtButton { id:summaryReloadButton;objectName:"summaryReloadButton";KeyNavigation.priority:KeyNavigation.BeforeItem;KeyNavigation.backtab:summaryCancelButton;KeyNavigation.tab:summaryRunButton.enabled?summaryRunButton:summaryCancelButton;visible:summaryNeedsReload;text:"Reler resumo";enabled:backend.available&&!hasPending("detail");onClicked:{summaryDialog.close();detailLoading=true;send("detail",selected.key)} }
            FtButton { id:summaryRunButton;objectName:"summaryRunButton";variant:"primary";KeyNavigation.priority:KeyNavigation.BeforeItem;KeyNavigation.backtab:summaryReloadButton.visible&&summaryReloadButton.enabled?summaryReloadButton:summaryCancelButton;KeyNavigation.tab:summaryBudget.enabled?summaryBudget:summaryConsent;text:summaryRunning?"Gerando…":"Gerar resumo";enabled:backend.available&&!!summaryPlan.requestId&&summaryConsent.checked&&!summaryBusy()&&!summaryNeedsReload;onClicked:generateSummary() }
          }
        }
    }
    FtDialog {
        id:reviewDialog; objectName:"reviewDialog"; title:reviewTarget.kind==="turn-speaker" ? "Revisar atribuição da fala" : reviewTarget.kind==="speaker-label" ? "Revisar nome do falante" : reviewTarget.kind==="note" ? "Adicionar nota sem tempo" : "Revisar trecho"
        anchors.centerIn:parent; width:Math.min(620,window.width-48); height:Math.min(570,window.height-48); modal:true
        closePolicy:revisionPending()?Popup.NoAutoClose:Popup.CloseOnEscape
        onOpened:revisionCancel.forceActiveFocus(Qt.TabFocusReason)
        onClosed:{reviewTarget=({});reviewError="";reviewNeedsReload=false;revisionSpeakerExplicit=false;reviewNoteButton.forceActiveFocus(Qt.TabFocusReason)}
        contentItem:ColumnLayout { spacing:10
            Label { text:"Revisão humana local. O artefato original e seus horários são preservados. Nomes e atribuições não confirmam a identidade de uma pessoa."; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
            Label { objectName:"revisionOrigin"; text:reviewTarget.id ? "Origem: "+reviewTarget.id+" · "+preciseClock(reviewTarget.start)+"–"+preciseClock(reviewTarget.end)+" · intervalo herdado, sem novo alinhamento" : "Sem timestamp atribuído"; color:accent; wrapMode:Text.WordWrap; Layout.fillWidth:true }
            Label { visible:reviewTarget.kind==="segment-text"; text:"Original: "+(reviewTarget.originalText||reviewTarget.text||""); textFormat:Text.PlainText; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true; maximumLineCount:5; elide:Text.ElideRight }
            Label { objectName:"revisionError"; visible:!!reviewError; text:reviewError; textFormat:Text.PlainText; color:errorColor; wrapMode:Text.WordWrap; Layout.fillWidth:true }
            ScrollView { Layout.fillWidth:true; Layout.fillHeight:true; visible:reviewTarget.kind!=="turn-speaker"; clip:true
                TextArea { id:revisionText; objectName:"revisionText"; padding:10; background:Rectangle { radius:8; color:fieldSurface; border.width:revisionText.activeFocus?2:1; border.color:revisionText.activeFocus?accent:divider } readOnly:revisionPending()||reviewNeedsReload; textFormat:TextEdit.PlainText; wrapMode:TextEdit.Wrap; selectByMouse:true; color:ink; Accessible.name:reviewTarget.kind==="speaker-label"?"Nome informado pelo revisor":"Texto da revisão humana"
                    Keys.priority:Keys.BeforeItem
                    Keys.onPressed:event=>{if(event.key===Qt.Key_Tab||event.key===Qt.Key_Backtab){const backwards=event.key===Qt.Key_Backtab||!!(event.modifiers&Qt.ShiftModifier);(backwards?revisionCancel:revisionSpeaker.visible?revisionSpeaker:revisionCancel).forceActiveFocus(backwards?Qt.BacktabFocusReason:Qt.TabFocusReason);event.accepted=true}}
                }
            }
            FtComboBox { id:revisionSpeaker; objectName:"revisionSpeaker"; visible:reviewTarget.kind==="turn-speaker"||(reviewTarget.kind==="segment-text"&&speakerRows.length>0); Layout.fillWidth:true; textRole:"label"; enabled:!revisionPending()&&!reviewNeedsReload; model:[{speakerId:"",label:"Atribuição incerta"}].concat(speakerRows); Accessible.name:"Selecione para atribuir um falante da fonte acústica"; onActivated:revisionSpeakerExplicit=true }
            Label { visible:reviewTarget.kind==="segment-text"&&revisionSpeaker.visible; text:revisionSpeakerExplicit?"Atribuição selecionada por você; será registrada ao salvar.":"Selecione um falante para vincular as fontes. Códigos iguais não comprovam a mesma voz."; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
            Label { text:revisionPending()?"Salvando revisão; aguarde a confirmação…":"Salvar invalida os derivados antigos. Não chama um modelo nem regenera o resumo."; color:warningColor; wrapMode:Text.WordWrap; Layout.fillWidth:true }
        }
        footer:DialogButtonBox { alignment:Qt.AlignRight; spacing:8; padding:16
            FtButton { id:revisionCancel; objectName:"revisionCancel"; text:"Cancelar"; enabled:!revisionPending(); onClicked:reviewDialog.close() }
            FtButton { objectName:"revisionReload"; text:"Reler e descartar rascunho"; visible:reviewNeedsReload; enabled:backend.available&&!revisionPending()&&!hasPending("detail"); onClicked:{reviewDialog.close();detailLoading=true;send("detail",selected.key)} }
            FtButton { objectName:"revisionSave"; variant:"primary"; text:revisionPending()?"Salvando…":"Salvar revisão"; enabled:backend.available&&!!detail.review&&!revisionPending()&&!reviewNeedsReload&&(reviewTarget.kind==="turn-speaker"||!!revisionText.text.trim()); onClicked:submitRevision() }
        }
    }
    FtDialog {
        id:exportDialog; objectName:"exportDialog"; title:"Exportar resultado revisado"; anchors.centerIn:parent; width:Math.min(680,window.width-48); height:Math.min(610,window.height-48); modal:true
        closePolicy:hasPending("export-save")?Popup.NoAutoClose:Popup.CloseOnEscape
        onOpened:{exportClose.forceActiveFocus(Qt.TabFocusReason);previewExport()}
        onClosed:{exportGeneration+=1;exportResult=({});exportError="";exportButton.forceActiveFocus(Qt.TabFocusReason)}
        contentItem:ColumnLayout { spacing:10
            Label { text:"Arquivo privado neste computador; não há envio. O conteúdo pode ser sensível. JSON/Markdown incluem origem e revisão; legendas usam somente intervalos disponíveis, com manifesto de proveniência."; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
            RowLayout { Layout.fillWidth:true
                FtComboBox { id:exportFormat; objectName:"exportFormat"; textRole:"label"; valueRole:"value"; model:[{label:"JSON",value:"json"},{label:"Markdown",value:"markdown"},{label:"SRT",value:"srt"},{label:"WebVTT",value:"vtt"}]; enabled:!hasPending("export-save"); onActivated:previewExport(); Accessible.name:"Formato da exportação" }
                FtComboBox { id:exportTrack; objectName:"exportTrack"; textRole:"label"; valueRole:"value"; Layout.fillWidth:true; model:[{label:"Transcrição canônica revisada",value:"transcript"},{label:"Falas do diarizador revisadas",value:"diarization"}]; enabled:!hasPending("export-save"); onActivated:previewExport(); Accessible.name:"Fonte da exportação" }
            }
            Label { objectName:"exportError"; visible:!!exportError||!!exportResult.error; text:exportError||exportResult.error||""; color:errorColor; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true }
            Label { objectName:"exportWarnings"; text:(exportResult.warnings||[]).join("\n")+(exportResult.displayTruncated?"\nPrévia parcial; o arquivo local preserva o resultado completo.":""); visible:!!text; textFormat:Text.PlainText; color:warningColor; wrapMode:Text.WordWrap; Layout.fillWidth:true }
            ScrollView { Layout.fillWidth:true; Layout.fillHeight:true; clip:true
                TextArea { id:exportPreviewText; objectName:"exportPreviewText"; padding:10; background:Rectangle { radius:8; color:surfaceAlt; border.width:1; border.color:divider } readOnly:true; selectByMouse:true; textFormat:TextEdit.PlainText; wrapMode:TextEdit.Wrap; color:ink; text:exportResult.display|| (hasPending("export-preview")?"Preparando prévia local…":"Prévia indisponível."); Accessible.name:"Prévia do arquivo exportado"
                    Keys.priority:Keys.BeforeItem
                    Keys.onPressed:event=>{if(event.key===Qt.Key_Tab||event.key===Qt.Key_Backtab){exportClose.forceActiveFocus(event.key===Qt.Key_Backtab||!!(event.modifiers&Qt.ShiftModifier)?Qt.BacktabFocusReason:Qt.TabFocusReason);event.accepted=true}}
                }
            }
            Label { objectName:"exportSavedPath"; visible:!!exportResult.path; text:"Salvo localmente: "+(exportResult.path||"")+"\nManifesto: "+(exportResult.manifestPath||""); color:accent; textFormat:Text.PlainText; wrapMode:Text.WrapAnywhere; Layout.fillWidth:true }
        }
        footer:DialogButtonBox { alignment:Qt.AlignRight; spacing:8; padding:16
            FtButton { id:exportClose; objectName:"exportClose"; text:"Fechar"; enabled:!hasPending("export-save"); onClicked:exportDialog.close() }
            FtButton { objectName:"exportReload"; text:"Atualizar prévia"; enabled:backend.available&&!hasPending("export-save")&&!hasPending("export-preview"); onClicked:previewExport() }
            FtButton { objectName:"exportSave"; variant:"primary"; text:hasPending("export-save")?"Salvando…":"Salvar arquivo local"; enabled:backend.available&&exportResult.available===true&&exportResult.revision!==undefined&&!!exportResult.snapshotSha256&&!hasPending("export-preview")&&!hasPending("export-save"); onClicked:send("export-save",diarizationKey(),{format:exportResult.format,track:exportResult.track,expectedRevision:exportResult.revision,expectedBase:exportResult.base,expectedSnapshotSha256:exportResult.snapshotSha256}) }
        }
    }
    FtDialog {
        id: aboutDialog; objectName: "aboutDialog"; title: "Sobre o FalaTrace"
        anchors.centerIn: parent; width: Math.min(520, window.width - 32); modal: true
        closePolicy: Popup.CloseOnEscape
        onOpened: aboutClose.forceActiveFocus(Qt.TabFocusReason)
        onClosed: aboutButton.forceActiveFocus(Qt.TabFocusReason)
        contentItem: ColumnLayout { spacing: 12
            RowLayout {
                Layout.fillWidth: true; spacing: 14
                BrandMark { size: 44 }
                ColumnLayout {
                    Layout.fillWidth: true; spacing: 2
                    Label { text: "FalaTrace Studio"; color: ink; font.pixelSize: 17; font.weight: Font.DemiBold }
                    Label { text: "Gravações e contexto com origem para Linux · experimental"; color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                }
            }
            Rectangle { Layout.fillWidth: true; Layout.preferredHeight: 1; color: divider }
            Label { objectName:"aboutVersion"; text: "Studio em execução: " + Qt.application.version; color: ink; Layout.fillWidth:true; wrapMode:Text.WordWrap }
            Label { text: "Build local: " + studioBuildId; color: muted; Layout.fillWidth:true; wrapMode:Text.WordWrap }
            Label { objectName:"aboutRelease"; text: "Release instalada: " + (releaseInfo.name ? releaseInfo.name + " · commit " + releaseInfo.commit : backend.available && cliVersion ? "não identificada (execução pelo código-fonte)" : "indisponível"); color: muted; Layout.fillWidth:true; wrapMode:Text.WordWrap }
            Label { text: "CLI conectado: " + (backend.available && cliVersion ? cliVersion : "indisponível"); color: muted; Layout.fillWidth:true; wrapMode:Text.WordWrap }
            Label { text: cliVersion && cliVersion !== Qt.application.version ? "Studio e CLI têm versões diferentes. Feche e reabra o Studio após atualizar." : "Versão publicada: não consultada. Esta tela não verifica atualizações pela rede."; color: cliVersion && cliVersion !== Qt.application.version ? warningColor : muted; Layout.fillWidth:true; wrapMode:Text.WordWrap }
            Label { text: "No terminal: falatrace --version"; color: ink; Layout.fillWidth:true; wrapMode:Text.WordWrap }
        }
        footer: Item { implicitHeight: 64; FtButton { id:aboutClose; text:"Fechar"; anchors.right: parent.right; anchors.rightMargin: 20; anchors.verticalCenter: parent.verticalCenter; onClicked:aboutDialog.close() } }
    }
    FtDialog {
        id: captureConsent
        property string intent: "capture"
        objectName: "captureConsent"
        title: intent === "resume" ? "Retomar gravações automáticas" : "Antes de iniciar a gravação"
        anchors.centerIn: parent
        width: Math.min(window.width - 64, 540)
        modal: true
        closePolicy: Popup.CloseOnEscape
        contentItem: RowLayout {
            spacing: 14
            Rectangle {
                Layout.alignment: Qt.AlignTop
                implicitWidth: 40; implicitHeight: 40; radius: 10
                color: captureConsent.intent === "resume" ? accentSoft : recordingSoft
                FtIcon { anchors.centerIn: parent; size: 20; name: captureConsent.intent === "resume" ? "automation-play" : "record"; tint: captureConsent.intent === "resume" ? accent : recordingColor }
            }
            Label {
                Layout.fillWidth: true
                text: (captureConsent.intent === "resume" ? "As regras já configuradas poderão iniciar novas gravações. Esta ação não inicia uma captura manual. " : "") + "Confirme a permissão das pessoas envolvidas. A captura usa a tela e as fontes de áudio configuradas. Revise o áudio antes de continuar.\n\n" + audioSummary() + "\n\nFechar o Studio não encerra a captura. Use Parar para finalizá-la. O processamento usa os providers configurados; serviços externos podem receber conteúdo."
                textFormat: Text.PlainText
                wrapMode: Text.WordWrap
                color: ink
                Accessible.name: text
            }
        }
        footer: Item {
            implicitHeight: 64
            RowLayout {
                anchors.fill: parent; anchors.leftMargin: 20; anchors.rightMargin: 20
                spacing: 10
                Item { Layout.fillWidth: true }
                FtButton { id: captureConsentCancel; objectName: "captureConsentCancel"; text: "Cancelar"; variant: "outline"; onClicked: captureConsent.reject() }
                FtButton { id: captureConsentAccept; objectName: "captureConsentAccept"; text: captureConsent.intent === "resume" ? "Retomar automação" : "Iniciar gravação"; variant: "primary"; iconName: captureConsent.intent === "resume" ? "automation-play" : "record"; onClicked: captureConsent.accept() }
            }
        }
        // Cancel keeps the initial focus: an accidental Enter never starts a capture.
        onOpened: captureConsentCancel.forceActiveFocus(Qt.TabFocusReason)
        onAccepted: {
            if (backend.available && !captureBusy && (intent === "resume" || !captureStatus.active)) {
                captureBusy = true
                if (send(intent === "resume" ? "automation-resume" : "capture-start", "", intent === "resume" ? ({}) : {title: ""}) < 0) captureBusy = false
            }
        }
    }
    Shortcut { sequence: "Escape"; enabled: !!selected.key && !uxModal; onActivated: backToLibrary() }
    Timer { interval: processingWait || summaryRunning || hasPending("frames-preview") || hasPending("frames-confirm") ? 500 : 2000; running: backend.available; repeat: true; onTriggered: { if (!hasPending("processing-status")) send("processing-status", "") } }
    Label { z: 100; anchors.bottom: parent.bottom; anchors.bottomMargin: 48; anchors.horizontalCenter: parent.horizontalCenter; width: Math.min(parent.width - 32, implicitWidth); visible: !!processingWait; text: processingWait; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: warningColor; padding: 10; leftPadding: 14; rightPadding: 14; background: Rectangle { color: surface; radius: 10; border.width: 1; border.color: warningColor } }
    Timer { interval: 1000; running: captureStatus.active; repeat: true; onTriggered: statusNow = Date.now() }
    Component.onCompleted: if (backend.available) { send("list-cached", ""); send("list", ""); send("capture-status", ""); send("jobs-list", ""); send("ux-capabilities", "") }
    Connections {
        target: backend
        function onFailed(message) { summaryConnectionLost();revisionConnectionLost();onboardingConnectionLost();if(agentDialog.visible)agentError=message; captureKnown = false; pending = {}; errorText = message; loading = false; resolving = false; detailLoading = false; operationPolling = false; captureBusy = false; contextLoading = false }
        function onAvailabilityChanged() {
            if (!backend.available) { summaryConnectionLost();revisionConnectionLost();onboardingConnectionLost();if(agentDialog.visible)agentError="Serviço desconectado; dados preservados. Feche e reconecte para continuar."; captureKnown = false; pending = {}; loading = false; resolving = false; detailLoading = false; operationPolling = false; captureBusy = false; contextLoading = false; notice = "Serviço desconectado. Use Reconectar para continuar." }
            else { errorText = ""; notice = "Serviço conectado."; if (!libraryFresh) send("list-cached", ""); send("capture-status", ""); send("jobs-list", ""); send("list", ""); send("ux-capabilities", "") }
        }
        function onResponse(message) {
            const request = pending[message.id]
            if (!request) return
            const next = Object.assign({}, pending)
            delete next[message.id]
            pending = next
            if (["detail", "resolve", "playback-status", "context-meeting", "diarization-name", "subtitles", "diarization","revision-save","revision-undo","export-preview","export-save"].includes(request.op) && request.generation !== generation) return
            if (["detail","context-meeting","revision-save","revision-undo"].includes(request.op) && request.reviewGeneration !== reviewGeneration) return
            if(request.op.startsWith("export-") && request.exportGeneration!==exportGeneration)return
            if (request.op === "playback-status") operationPolling = false
            if (request.op === "list") { loading = false; libraryRefreshing = false }
            if (request.op === "detail") detailLoading = false
            if (request.op.startsWith("frames-") && request.op !== "frames-cancel" && (request.generation !== generation || request.frameGeneration !== frameGeneration)) return
            if((request.op.startsWith("agent-")||request.op.startsWith("provider-")) && (request.generation !== generation || request.agentGeneration !== agentGeneration)) return
            if (request.op.startsWith("summary-") && request.op!=="summary-cancel" && (request.generation!==generation || request.summaryGeneration!==summaryGeneration))return
            if (request.op.startsWith("onboarding-") && request.onboardingGeneration !== onboardingGeneration) return
            if (!message.ok && (request.op.startsWith("agent-")||request.op.startsWith("provider-"))) { agentError=message.error; return }
            if (!message.ok && request.op === "processing-status") { processingWait = "Estado do processamento indisponível; nenhuma alteração na captura."; return }
            if (!message.ok && request.op.startsWith("onboarding-")) { if(request.op==="onboarding-save-local")onboardingSaveUncertain=true;invalidateOnboarding(message.error+" Releia a configuração e confirme sua escolha antes de salvar novamente.");return }
            if (!message.ok && request.op.startsWith("summary-") && request.op!=="summary-cancel") {summaryRunning=false;summaryNeedsReload=true;summaryConsent.checked=false;summaryPlan=({});summaryError=message.error;return}
            if (request.op==="summary-cancel")return
            if (!message.ok && request.op.startsWith("frames-")) { uxError = message.error; return }
            if (!message.ok && request.op.startsWith("revision-")) { reviewNeedsReload=true;reviewError=message.error+" Releia os dados antes de tentar novamente.";errorText=reviewError;detailLoading=true;send("detail",selected.key);return }
            if (!message.ok && request.op.startsWith("export-")) { exportError=message.error;exportResult=({});return }
            if (!message.ok) { errorText = message.error; notice = ""; captureBusy = false; contextLoading = false; if (request.op === "subtitles") subtitleQueued = false; if (request.op === "diarization") diarizationQueued = false; if (request.op === "resolve" || request.op === "playback-status") { resolving = false; playbackOperation = "" } return }
            const result = message.result
            if(request.op === "summary-plan") {summaryPlan=result;summaryConsent.checked=false;summaryError=""
            } else if(request.op === "summary-run") {summaryRunning=false;summaryCompleted=true;notice="Resumo novo ligado à revisão; confira a fonte. Original preservado.";summaryDialog.close();clearDerivedView();detailLoading=true;send("detail",selected.key)
            } else if(request.op === "provider-authorize") {providerConsent.checked=false;showAgentSetup=false;preferredGrantId=result.id;changeAgentGrant()
            } else if(request.op === "provider-analyze") {providerPendingGrant="";providerResult=result;send("agent-status",selected.key)
            } else if(request.op === "provider-cancel") {agentError="Pedido de análise cancelado; resultado/custo podem ser incertos se já enviado."
            } else if(request.op === "agent-status") { const prior=preferredGrantId||activeGrant.id;preferredGrantId="";agentState=result;const index=visibleGrants.findIndex(function(g){return g.id===prior});grantPicker.currentIndex=index>=0?index:0;if(!agentLoaded){showAgentSetup=!visibleGrants.length;agentLoaded=true}
            } else if(request.op === "agent-frames") { frameGrantPending="";agentResult=result; send("agent-status",selected.key)
            } else if(["agent-authorize","agent-pause","agent-resume","agent-revoke"].includes(request.op)) { if(request.op==="agent-authorize"){showAgentSetup=false;preferredGrantId=result.id;changeAgentGrant()}else send("agent-status",selected.key);agentConsent.checked=false; agentResult=({});
            } else if(request.op === "agent-cancel") { agentError="Consulta cancelada; autorização preservada."
            } else if (request.op === "ux-capabilities") { cliVersion = result.productVersion || ""; releaseInfo = result.release || ({}); mockFramesEnabled = !!result.mockFrames; realFramesEnabled = !!result.realFrames
            } else if (request.op === "processing-status") { processingWait = result.waiting.length ? result.waiting[0].message : ""
            } else if (request.op === "frames-cancel") { send("processing-status", "")
            } else if (request.op === "frames-check-models") { frameCapability = result
            } else if (request.op === "frames-scope") { frameScope = result
            } else if (request.op === "frames-plan") { framePlan = result
            } else if (request.op === "frames-preview" || request.op === "frames-preview-plan") { framePreview = result
            } else if (request.op === "frames-confirm") { frameResult = result; showVisualSummary=false; if (!result.synthetic && result.summaryMarkdown) { const updated=Object.assign({},detail); updated.visualReview=result; detail=updated }
            } else if (request.op === "onboarding-read") { onboardingDraft = result;onboardingError="";onboardingNeedsReload=false;onboardingSaveUncertain=false
            } else if (request.op === "onboarding-save-local") { notice = result.cleanupPending?"Escolha local salva; uma cópia temporária privada pode permanecer na pasta da configuração. Nenhum serviço iniciado.":"Escolha local salva; nenhum serviço iniciado."; onboardingDialog.close()
            } else if (request.op === "list-cached") {
                if (!libraryFresh && Array.isArray(result.items)) { items = result.items; loading = false; libraryRefreshing = hasPending("list") }
            } else if (request.op === "list") {
                libraryFresh = true
                items = result.items
                if (selected.key) { const current = items.find(item => item.key === selected.key); if (current) { selected = current; detailLoading = true; send("detail", selected.key) } else backToLibrary() }
                if (!selected.key && smokeKey) {
                    const target = items.find(item => item.key === smokeKey)
                    if (target) selectRecording(target); else errorText = "Gravação de verificação ausente."
                }
            } else if (request.op === "automation-pause" || request.op === "automation-resume" || request.op === "capture-status" || request.op === "capture-start" || request.op === "capture-stop" || request.op === "capture-recover" || request.op === "audio-defaults") {
                captureStatus = result
                captureKnown = true
                if (request.op !== "capture-status" || !["capture-start", "capture-stop", "capture-recover", "audio-defaults", "automation-pause", "automation-resume"].some(op => hasPending(op))) captureBusy = false
                if (request.op !== "capture-status") notice = request.op === "automation-pause" ? "Novas gravações automáticas pausadas. A captura atual continua até Parar." : request.op === "automation-resume" ? "Automação retomada para futuras chamadas; confira suas regras." : request.op === "capture-start" ? "Captura iniciada." : request.op === "capture-stop" ? "Captura finalizada e enfileirada." : request.op === "capture-recover" ? "Recuperação solicitada." : "Áudio padrão atualizado."
            } else if (request.op === "jobs-list") {
                jobs = result.items || []
                if (selectedJob.id) selectedJob = jobs.find(job => job.id === selectedJob.id) || ({})
            } else if (request.op === "job-process" || request.op === "job-retry") {
                notice = result.warning || (result.status === "completed" ? "Este job já está concluído." : result.status === "active" ? "Este job já está em processamento." : "Job enviado para processamento.")
                send("jobs-list", "")
            } else if(request.op === "revision-save" || request.op === "revision-undo") {
                notice=request.op==="revision-undo"?"Revisão anterior restaurada por uma nova revisão; original preservado.":"Revisão humana salva; derivados antigos precisam de revisão."
                reviewDialog.close();clearDerivedView();detailLoading=true;send("detail",selected.key)
            } else if(request.op === "export-preview") {
                exportResult=result;exportError=""
            } else if(request.op === "export-save") {
                exportResult=Object.assign({},exportResult,result);exportError="";notice="Exportação privada salva neste computador."
            } else if (request.op === "diarization-name") {
                notice = "Nome do falante salvo nesta gravação."
                detailLoading = true; send("detail", selected.key)
            } else if (request.op === "context-meeting") {
                contextLoading = false
                contextCopyText = JSON.stringify(result)
                contextText = result.context || result.text || JSON.stringify(result, null, 2)
                contextPath = result.path || result.sourcePath || ""
                contextCitations = result.citations || []
            } else if (request.op === "detail") {
                if(summaryDialog.visible && summaryPlan.requestId && (!result.review || summaryPlan.revision!==result.review.revision.revision)) {abandonSummary();summaryNeedsReload=true;summaryError="A revisão mudou. Releia e prepare um novo plano; o original foi preservado."}
                if (!initialTranscriptTiming) initialTranscriptTiming = result.transcript.timing
                selected = Object.assign({}, selected, {
                    status: result.status, backup: result.backup,
                    title: typeof result.title === "string" ? result.title : selected.title,
                    hasMeetingTitle: typeof result.hasMeetingTitle === "boolean" ? result.hasMeetingTitle : selected.hasMeetingTitle,
                    artifactStatus: typeof result.artifactStatus === "string" ? result.artifactStatus : selected.artifactStatus
                })
                if (JSON.stringify(detail) !== JSON.stringify(result)) detail = result
                if (diarizationQueued && result.diarization.state === "review") notice = "Falantes identificados. Abra a aba Falantes para revisar."
                else if (diarizationQueued && result.diarization.state === "failed") { notice = ""; errorText = result.diarization.message || "A identificação não foi concluída." }
                diarizationQueued = result.diarization.state === "running"
                if (smokeDiarization && (result.diarization.turns || []).length > 0) tabs.currentIndex = 2
                if (subtitleQueued && result.subtitleState === "ready") { subtitleQueued = false; notice = "Legendas prontas." }
                else if (result.subtitleState === "running") subtitleQueued = true
                else if (subtitleQueued && ["idle", "failed", "unknown"].includes(result.subtitleState)) { subtitleQueued = false; notice = ""; errorText = result.subtitleMessage || "Não há legendas alinhadas verificadas. O estado da solicitação está indisponível; a transcrição original foi preservada." }
            } else if (request.op === "resolve" || request.op === "playback-status") {
                if (result.state === "running") { playbackOperation = result.operationId; return }
                resolving = false; playbackOperation = ""
                if (result.state === "failed") { errorText = result.message; notice = ""; return }
                location = result.location; pendingPath = result.path; notice = ""; loadMedia()
            } else if (request.op === "subtitles") {
                subtitleQueued = true; notice = "Legendas solicitadas ao worker configurado. Esta janela atualizará quando estiverem prontas."
            } else if (request.op === "diarization") {
                diarizationQueued = true
                detail = Object.assign({}, detail, {diarization: {state: "running", message: "Identificação automática em preparação…"}, diarizationId: result.id})
                notice = "Identificação de falantes em preparação."
            }
        }
    }
    Timer {
        interval: 5000; repeat: true; running: backend.available && !!selected.key && (subtitleQueued || diarizationQueued || ["pending", "transferring", "queued", "processing"].includes(selected.status) || !!smokeKey)
        onTriggered: { if (!detailLoading) { detailLoading = true; send("detail", selected.key) } }
    }
    Timer {
        interval: 5000; repeat: true; running: backend.available
        onTriggered: {
            if (!hasPending("capture-status")) send("capture-status", "")
            if (!hasPending("jobs-list")) send("jobs-list", "")
        }
    }
    Timer {
        interval: 1000; repeat: true; running: backend.available && !!playbackOperation
        onTriggered: { if (!operationPolling) { operationPolling = true; send("playback-status", playbackOperation) } }
    }
    Timer {
        interval: 200; repeat: true; running: playerInitialized
        onTriggered: {
            const length = Number(video.getProperty("duration")) || 0
            duration = length
            mediaReady = length > 0
            position = Number(video.getProperty("time-pos")) || 0
            paused = video.getProperty("pause") !== false
            const segments = detail.transcript.segments || []
            activeSegment = segments.findIndex(segment => segment.start <= position && position < segment.end)
        }
    }

    // ── Window layout: top bar · library sidebar · home or recording · status bar ──
    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        Rectangle {
            id: topBar
            Layout.fillWidth: true
            Layout.preferredHeight: 60
            color: chrome
            Rectangle { anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom; height: 1; color: divider }
            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 18
                anchors.rightMargin: 14
                spacing: 10
                BrandMark { size: 26 }
                ColumnLayout {
                    spacing: 0
                    Label { text: "FalaTrace Studio"; color: ink; font.pixelSize: 16; font.weight: Font.DemiBold }
                    Label { visible: !compactLayout; text: Qt.application.version + " · experimental"; color: muted; font.pixelSize: 11 }
                }
                Item { Layout.fillWidth: true }
                FtChip { visible: !backend.available; kind: "danger"; iconName: "plug"; text: "Serviço desconectado" }
                FtButton { text: "Reconectar"; visible: !backend.available; enabled: !backend.available; compact: true; onClicked: backend.reconnect() }
                Rectangle {
                    id: capturePill
                    objectName: "capturePill"
                    Layout.preferredHeight: 42
                    implicitWidth: captureRow.implicitWidth + 18
                    radius: 10
                    color: captureStatus.active ? recordingSoft : surface
                    border.width: 1
                    border.color: captureStatus.active ? recordingColor : divider
                    RowLayout {
                        id: captureRow
                        anchors.left: parent.left
                        anchors.leftMargin: 12
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 9
                        // Shape and text carry the state: square + REC while recording, ring otherwise.
                        Rectangle {
                            implicitWidth: 10; implicitHeight: 10
                            radius: captureStatus.active ? 2 : 5
                            color: captureStatus.active ? recordingColor : "transparent"
                            border.width: captureStatus.active ? 0 : 2
                            border.color: captureKnown ? muted : warningColor
                        }
                        ColumnLayout {
                            spacing: 0
                            Label {
                                objectName: "captureStateLabel"
                                text: !captureKnown ? "Captura: estado desconhecido" : captureStatus.active ? "REC " + clock(Math.max(0, (statusNow - Date.parse(captureStatus.session && captureStatus.session.startedAt || new Date(statusNow).toISOString())) / 1000)) : "Captura parada"
                                color: captureStatus.active ? recordingColor : ink
                                font.pixelSize: 13
                                font.weight: Font.DemiBold
                            }
                            Label {
                                visible: captureKnown && !compactLayout
                                text: captureNeedsAttention() ? "Verifique a captura" : captureStatus.paused ? "Automação pausada" : audioLabel()
                                color: captureNeedsAttention() || !(captureStatus.audio && captureStatus.audio.configured) ? warningColor : muted
                                font.pixelSize: 11
                                HoverHandler { id: captureHover }
                                ToolTip.visible: captureHover.hovered
                                ToolTip.text: captureStatus.warning || (captureStatus.audio && captureStatus.audio.error) || audioSummary()
                            }
                        }
                        FtButton { id:headerStop; objectName:"headerStop"; Keys.onReturnPressed:clicked(); Keys.onEnterPressed:clicked(); visible:captureStatus.active; variant:"danger"; compact:true; iconName:"stop"; text:"Parar captura"; enabled:backend.available&&captureKnown&&!captureBusy; onClicked:{captureBusy=true;if(send("capture-stop","")<0)captureBusy=false} }
                        FtButton { id:captureStartButton; objectName:"captureStartButton"; visible:!captureStatus.active; compact:true; iconName:"record"; iconTint:recordingColor; text:"Gravar…"; Accessible.name:"Iniciar uma gravação manual após confirmação"; enabled:backend.available&&captureKnown&&!captureBusy&&!captureStatus.active; onClicked:{captureConsent.intent="capture";captureConsent.open()} }
                    }
                }
                FtButton {
                    id: automationButton
                    objectName: "automationButton"
                    visible: backend.available
                    compact: true
                    variant: "ghost"
                    iconName: captureStatus.paused ? "automation-play" : "automation-pause"
                    text: captureStatus.paused ? "Retomar automação…" : "Pausar novas gravações"
                    Accessible.name: captureStatus.paused ? "Retomar gravações automáticas" : "Pausar novas gravações automáticas; a captura atual continua"
                    enabled: backend.available && !captureBusy
                    onClicked: { if (captureStatus.paused) { captureConsent.intent = "resume"; captureConsent.open() } else { captureBusy = true; if (send("automation-pause", "") < 0) captureBusy = false } }
                }
                FtButton { iconOnly: true; variant: "ghost"; iconName: "refresh"; text: "Atualizar biblioteca"; Accessible.name: "Atualizar biblioteca"; enabled: backend.available && !loading && !libraryRefreshing; onClicked: { loading = true; send("list", "") } }
                FtButton { iconOnly: true; variant: "ghost"; iconName: lightTheme ? "moon" : "sun"; text: lightTheme ? "Tema escuro" : "Tema claro"; Accessible.name: text; onClicked: lightTheme = !lightTheme }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 0

            Rectangle {
                id: sidebar
                Layout.preferredWidth: compactLayout ? 252 : 288
                Layout.fillHeight: true
                color: chrome
                Rectangle { anchors.top: parent.top; anchors.bottom: parent.bottom; anchors.right: parent.right; width: 1; color: divider }
                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: 14
                    anchors.rightMargin: 15
                    spacing: 10
                    RowLayout {
                        Layout.fillWidth: true
                        Label { text: "Biblioteca"; color: ink; font.pixelSize: 15; font.weight: Font.DemiBold; Layout.fillWidth: true }
                        FtChip { visible: !loading; text: (items.length === 1 ? "1 gravação" : items.length + " gravações") + (libraryRefreshing ? " · atualizando…" : "") }
                    }
                    FtTextField { id: search; Layout.fillWidth: true; leadingIcon: "search"; placeholderText: "Buscar gravação…"; Accessible.name: "Buscar gravação" }
                    BusyIndicator { Layout.alignment: Qt.AlignHCenter; running: loading && backend.available; visible: running }
                    Label { visible: !loading && !filtered.length; text: items.length ? "Nenhuma gravação corresponde à busca." : "Nenhuma gravação encontrada."; color: muted; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 13 }
                    ListView {
                        id: libraryView
                        function followSelection() { currentIndex = Qt.binding(() => filtered.findIndex(item => item.key === selected.key)) }
                        function openCurrent() { const item = filtered[currentIndex]; if (item && backend.available) selectRecording(item); followSelection() }
                        currentIndex: filtered.findIndex(item => item.key === selected.key)
                        Layout.fillWidth: true; Layout.fillHeight: true; clip: true; spacing: 4; model: filtered
                        // Keyboard: Tab enters the list, arrows move, Enter or Space opens the recording.
                        activeFocusOnTab: count > 0
                        keyNavigationEnabled: true
                        Accessible.role: Accessible.List
                        Accessible.name: "Gravações da biblioteca"
                        Keys.onReturnPressed: openCurrent()
                        Keys.onEnterPressed: openCurrent()
                        Keys.onSpacePressed: openCurrent()
                        onActiveFocusChanged: { if (activeFocus && currentIndex < 0 && count > 0) currentIndex = 0; else if (!activeFocus) followSelection() }
                        ScrollBar.vertical: ScrollBar {}
                        delegate: ItemDelegate {
                            id: libraryItem
                            required property var modelData
                            readonly property bool current: selected.key === modelData.key
                            width: ListView.view.width
                            enabled: backend.available
                            hoverEnabled: true
                            leftPadding: 14; rightPadding: 12; topPadding: 10; bottomPadding: 10
                            Accessible.name: modelData.title + ", " + origin(modelData.location) + ", " + statusText(modelData.status)
                            background: Rectangle {
                                radius: 10
                                color: libraryItem.current ? selectedSurface : libraryItem.hovered ? hoverSurface : "transparent"
                                border.width: libraryItem.visualFocus || (libraryItem.ListView.isCurrentItem && libraryView.activeFocus) ? 2 : 0
                                border.color: accent
                                Rectangle { visible: libraryItem.current; width: 3; radius: 1.5; color: accent; anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom; anchors.topMargin: 10; anchors.bottomMargin: 10 }
                            }
                            contentItem: ColumnLayout {
                                spacing: 4
                                Label { text: modelData.title; textFormat: Text.PlainText; color: ink; font.pixelSize: 14; font.weight: libraryItem.current ? Font.DemiBold : Font.Medium; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight; Layout.fillWidth: true }
                                Label { text: shortDate(modelData.modifiedAt) + " · " + origin(modelData.location); textFormat: Text.PlainText; color: modelData.location === "missing" ? warningColor : muted; font.pixelSize: 12; elide: Text.ElideRight; Layout.fillWidth: true }
                                RowLayout {
                                    spacing: 6
                                    Rectangle { implicitWidth: 7; implicitHeight: 7; radius: 3.5; color: kindColor(statusKind(modelData.status)) }
                                    Label { text: statusText(modelData.status); textFormat: Text.PlainText; color: muted; font.pixelSize: 12 }
                                }
                                Label { visible: modelData.hasMeetingTitle === false; text: modelData.artifactStatus || ""; textFormat: Text.PlainText; color: muted; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                            }
                            onClicked: selectRecording(modelData)
                        }
                    }
                    Rectangle { Layout.fillWidth: true; Layout.preferredHeight: 1; color: divider }
                    FtNavButton { objectName: "recordingControlsButton"; iconName: "tools"; text: "Gravação e tarefas…"; onClicked: recordingTools.open() }
                    FtNavButton { id: onboardingButton; objectName: "onboardingButton"; iconName: "shield"; text: "Configuração e privacidade…"; enabled: backend.available; onClicked: onboardingDialog.open() }
                    FtNavButton { id: aboutButton; objectName: "aboutButton"; iconName: "info"; text: "Sobre o FalaTrace"; onClicked: aboutDialog.open() }
                }
            }

            Rectangle {
                id: mainArea
                Layout.fillWidth: true
                Layout.fillHeight: true
                color: canvas

                Flickable {
                    id: homeView
                    objectName: "homeView"
                    anchors.fill: parent
                    visible: !selected.key
                    clip: true
                    contentWidth: width
                    contentHeight: homeColumn.implicitHeight + 2 * homeColumn.y
                    boundsBehavior: Flickable.StopAtBounds
                    ScrollBar.vertical: ScrollBar {}
                    ColumnLayout {
                        id: homeColumn
                        x: compactLayout ? 22 : 34
                        y: compactLayout ? 20 : 30
                        width: homeView.width - 2 * x
                        spacing: 18
                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 6
                            Label { text: "Sua biblioteca"; color: ink; font.pixelSize: compactLayout ? 22 : 26; font.weight: Font.DemiBold }
                            Label { text: "Escolha uma gravação para assistir, revisar a transcrição e consultar o contexto com a origem ao lado."; color: muted; font.pixelSize: 14; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                        }
                        Rectangle {
                            Layout.fillWidth: true
                            visible: !backend.available || (!loading && !!errorText && items.length === 0)
                            implicitHeight: homeAlertRow.implicitHeight + 28
                            radius: 12; color: errorSoft
                            RowLayout {
                                id: homeAlertRow
                                anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; anchors.margins: 14
                                spacing: 12
                                FtIcon { name: backend.available ? "alert" : "plug"; tint: errorColor; size: 20 }
                                Label { Layout.fillWidth: true; text: backend.available ? errorText : "O serviço da biblioteca está desconectado. Nada foi apagado; reconecte para continuar."; textFormat: Text.PlainText; color: ink; wrapMode: Text.WordWrap }
                                FtButton { text: backend.available ? "Tentar novamente" : "Reconectar"; compact: true; onClicked: { if (backend.available) { loading = true; send("list", "") } else backend.reconnect() } }
                            }
                        }
                        RowLayout {
                            visible: loading && backend.available
                            spacing: 10
                            BusyIndicator { running: parent.visible; implicitWidth: 28; implicitHeight: 28 }
                            Label { text: "Carregando a biblioteca…"; color: muted }
                        }
                        FtCard {
                            Layout.fillWidth: true
                            visible: !loading && backend.available && items.length === 0 && !errorText
                            implicitHeight: emptyColumn.implicitHeight + 56
                            ColumnLayout {
                                id: emptyColumn
                                anchors.centerIn: parent
                                width: Math.min(parent.width - 48, 520)
                                spacing: 12
                                BrandMark { size: 48; Layout.alignment: Qt.AlignHCenter }
                                Label { text: "Nenhuma gravação ainda"; color: ink; font.pixelSize: 18; font.weight: Font.DemiBold; Layout.alignment: Qt.AlignHCenter }
                                Label { text: "As gravações aparecem aqui depois de uma captura manual ou de uma regra de gravação automática que você ativar. Nada é gravado sem a sua configuração ou confirmação."; color: muted; wrapMode: Text.WordWrap; horizontalAlignment: Text.AlignHCenter; Layout.fillWidth: true }
                                RowLayout {
                                    Layout.alignment: Qt.AlignHCenter
                                    spacing: 10
                                    FtButton { text: "Gravação e tarefas…"; iconName: "tools"; onClicked: recordingTools.open() }
                                    FtButton { text: "Configuração e privacidade…"; iconName: "shield"; variant: "outline"; enabled: backend.available; onClicked: onboardingDialog.open() }
                                }
                            }
                        }
                        GridLayout {
                            Layout.fillWidth: true
                            visible: items.length > 0
                            columns: homeColumn.width < 620 ? 2 : 4
                            columnSpacing: 12
                            rowSpacing: 12
                            Repeater {
                                model: [
                                    {label: "Gravações", value: libraryStats.total, kind: "neutral"},
                                    {label: "Com transcrição", value: libraryStats.transcripts, kind: "accent"},
                                    {label: "Em processamento", value: libraryStats.active, kind: "warning"},
                                    {label: "Precisam de atenção", value: libraryStats.attention, kind: "danger"}
                                ]
                                FtCard {
                                    required property var modelData
                                    Layout.fillWidth: true
                                    implicitHeight: 82
                                    ColumnLayout {
                                        anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; anchors.margins: 16
                                        spacing: 2
                                        RowLayout {
                                            spacing: 8
                                            Label { text: String(modelData.value); color: ink; font.pixelSize: 26; font.weight: Font.DemiBold }
                                            Rectangle { visible: modelData.kind !== "neutral" && modelData.value > 0; implicitWidth: 8; implicitHeight: 8; radius: 4; color: kindColor(modelData.kind) }
                                        }
                                        Label { text: modelData.label; color: muted; font.pixelSize: 13; elide: Text.ElideRight; Layout.fillWidth: true }
                                    }
                                }
                            }
                        }
                        Label { visible: items.length > 0; text: "Recentes"; color: ink; font.pixelSize: 16; font.weight: Font.DemiBold; Layout.topMargin: 4 }
                        GridLayout {
                            Layout.fillWidth: true
                            visible: items.length > 0
                            columns: Math.max(1, Math.min(3, Math.floor((homeColumn.width + 12) / 300)))
                            columnSpacing: 12
                            rowSpacing: 12
                            Repeater {
                                model: recentItems
                                ItemDelegate {
                                    id: recentCard
                                    required property var modelData
                                    Layout.fillWidth: true
                                    Layout.fillHeight: true
                                    Layout.preferredWidth: 1
                                    enabled: backend.available
                                    hoverEnabled: true
                                    focusPolicy: Qt.StrongFocus
                                    Keys.onReturnPressed: clicked()
                                    Keys.onEnterPressed: clicked()
                                    padding: 16
                                    Accessible.name: modelData.title + ", " + origin(modelData.location) + ", " + statusText(modelData.status)
                                    background: Rectangle {
                                        radius: 12
                                        color: recentCard.hovered ? hoverSurface : surface
                                        border.width: recentCard.visualFocus ? 2 : 1
                                        border.color: recentCard.visualFocus ? accent : divider
                                    }
                                    contentItem: ColumnLayout {
                                        spacing: 8
                                        Label { text: modelData.title; textFormat: Text.PlainText; color: ink; font.pixelSize: 15; font.weight: Font.DemiBold; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight; Layout.fillWidth: true }
                                        Label { text: longDate(modelData.modifiedAt) + " · " + origin(modelData.location); textFormat: Text.PlainText; color: modelData.location === "missing" ? warningColor : muted; font.pixelSize: 12; elide: Text.ElideRight; Layout.fillWidth: true }
                                        Flow {
                                            Layout.fillWidth: true
                                            spacing: 6
                                            FtChip { kind: statusKind(modelData.status); text: statusText(modelData.status) }
                                            Repeater {
                                                model: artifactParts(modelData.artifactStatus)
                                                FtChip { required property string modelData; kind: modelData.indexOf("pront") >= 0 ? "accent" : "neutral"; iconName: modelData.indexOf("pront") >= 0 ? "check" : ""; text: modelData }
                                            }
                                        }
                                        Item { Layout.fillHeight: true }
                                    }
                                    onClicked: selectRecording(modelData)
                                }
                            }
                        }
                        FtCard {
                            Layout.fillWidth: true
                            implicitHeight: startColumn.implicitHeight + 32
                            visible: backend.available && items.length > 0
                            ColumnLayout {
                                id: startColumn
                                anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 16
                                spacing: 10
                                RowLayout {
                                    spacing: 10
                                    FtIcon { name: "shield"; tint: accent; size: 20 }
                                    Label { text: "Antes de gravar"; color: ink; font.pixelSize: 15; font.weight: Font.DemiBold }
                                }
                                Label { text: "Confira as regras de detecção, as fontes de áudio e para onde o processamento vai. Confirme a permissão das pessoas envolvidas; pausar a automação não encerra uma captura em andamento."; color: muted; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                                Flow {
                                    Layout.fillWidth: true
                                    spacing: 8
                                    FtButton { text: "Gravação e tarefas…"; iconName: "tools"; onClicked: recordingTools.open() }
                                    FtButton { text: "Configuração e privacidade…"; iconName: "shield"; variant: "outline"; onClicked: onboardingDialog.open() }
                                }
                            }
                        }
                    }
                }

                ColumnLayout {
                    id: detailView
                    objectName: "detailView"
                    anchors.fill: parent
                    anchors.margins: compactLayout ? 14 : 20
                    spacing: compactLayout ? 10 : 14
                    visible: !!selected.key
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 10
                        FtButton { objectName: "backButton"; iconOnly: true; variant: "ghost"; iconName: "back"; text: "Voltar à biblioteca (Esc)"; Accessible.name: "Voltar à biblioteca"; Layout.alignment: Qt.AlignTop; enabled: !revisionPending() && !hasPending("export-save"); onClicked: backToLibrary() }
                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 6
                            Label { text: selected.title || selected.fileName || ""; textFormat: Text.PlainText; color: ink; font.pixelSize: compactLayout ? 19 : 22; font.weight: Font.DemiBold; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight; Layout.fillWidth: true }
                            Flow {
                                Layout.fillWidth: true
                                spacing: 6
                                FtChip { visible: !!longDate(selected.modifiedAt); iconName: "clock"; text: longDate(selected.modifiedAt) }
                                FtChip { kind: selected.location === "missing" ? "warning" : mediaReady && location ? "accent" : "neutral"; iconName: mediaReady && location ? "play" : ""; text: mediaReady && location ? "Reproduzindo · " + origin(location) : origin(selected.location) }
                                FtChip { visible: !!selected.status; kind: statusKind(selected.status); text: statusText(selected.status) || "" }
                                Repeater {
                                    model: artifactParts(selected.artifactStatus)
                                    FtChip { required property string modelData; kind: modelData.indexOf("pront") >= 0 ? "accent" : "neutral"; iconName: modelData.indexOf("pront") >= 0 ? "check" : ""; text: modelData }
                                }
                                FtChip { visible: !!selected.backup && selected.backup !== "none"; text: "Cópias: " + String(selected.backup || "").replace("+", " + ").toUpperCase() }
                            }
                        }
                        FtButton { id:agentAccessButton; objectName:"agentAccessButton"; compact:true; iconName:"key"; iconOnly:compactLayout; text:"Acesso para IA…"; Layout.alignment:Qt.AlignTop; enabled:backend.available && !!selected.recordingId; onClicked:openAgentAccess() }
                        FtButton { objectName:"framesButton"; compact:true; iconName:"frames"; iconOnly:compactLayout; text: mockFramesEnabled ? "Frames · mock local…" : "Análise visual local…"; Layout.alignment:Qt.AlignTop; enabled: backend.available && (mockFramesEnabled || realFramesEnabled) && !!selected.key; onClicked: { cancelFramePreview(); framesDialog.open() } ToolTip.visible: hovered; ToolTip.text: mockFramesEnabled ? "Ensaio sintético explícito, sem provider real." : "Preview local; análise e novo resumo somente após consentimento explícito." }
                    }

                    RowLayout {
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        spacing: compactLayout ? 12 : 16

                        ColumnLayout {
                            id: playerColumn
                            Layout.fillWidth: true
                            Layout.fillHeight: true
                            spacing: 10
                            Rectangle {
                                id: videoFrame
                                Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: 200
                                color: "#05080D"; radius: 12; clip: true
                                RecordingVideo {
                                    id: video; objectName: "recordingVideo"; anchors.fill: parent
                                    onReady: { playerInitialized = true; setPropertyAsync("pause", true); setPropertyAsync("hwdec", smokeSoftware ? "no" : "auto-safe"); setPropertyAsync("volume", 70); loadMedia() }
                                }
                                ColumnLayout {
                                    anchors.centerIn: parent; width: Math.min(parent.width - 48, 420); visible: !mediaReady
                                    spacing: 12
                                    BusyIndicator { Layout.alignment: Qt.AlignHCenter; running: resolving; visible: resolving }
                                    Rectangle {
                                        visible: !resolving
                                        Layout.alignment: Qt.AlignHCenter
                                        implicitWidth: 56; implicitHeight: 56; radius: 28
                                        color: "#17322F"
                                        FtIcon { anchors.centerIn: parent; size: 26; name: selected.location === "missing" ? "alert" : "play"; tint: selected.location === "missing" ? "#FFB377" : "#57D5B0" }
                                    }
                                    Label { Layout.fillWidth: true; text: resolving ? "Preparando a gravação…" : selected.key ? (selected.location === "missing" ? "Mídia indisponível" : "Gravação pronta para abrir") : "Escolha uma gravação"; color: "#F4F1E9"; font.pixelSize: 18; font.weight: Font.DemiBold; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.WordWrap }
                                    Label { Layout.fillWidth: true; visible: !resolving && !!selected.key; text: selected.location === "missing" ? "O arquivo original não está neste computador nem em um destino configurado." : "A mídia é verificada antes de reproduzir; nada é baixado sem a sua ação."; color: "#AAC0B8"; font.pixelSize: 13; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.WordWrap }
                                    FtButton { Layout.alignment: Qt.AlignHCenter; visible: !!selected.key && !resolving && selected.location !== "missing"; enabled: backend.available && selected.location !== "missing"; variant: "primary"; iconName: "play"; text: "Abrir gravação"; onClicked: openRecording() }
                                }
                                Rectangle {
                                    anchors.top: parent.top; anchors.left: parent.left; anchors.margins: 12
                                    width: Math.min(parent.width - 24, voicesRow.implicitWidth + 20); height: voicesRow.implicitHeight + 12; radius: 8
                                    color: "#D90B1716"
                                    visible: mediaReady && !!activeSpeakerLabels(position)
                                    RowLayout {
                                        id: voicesRow
                                        anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; anchors.leftMargin: 10; anchors.rightMargin: 10
                                        spacing: 7
                                        FtIcon { name: "users"; tint: "#57D5B0"; size: 14 }
                                        Label { id: currentVoices; Layout.fillWidth: true; text: activeSpeakerLabels(position) + (detail.review&&detail.review.revision.humanReviewed?" · revisão humana; identidade não confirmada":" · automático"); textFormat: Text.PlainText; color: "#57D5B0"; font.pixelSize: 12; wrapMode: Text.WordWrap; maximumLineCount: 2; elide: Text.ElideRight }
                                    }
                                }
                                Rectangle {
                                    id: captionOverlay; objectName: "captionOverlay"
                                    anchors.bottom: parent.bottom; anchors.bottomMargin: 20; anchors.horizontalCenter: parent.horizontalCenter
                                    width: Math.min(parent.width - 36, caption.implicitWidth + 28); height: Math.min(caption.implicitHeight + 16, parent.height * 0.42)
                                    radius: 10; color: "#E6050B0B"
                                    visible: captions && mediaReady && captionAvailable && activeCaptionText.length > 0
                                    border.width: captionViewport.activeFocus ? 2 : 0; border.color: "#57D5B0"
                                    Flickable {
                                        id: captionViewport; objectName: "captionViewport"
                                        anchors.fill: parent; anchors.margins: 8; clip: true
                                        contentWidth: width; contentHeight: caption.implicitHeight
                                        activeFocusOnTab: captionOverlay.visible && contentHeight > height
                                        Accessible.role: Accessible.Pane
                                        Accessible.name: "Legenda completa"
                                        Accessible.description: "Quando a legenda for longa, use as setas, Page Up, Page Down ou Espaço para percorrer o texto."
                                        ScrollBar.vertical: ScrollBar { policy: captionViewport.contentHeight > captionViewport.height ? ScrollBar.AlwaysOn : ScrollBar.AsNeeded }
                                        Keys.onPressed: event => {
                                            let step = 0
                                            if (event.key === Qt.Key_Down) step = 22
                                            else if (event.key === Qt.Key_Up) step = -22
                                            else if (event.key === Qt.Key_PageDown || event.key === Qt.Key_Space) step = height * 0.8
                                            else if (event.key === Qt.Key_PageUp) step = -height * 0.8
                                            else return
                                            contentY = Math.max(0, Math.min(Math.max(0, contentHeight - height), contentY + step))
                                            event.accepted = true
                                        }
                                        Label { id: caption; width: captionViewport.width - 12; text: activeCaptionText; textFormat: Text.PlainText; color: "white"; wrapMode: Text.WordWrap; horizontalAlignment: Text.AlignHCenter; font.pixelSize: 16; onTextChanged: captionViewport.contentY = 0 }
                                    }
                                }
                            }
                            RowLayout {
                            Layout.fillWidth: true
                            spacing: 10
                            Slider {
                                id: timeline
                                Layout.fillWidth: true
                                from: 0; to: window.duration || 1; value: window.position; enabled: mediaReady
                                Accessible.name: "Posição do vídeo"
                                onMoved: window.seek(value)
                                background: Rectangle {
                                    x: timeline.leftPadding; y: timeline.topPadding + timeline.availableHeight / 2 - height / 2
                                    width: timeline.availableWidth; height: 4; radius: 2
                                    color: divider
                                    Rectangle { width: timeline.visualPosition * parent.width; height: parent.height; radius: 2; color: accent; visible: timeline.enabled }
                                }
                                handle: Rectangle {
                                    x: timeline.leftPadding + timeline.visualPosition * (timeline.availableWidth - width)
                                    y: timeline.topPadding + timeline.availableHeight / 2 - height / 2
                                    implicitWidth: 18; implicitHeight: 18; radius: 9
                                    color: surface
                                    border.width: 3; border.color: timeline.enabled ? accent : dividerStrong
                                    Rectangle { anchors.fill: parent; anchors.margins: -4; radius: 13; color: "transparent"; border.width: 2; border.color: accent; visible: timeline.visualFocus }
                                }
                            }
                            Label { text: clock(position) + " / " + clock(duration); color: muted; font.family: "monospace"; font.pixelSize: 12 }
                            }
                            RowLayout {
                                Layout.fillWidth: true
                                spacing: 8
                                FtButton { iconOnly: true; variant: "primary"; implicitHeight: 40; iconName: paused ? "play" : "pause"; text: paused ? "Reproduzir" : "Pausar"; Accessible.name: paused ? "Reproduzir" : "Pausar"; enabled: mediaReady; onClicked: togglePlay() }
                                FtButton { compact: true; variant: "ghost"; text: "−10 s"; Accessible.name: "Voltar dez segundos"; enabled: mediaReady; onClicked: seek(position - 10) }
                                FtButton { visible: playerColumn.width >= 420; compact: true; variant: "ghost"; text: "+10 s"; Accessible.name: "Avançar dez segundos"; enabled: mediaReady; onClicked: seek(position + 10) }
                                Item { Layout.fillWidth: true }
                                CheckBox {
                                    id: captionToggle; objectName: "captionToggle"
                                    text: window.width < 1100 ? "CC" : "Legendas"
                                    Accessible.name: "Exibir legendas quando houver uma faixa disponível"
                                    checked: captions; enabled: !!selected.key; onToggled: captions = checked
                                    spacing: 8
                                    indicator: Rectangle {
                                        implicitWidth: 34; implicitHeight: 20; radius: 10
                                        x: captionToggle.leftPadding; y: captionToggle.topPadding + (captionToggle.availableHeight - height) / 2
                                        color: captionToggle.checked ? accent : dividerStrong
                                        border.width: captionToggle.visualFocus ? 2 : 0; border.color: ink
                                        opacity: captionToggle.enabled ? 1 : 0.5
                                        Rectangle { width: 14; height: 14; radius: 7; y: 3; x: captionToggle.checked ? parent.width - width - 3 : 3; color: captionToggle.checked ? onAccent : surface }
                                    }
                                    contentItem: Label { text: captionToggle.text; color: captionToggle.enabled ? ink : muted; font.pixelSize: 13; leftPadding: captionToggle.indicator.width + captionToggle.spacing; verticalAlignment: Text.AlignVCenter }
                                }
                            }
                            Label { objectName: "captionStatus"; visible: !!selected.key; text: captionStatusText; textFormat: Text.PlainText; color: captionAvailable ? muted : warningColor; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                        }

                        FtCard {
                            id: sidePanel
                            Layout.preferredWidth: Math.max(compactLayout ? 320 : 340, Math.min(520, detailView.width * 0.42))
                            Layout.fillHeight: true
                            ColumnLayout {
                                anchors.fill: parent
                                anchors.margins: 12
                                spacing: 10
                                TabBar {
                                    id: tabs
                                    Layout.fillWidth: true
                                    spacing: 4
                                    padding: 4
                                    background: Rectangle { radius: 10; color: surfaceAlt; border.width: 1; border.color: divider }
                                    Repeater {
                                        model: [{label: "Transcrição", icon: "transcript"}, {label: "Resumo", icon: "spark"}, {label: "Falantes", icon: "users"}, {label: sidePanel.width < 400 ? "Contexto" : "Contexto IA", icon: "context"}]
                                        TabButton {
                                            id: tabButton
                                            required property var modelData
                                            text: modelData.label
                                            implicitHeight: 34
                                            hoverEnabled: true
                                            font.pixelSize: 13
                                            contentItem: Row {
                                                spacing: 6
                                                FtIcon { visible: sidePanel.width >= 460; name: tabButton.modelData.icon; tint: tabButton.checked ? accent : muted; size: 15; anchors.verticalCenter: parent.verticalCenter }
                                                Label { text: tabButton.text; font.pixelSize: sidePanel.width < 400 ? 12 : 13; font.weight: tabButton.checked ? Font.DemiBold : Font.Normal; color: tabButton.checked ? ink : muted; elide: Text.ElideRight; anchors.verticalCenter: parent.verticalCenter }
                                            }
                                            background: Rectangle {
                                                radius: 7
                                                color: tabButton.checked ? surface : tabButton.hovered ? hoverSurface : "transparent"
                                                border.width: tabButton.visualFocus ? 2 : tabButton.checked ? 1 : 0
                                                border.color: tabButton.visualFocus ? accent : divider
                                                Rectangle { visible: tabButton.checked; anchors.bottom: parent.bottom; anchors.horizontalCenter: parent.horizontalCenter; anchors.bottomMargin: 3; width: Math.min(parent.width - 16, 28); height: 2; radius: 1; color: accent }
                                            }
                                        }
                                    }
                                }

                                ColumnLayout {
                                    visible: !!detail.review && (tabs.currentIndex === 0 || tabs.currentIndex === 2)
                                    Layout.fillWidth: true
                                    spacing: 6
                                    RowLayout {
                                        Layout.fillWidth: true
                                        spacing: 6
                                        Rectangle {
                                            implicitHeight: 26
                                            implicitWidth: revisionStateLabel.implicitWidth + 20
                                            Layout.maximumWidth: sidePanel.width - 150
                                            radius: 13
                                            color: detail.review && detail.review.derivedStale ? warningSoft : accentSoft
                                            Label {
                                                id: revisionStateLabel; objectName: "revisionState"
                                                anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; anchors.leftMargin: 10; anchors.rightMargin: 10
                                                text: detail.review ? "Revisão "+detail.review.revision.revision+(detail.review.derivedStale?" · derivados anteriores desatualizados":" · original preservado") : ""
                                                color: detail.review && detail.review.derivedStale ? warningColor : accent
                                                font.pixelSize: 12; font.weight: Font.Medium; elide: Text.ElideRight
                                            }
                                        }
                                        Item { Layout.fillWidth: true }
                                        FtButton { id:reviewNoteButton; objectName:"reviewNoteButton"; compact:true; variant:"ghost"; iconName:"note"; iconOnly:sidePanel.width < 430; text:"Nota"; Accessible.name:"Adicionar nota humana sem tempo"; enabled:backend.available&&!revisionPending(); onClicked:openReview("note",({})) }
                                        FtButton { objectName:"revisionUndo"; compact:true; variant:"ghost"; iconName:"undo"; iconOnly:sidePanel.width < 430; text:"Desfazer"; Accessible.name:"Desfazer última revisão humana"; enabled:backend.available&&!!detail.review&&detail.review.canUndo===true&&!revisionPending(); onClicked:undoRevision() }
                                        FtButton { id:exportButton; objectName:"exportButton"; compact:true; variant:"ghost"; iconName:"export"; iconOnly:sidePanel.width < 430; text:"Exportar"; enabled:backend.available&&!revisionPending(); onClicked:exportDialog.open() }
                                    }
                                    Label { visible:!!detail.review&&(detail.review.notes||[]).length>0; text:detail.review&&(detail.review.notes||[]).length>0 ? "Notas humanas sem tempo: "+detail.review.notes.length+". Última prévia: "+detail.review.notes[detail.review.notes.length-1].slice(0,180)+(detail.review.notes[detail.review.notes.length-1].length>180?"…":"")+" · conteúdo completo no JSON/Markdown exportado." : ""; textFormat:Text.PlainText; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true; font.pixelSize:12; maximumLineCount: 3; elide: Text.ElideRight }
                                    Label { visible:tabs.currentIndex===0&&!!detail.review&&detail.review.segmentEditUnavailable; text:"Trechos sem correspondência literal no texto original aceitam somente uma nota sem tempo."; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true; font.pixelSize:12 }
                                }
                                Label { visible: tabs.currentIndex === 0 && detail.transcript.timing === "block"; text: "Tempos aproximados por bloco; a revisão não cria alinhamento por palavra."; textFormat: Text.PlainText; color: warningColor; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 12 }

                                ListView {
                                    id:revisionSegmentsList; objectName:"revisionSegmentsList"
                                    visible: tabs.currentIndex === 0 && (detail.transcript.segments || []).length > 0
                                    Layout.fillWidth: true; Layout.fillHeight: true; model: detail.transcript.segments || []; clip: true; spacing: 2
                                    ScrollBar.vertical: ScrollBar {}
                                    delegate: ItemDelegate {
                                        id: segmentItem
                                        required property var modelData; required property int index
                                        readonly property bool activeLine: activeSegment === index
                                        width: ListView.view.width
                                        hoverEnabled: true
                                        leftPadding: 12; rightPadding: 8; topPadding: 8; bottomPadding: 10
                                        Accessible.name: (modelData.speaker ? modelData.speaker + ", " : "") + clock(modelData.start) + ". " + modelData.text
                                        background: Rectangle {
                                            radius: 8
                                            color: segmentItem.activeLine ? selectedSurface : segmentItem.hovered ? hoverSurface : "transparent"
                                            border.width: segmentItem.visualFocus ? 2 : 0; border.color: accent
                                            Rectangle { visible: segmentItem.activeLine; width: 3; radius: 1.5; color: accent; anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom; anchors.topMargin: 8; anchors.bottomMargin: 8 }
                                        }
                                        contentItem: ColumnLayout {
                                            id: segmentContent
                                            spacing: 3
                                            RowLayout {
                                                Layout.fillWidth: true
                                                spacing: 8
                                                Label { text: clock(segmentItem.modelData.start); color: accent; font.pixelSize: 12; font.family: "monospace"; font.weight: Font.DemiBold }
                                                Label { visible: !!segmentItem.modelData.speaker; text: segmentItem.modelData.speaker || ""; textFormat: Text.PlainText; color: ink; font.pixelSize: 12; font.weight: Font.DemiBold; elide: Text.ElideRight; Layout.fillWidth: true }
                                                Item { visible: !segmentItem.modelData.speaker; Layout.fillWidth: true }
                                                FtChip { visible: segmentItem.modelData.humanEdited === true; text: "Revisado"; kind: "accent"; implicitHeight: 20 }
                                                FtButton { objectName:"segmentReview-"+(segmentItem.modelData.id||segmentItem.index); text:"Revisar"; Accessible.name: "Revisar trecho " + clock(segmentItem.modelData.start); iconName: "edit"; iconOnly: true; compact: true; variant: "ghost"; implicitHeight: 28; visible:!!segmentItem.modelData.id; enabled:backend.available&&!revisionPending()&&!!segmentItem.modelData.textRange; onClicked:openReview("segment-text",segmentItem.modelData) }
                                            }
                                            Label { text: segmentItem.modelData.text; textFormat: Text.PlainText; color: ink; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 14; lineHeight: 1.12 }
                                        }
                                        onClicked: seek(modelData.start)
                                    }
                                }

                                ColumnLayout {
                                    visible: tabs.currentIndex === 1
                                    Layout.fillWidth: true
                                    Layout.fillHeight: true
                                    spacing: 8
                                    Flow {
                                        Layout.fillWidth: true
                                        spacing: 6
                                        FtButton { id:summaryRegenerateButton;objectName:"summaryRegenerateButton"; compact:true; iconName:"spark"; text:"Regenerar resumo…";enabled:backend.available&&!!detail.review&&!revisionPending()&&!detailLoading&&!summaryBusy();onClicked:openSummary();Accessible.name:"Preparar plano e consentimento para regenerar o resumo" }
                                        FtButton { id: visualSummaryButton; objectName: "visualSummaryButton"; compact: true; variant: "outline"; iconName: "frames"; visible: !!detail.visualReview && !!detail.visualReview.summaryMarkdown; text: showVisualSummary ? "Voltar ao resumo da transcrição" : (detail.visualReview && detail.visualReview.scope ? "Ver resumo parcial do intervalo visual" : "Ver resumo visual solicitado"); onClicked: showVisualSummary=!showVisualSummary }
                                    }
                                    Label { visible: showVisualSummary && !!detail.visualReview; text: detail.visualReview && detail.visualReview.scope ? "PARCIAL · " + preciseClock(detail.visualReview.scope.startSeconds) + "–" + preciseClock(detail.visualReview.scope.endSeconds) + " · restante omitido; revisar origem" : "Resumo visual solicitado · revisar origem"; textFormat: Text.PlainText; color: warningColor; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 12 }
                                    Rectangle {
                                        Layout.fillWidth: true
                                        implicitHeight: provenanceColumn.implicitHeight + 20
                                        radius: 10
                                        color: detail.review && detail.review.derivedStale || !detail.summary ? warningSoft : surfaceAlt
                                        border.width: 1; border.color: divider
                                        RowLayout {
                                            anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 10
                                            spacing: 8
                                            FtIcon { Layout.alignment: Qt.AlignTop; name: detail.review && detail.review.derivedStale || !detail.summary ? "alert" : "info"; tint: detail.review && detail.review.derivedStale || !detail.summary ? warningColor : accent; size: 16 }
                                            ColumnLayout {
                                                id: provenanceColumn
                                                Layout.fillWidth: true
                                                spacing: 4
                                                Label { visible: !!detail.artifactMessage; text: detail.artifactMessage || ""; textFormat: Text.PlainText; color: ink; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 12 }
                                                Label { text: detail.summaryInfo ? "Resumo: " + detail.summaryInfo + " · Resumo de IA: confira a fonte e os avisos de revisão." : "Resumo de IA: confira a fonte e os avisos de revisão."; textFormat: Text.PlainText; color: muted; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 11 }
                                            }
                                        }
                                    }
                                    ListView {
                                        id: summaryView
                                        objectName: "summaryView"
                                        Layout.fillWidth: true
                                        Layout.fillHeight: true
                                        clip: true
                                        spacing: 6
                                        model: summaryBlocks((showVisualSummary && detail.visualReview ? detail.visualReview.summaryMarkdown : detail.summary) || "")
                                        ScrollBar.vertical: ScrollBar {}
                                        delegate: Item {
                                            id: summaryBlock
                                            required property var modelData
                                            width: ListView.view.width - 8
                                            height: blockRow.implicitHeight + (modelData.kind === "heading" ? 10 : 0)
                                            RowLayout {
                                                id: blockRow
                                                width: parent.width
                                                y: summaryBlock.modelData.kind === "heading" ? 10 : 0
                                                spacing: 8
                                                Label { visible: summaryBlock.modelData.kind === "bullet"; text: "•"; color: accent; font.pixelSize: 15; Layout.alignment: Qt.AlignTop }
                                                Label {
                                                    Layout.fillWidth: true
                                                    text: summaryBlock.modelData.text
                                                    textFormat: Text.PlainText
                                                    wrapMode: Text.Wrap
                                                    color: summaryBlock.modelData.kind === "heading" ? accent : ink
                                                    font.pixelSize: summaryBlock.modelData.kind === "title" ? 17 : summaryBlock.modelData.kind === "heading" ? 12 : 14
                                                    font.weight: summaryBlock.modelData.kind === "title" || summaryBlock.modelData.kind === "heading" ? Font.DemiBold : Font.Normal
                                                    font.letterSpacing: summaryBlock.modelData.kind === "heading" ? 0.8 : 0
                                                    font.capitalization: summaryBlock.modelData.kind === "heading" ? Font.AllUppercase : Font.MixedCase
                                                    lineHeight: summaryBlock.modelData.kind === "paragraph" || summaryBlock.modelData.kind === "bullet" ? 1.15 : 1
                                                }
                                                FtButton { visible: summaryBlock.modelData.seconds >= 0; compact: true; variant: "ghost"; implicitHeight: 26; iconName: "play"; text: clock(summaryBlock.modelData.seconds); Accessible.name: "Ir à origem " + clock(summaryBlock.modelData.seconds); enabled: mediaReady; Layout.alignment: Qt.AlignTop; onClicked: seek(summaryBlock.modelData.seconds) }
                                            }
                                        }
                                        Label { anchors.centerIn: parent; width: parent.width - 32; visible: summaryView.count === 0; text: detailLoading ? "Carregando…" : "Resumo ainda não disponível."; color: muted; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.WordWrap }
                                    }
                                }

                                ColumnLayout {
                                    visible: tabs.currentIndex === 2
                                    Layout.fillWidth: true
                                    Layout.fillHeight: true
                                    spacing: 8
                                    Label { textFormat: Text.PlainText; text: detail.diarization.message || "Identifique os falantes para revisar suas participações nesta gravação."; color: detail.diarization.state === "failed" ? errorColor : muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                                    Label { visible: (detail.diarization.turns || []).length > 0; text: "Transcrição mostra a vista revisada; o original é preservado. Os horários das falas pertencem ao diarizador."; color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                                    FtOverline { text: "Nomes dos falantes"; visible: speakerRows.length > 0 }
                                    ListView {
                                        id:revisionSpeakersList; objectName:"revisionSpeakersList"
                                        visible: speakerRows.length > 0
                                        Layout.fillWidth: true; Layout.preferredHeight: Math.min(132, speakerRows.length * 44); model: speakerRows; clip: true; spacing: 2
                                        ScrollBar.vertical: ScrollBar {}
                                        delegate: ItemDelegate {
                                            id: speakerItem
                                            required property var modelData
                                            width: ListView.view.width; height: 42
                                            enabled: backend.available && !!selected.key
                                            leftPadding: 8; rightPadding: 4
                                            Accessible.name: modelData.label || "Falante incerto"
                                            background: Rectangle { radius: 8; color: speakerItem.hovered ? hoverSurface : "transparent"; border.width: speakerItem.visualFocus ? 2 : 0; border.color: accent }
                                            contentItem: RowLayout {
                                                spacing: 8
                                                FtChip { text: speakerItem.modelData.speakerId; kind: "accent"; maximumWidth: 90 }
                                                Label { text:speakerItem.modelData.label||"Falante incerto"; textFormat:Text.PlainText; color:speakerItem.modelData.label ? ink : muted; Layout.fillWidth:true; elide:Text.ElideRight }
                                                FtButton { objectName:"speakerReview-"+speakerItem.modelData.speakerId; text:"Revisar"; compact:true; variant:"ghost"; iconName:"edit"; implicitHeight: 30; Accessible.name:"Revisar nome do falante "+speakerItem.modelData.speakerId; enabled:backend.available&&!revisionPending()&&!!detail.review; onClicked:openReview("speaker-label",speakerItem.modelData) }
                                            }
                                        }
                                    }
                                    FtOverline { text: "Falas do diarizador · texto automático, revisar"; Layout.fillWidth: true; wrapMode: Text.WordWrap }
                                    Label { visible: !!detail.diarization.textCoverage && detail.diarization.textCoverage.shownTurns < detail.diarization.textCoverage.totalTurns; text: detail.diarization.textCoverage ? "Texto parcial na interface: " + detail.diarization.textCoverage.shownTurns + "/" + detail.diarization.textCoverage.totalTurns + " falas. Os horários e nomes continuam disponíveis; o resultado local completo foi preservado." : ""; textFormat: Text.PlainText; color: warningColor; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 12 }
                                    ListView {
                                        id:revisionTurnsList; objectName:"revisionTurnsList"
                                        Layout.fillWidth: true; Layout.fillHeight: true; model: detail.diarization.turns || []; clip: true; spacing: 2
                                        ScrollBar.vertical: ScrollBar {}
                                        delegate: ItemDelegate {
                                            id: turnItem
                                            required property var modelData
                                            width: ListView.view.width; enabled: true
                                            hoverEnabled: true
                                            leftPadding: 10; rightPadding: 8; topPadding: 8; bottomPadding: 10
                                            Accessible.name: (modelData.label || modelData.speaker || "Falante incerto") + ", " + preciseClock(modelData.start) + " a " + preciseClock(modelData.end) + ". " + (modelData.text !== undefined ? modelData.text : "Texto não disponível nesta prévia.")
                                            background: Rectangle { radius: 8; color: turnItem.hovered ? hoverSurface : "transparent"; border.width: turnItem.visualFocus ? 2 : 0; border.color: accent }
                                            contentItem: ColumnLayout {
                                                id: turnContent; spacing: 4
                                                RowLayout {
                                                    spacing: 8
                                                    Label { text: preciseClock(turnItem.modelData.start) + "–" + preciseClock(turnItem.modelData.end); color: accent; font.family: "monospace"; font.pixelSize: 11 }
                                                    Label { text: turnItem.modelData.label || turnItem.modelData.speaker || "Falante incerto"; textFormat: Text.PlainText; color: ink; font.pixelSize: 12; font.weight: Font.DemiBold; Layout.fillWidth: true; elide: Text.ElideRight }
                                                }
                                                Label { text: turnItem.modelData.text !== undefined ? turnItem.modelData.text : "Texto não disponível nesta prévia."; textFormat: Text.PlainText; color: turnItem.modelData.text !== undefined ? ink : muted; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 13 }
                                                FtButton { objectName:"turnReview-"+(turnItem.modelData.id||""); text:"Revisar atribuição"; compact:true; variant:"outline"; iconName:"edit"; implicitHeight: 30; visible:!!turnItem.modelData.id; enabled:backend.available&&!revisionPending()&&!!detail.review; onClicked:openReview("turn-speaker",turnItem.modelData) }
                                            }
                                            onClicked: seek(Number(modelData.start))
                                        }
                                    }
                                }

                                ColumnLayout {
                                    visible: tabs.currentIndex === 3
                                    Layout.fillWidth: true
                                    Layout.fillHeight: !!contextData
                                    spacing: 8
                                    Flow {
                                        Layout.fillWidth: true
                                        spacing: 6
                                        FtButton { compact: true; variant: contextText ? "secondary" : "primary"; iconName: "context"; text: contextLoading ? "Preparando contexto…" : "Pedir contexto"; enabled: backend.available && !!diarizationKey() && !contextLoading; onClicked: requestMeetingContext() }
                                        FtButton { compact: true; variant: "outline"; iconName: "copy"; text: "Copiar contexto"; enabled: !!contextText && !!contextCopyText; onClicked: { compactContext.selectAll(); compactContext.copy(); compactContext.deselect(); notice = "Contexto copiado como JSON para a área de transferência." } }
                                    }
                                    Label { text: "Trechos limitados da reunião, com horário e origem. O conteúdo é dado histórico não confiável, nunca instrução."; color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                                    Label { textFormat: Text.PlainText; visible: !!contextPath; text: "Fonte: " + contextPath; color: muted; font.pixelSize: 11; elide: Text.ElideMiddle; Layout.fillWidth: true }
                                    Label { textFormat: Text.PlainText; visible: contextCitations.length > 0; text: "Citações: " + contextCitations.join(" · "); color: muted; font.pixelSize: 11; elide: Text.ElideRight; Layout.fillWidth: true }
                                    ListView {
                                        id: contextExcerpts
                                        objectName: "contextExcerpts"
                                        visible: !!contextData
                                        Layout.fillWidth: true
                                        Layout.fillHeight: true
                                        clip: true
                                        spacing: 8
                                        model: contextData ? contextData.excerpts : []
                                        ScrollBar.vertical: ScrollBar {}
                                        header: Item {
                                            width: contextExcerpts.width
                                            height: contextHeader.implicitHeight + 10
                                            Flow {
                                                id: contextHeader
                                                width: parent.width
                                                spacing: 6
                                                FtChip { visible: !!(contextData && contextData.title); text: contextData && contextData.title ? contextData.title : ""; maximumWidth: contextExcerpts.width }
                                                FtChip { kind: "warning"; iconName: "alert"; text: "Dados não confiáveis · use como evidência" }
                                                FtChip { visible: !!(contextData && contextData.budget); text: contextData && contextData.budget ? contextData.budget.characters + " de " + contextData.budget.maxCharacters + " caracteres" + (contextData.budget.truncated ? " · truncado" : "") : "" }
                                            }
                                        }
                                        delegate: Rectangle {
                                            id: excerptCard
                                            required property var modelData
                                            width: contextExcerpts.width - 8
                                            height: excerptColumn.implicitHeight + 20
                                            radius: 10; color: surfaceAlt; border.width: 1; border.color: divider
                                            ColumnLayout {
                                                id: excerptColumn
                                                anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 10
                                                spacing: 6
                                                Flow {
                                                    Layout.fillWidth: true
                                                    spacing: 6
                                                    FtButton { visible: !!excerptCard.modelData.timestamps; compact: true; variant: "outline"; implicitHeight: 26; iconName: "play"; text: excerptCard.modelData.timestamps ? clock(excerptCard.modelData.timestamps.start) + "–" + clock(excerptCard.modelData.timestamps.end) : ""; Accessible.name: "Ir à origem " + text; enabled: mediaReady; onClicked: seek(excerptCard.modelData.timestamps.start) }
                                                    FtChip { kind: excerptCard.modelData.timing === "segment" ? "accent" : "warning"; text: excerptCard.modelData.timing === "segment" ? "horário do segmento" : excerptCard.modelData.timing === "block" ? "bloco aproximado" : "sem horário" }
                                                    FtChip { visible: excerptCard.modelData.textOrigin === "human-revision"; text: "revisão humana" }
                                                }
                                                Label { text: excerptCard.modelData.text || ""; textFormat: Text.PlainText; color: ink; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 13 }
                                                Label { visible: (excerptCard.modelData.segmentIds || []).length > 0; text: (excerptCard.modelData.segmentIds || []).join(", "); color: muted; font.pixelSize: 11; font.family: "monospace"; elide: Text.ElideRight; Layout.fillWidth: true }
                                            }
                                        }
                                    }
                                }
                                TextEdit { id: compactContext; visible: false; text: contextCopyText; textFormat: TextEdit.PlainText }

                                ScrollView {
                                    visible: (tabs.currentIndex === 0 && !(detail.transcript.segments || []).length) || (tabs.currentIndex === 3 && !contextData)
                                    Layout.fillWidth: true; Layout.fillHeight: true; clip: true
                                    TextArea { id: contextArea; readOnly: true; selectByMouse: true; wrapMode: TextEdit.Wrap; textFormat: TextEdit.PlainText; color: ink; font.pixelSize: 14; text: tabs.currentIndex === 0 ? detail.transcript.text || (detailLoading ? "Carregando…" : "Transcrição ainda não disponível.") : tabs.currentIndex === 1 ? (showVisualSummary && detail.visualReview ? detail.visualReview.summaryMarkdown : detail.summary) || "Resumo ainda não disponível." : tabs.currentIndex === 3 ? (contextText || (contextLoading ? "Preparando contexto sob demanda…" : "Peça o contexto para esta gravação quando precisar.")) : detail.timesheet || "Nenhum apontamento vinculado a esta gravação."
                                        background: Item {} }
                                }
                                FtButton { visible: tabs.currentIndex === 0 && !!detail.subtitleId; Layout.fillWidth: true; variant: "outline"; iconName: "transcript"; text: subtitleQueued ? "Legendas em preparação…" : "Gerar legendas no worker configurado"; enabled: backend.available && !subtitleQueued && detail.subtitleState !== "ready"; onClicked: { subtitleQueued = true; if (send("subtitles", detail.subtitleId) < 0) subtitleQueued = false } }
                                FtButton { visible: (tabs.currentIndex === 0 || tabs.currentIndex === 2) && !!detail.diarizationId && !(tabs.currentIndex === 2 && detail.diarization.state === "review"); Layout.fillWidth: true; variant: "outline"; iconName: "users"; text: diarizationQueued ? "Identificação em preparação…" : detail.diarization.state === "review" ? "Ver falantes" : "Identificar falantes"; enabled: backend.available && !diarizationQueued; onClicked: { if (detail.diarization.state === "review") tabs.currentIndex = 2; else { diarizationQueued = true; if (send("diarization", detail.diarizationId) < 0) diarizationQueued = false } } }
                            }
                        }
                    }
                }
            }
        }

        Rectangle {
            id: statusBar
            Layout.fillWidth: true
            Layout.preferredHeight: Math.max(34, statusRow.implicitHeight + 14)
            color: chrome
            Rectangle { anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; height: 1; color: divider }
            RowLayout {
                id: statusRow
                anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                anchors.leftMargin: 16; anchors.rightMargin: 16
                spacing: 10
                FtIcon { name: errorText ? "alert" : notice ? "info" : "keyboard"; tint: errorText ? errorColor : notice ? accent : muted; size: 15 }
                Label { objectName: "keyboardHelp"; textFormat: Text.PlainText; text: errorText || notice || (captionHasFocus() ? "Legendas: setas, Page Up/Down ou Espaço percorrem o texto · Tab sai" : "Espaço: reproduzir/pausar · Setas: ±5 s · Esc: biblioteca · Trechos: navegar à origem"); color: errorText ? errorColor : notice ? ink : muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                Label { text: window.width < 1180 ? "Serviços continuam ao fechar a janela" : "Captura, processamento e backups continuam nos serviços ao fechar esta janela."; color: muted; font.pixelSize: 11; horizontalAlignment: Text.AlignRight; Layout.maximumWidth: window.width * 0.42; elide: Text.ElideRight }
            }
        }
    }
}
