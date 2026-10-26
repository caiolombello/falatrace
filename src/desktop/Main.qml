import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Recording 1.0
import "i18n.js" as I18n

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
    // Interface language. Portuguese is the source text; English comes from i18n.js. The saved
    // choice (studio.language) wins, a settings draft previews it, and "auto" follows the system:
    // pt_* and the bare C/POSIX locale stay in Portuguese, any other locale gets English.
    readonly property string systemLanguage: /^(pt|C$|POSIX$)/.test(Qt.locale().name) ? "pt" : "en"
    property string languagePreference: "auto"
    property string languagePreview: ""
    readonly property string uiLanguage: {
        const choice = languagePreview || languagePreference
        return choice === "en" ? "en" : choice === "pt-BR" ? "pt" : systemLanguage
    }
    function t(text) { return uiLanguage === "en" ? I18n.translate(text) : text }
    // t() with %1, %2… placeholders filled in after translation.
    function tf(text) {
        let result = t(text)
        for (let index = arguments.length - 1; index >= 1; index--) result = result.split("%" + index).join(String(arguments[index]))
        return result
    }
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
    // Notes document: your lines in ink, lines the AI completed in aiInk (6.5:1 / 8.9:1), moments as accent chips.
    property color noteInk: ink
    property color aiInk: lightTheme ? "#4D625D" : "#B4C8C1"
    property color citationSurface: accentSoft
    property color citationInk: accent
    property color flashSurface: lightTheme ? "#FFF1D6" : "#3A3020"
    property color pageSurface: surface
    readonly property int docMaxWidth: 720
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
    // Bumped when a settings change may move the recordings folder; older list answers are ignored.
    property int libraryEpoch: 0
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
    property bool speakersQueued: false
    // Name suggestions for the diarized speakers; nothing is applied without a revision.
    property var speakerSuggestions: detail.speakerSuggestions || ({state: "unavailable", items: []})
    property string initialTranscriptTiming: ""
    property string transcriptTiming: detail.transcript.timing
    property int transcriptSegments: (detail.transcript.segments || []).length
    property int activeSegment: -1
    property var captionTrack: detail.captionTranscript || detail.transcript
    property bool captionAvailable: captionTrack.timing === "segment" && (captionTrack.segments || []).length > 0
    property string activeCaptionText: captionTextAt(position)
    property string captionStatusText: {
        if (detailLoading) return t("Carregando a faixa de legendas…")
        if (captionAvailable) {
            const source = detail.captionSource === "diarization"
                ? t("Falas automáticas · revise texto e horários") + (detail.captionPartial ? t(" · faixa parcial") : "")
                : t("Faixa de legendas por segmento")
            const label=source+(detail.captionOriginalText?t(" · texto da faixa original; correções na aba Transcrição"):"")
            return captions ? label : t("Legendas desativadas · ") + label
        }
        if (detail.subtitleState === "running") return t("Legendas em preparação; ainda não há faixa disponível.")
        return (captions ? t("Preferência de legendas ativada. ") : t("Legendas desativadas. "))
            + (t(detail.subtitleMessage || "") || t("Sem faixa temporizada disponível; a transcrição original continua na aba Transcrição."))
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
    property bool summaryPolling: false
    property bool summaryNeedsReload: false
    property bool summaryCompleted: false
    property bool captureBusy: false
    property bool captureKnown: false
    // ── Shell (DESIGN-STUDIO §2.1–2.3) ──────────────────────────────────────
    // What the bridge offers (ux-capabilities): a new op family is sent only when its flag is true.
    property var features: ({})
    property var firstRun: ({})
    function feature(name) { return features[name] === true }
    // Saved settings the shell reads from the startup settings-read (live provider, automatic processing).
    property var studioSettings: ({})
    // Where the main area is: home or live here; later packages add actions, people and clients.
    // A selected meeting always wins (currentView "meeting").
    property string view: "home"
    readonly property string currentView: selected.key ? "meeting" : view
    readonly property var viewFeatures: ({actions: "actions", people: "people", clients: "clients"})
    property var implementedViews: ["home", "live"]
    function viewAvailable(name) {
        if (implementedViews.indexOf(name) < 0) return false
        const flag = viewFeatures[name]
        return !flag || feature(flag)
    }
    // A cited moment waiting for the media to open; seek(pendingSeek) runs once mediaReady turns true.
    property real pendingSeek: -1
    onMediaReadyChanged: if (mediaReady && pendingSeek >= 0) { const at = pendingSeek; pendingSeek = -1; seek(at) }
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
        "settings": '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="6.5"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
        "tools": '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
        "transcript": '<path d="M5 6h14M5 10h14M5 14h9M5 18h6"/>',
        "undo": '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
        "users": '<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="16.5" cy="10" r="2.6"/><path d="M15.5 14.2a4.5 4.5 0 0 1 5 4.8"/>',
        "home": '<path d="M4 11l8-6.5 8 6.5"/><path d="M6.5 9.5V19h11V9.5"/><path d="M10 19v-5h4v5"/>',
        "calendar": '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
        "bell": '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2H5z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
        "list-check": '<path d="M4 7l1.6 1.6L8.5 5.6M4 15l1.6 1.6 2.9-3"/><path d="M11.5 7.5H20M11.5 15.5H20"/>',
        "user": '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
        "building": '<rect x="5" y="3.5" width="10" height="17" rx="1"/><path d="M15 9.5h4v11h-4M8 7.5h1M11 7.5h1M8 11h1M11 11h1M8 14.5h1M11 14.5h1"/>',
        "chat": '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-9l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"/>',
        "send": '<path d="M4 12l16-7-6 15-2.5-6.5z"/><path d="M11.5 13.5L20 5"/>',
        "slash": '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M14 7.5l-4 9"/>',
        "template": '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M10 9v11"/>',
        "lock": '<rect x="5.5" y="10.5" width="13" height="10" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
        "cloud": '<path d="M7 18.5h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 9.5a4.5 4.5 0 0 0 0 9z"/>',
        "external": '<path d="M14 4.5h5.5V10M19.5 4.5L11 13"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
        "wave": '<path d="M4 12h1.5M8 8v8M11.5 5v14M15 9v6M18.5 11v2"/>',
        "mic": '<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>',
        "more": '<circle cx="6" cy="12" r="1.2" fill="%C"/><circle cx="12" cy="12" r="1.2" fill="%C"/><circle cx="18" cy="12" r="1.2" fill="%C"/>',
        "chevron-down": '<path d="M7 10l5 5 5-5"/>',
        "chevron-right": '<path d="M10 7l5 5-5 5"/>',
        "close": '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
        "plus": '<path d="M12 5.5v13M5.5 12h13"/>',
        "trash": '<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/>',
        "filter": '<path d="M4.5 6h15l-6 7.5V19l-3 1.5v-7z"/>',
        "merge": '<path d="M7 4v4a4 4 0 0 0 4 4h6M7 20v-4a4 4 0 0 1 4-4"/><path d="M14 9l3 3-3 3"/>',
        "eye-off": '<path d="M3 12s3.5-6 9-6c1.6 0 3 .5 4.2 1.2M21 12s-3.5 6-9 6c-1.6 0-3-.5-4.2-1.2"/><path d="M4 4l16 16"/>',
        "flag": '<path d="M6 21V4M6 4.5h11l-2 4 2 4H6"/>',
        "skip": '<path d="M6 6l8 6-8 6z"/><path d="M17.5 6v12"/>',
        "video": '<rect x="3.5" y="6.5" width="12" height="11" rx="2"/><path d="M15.5 10.5l5-3v9l-5-3"/>',
        "sidebar": '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9 4.5v15"/>',
        "history": '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 5v4h4M12 8v4l3 2"/>',
        "link": '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
        "share": '<circle cx="6.5" cy="12" r="2.3"/><circle cx="17.5" cy="6" r="2.3"/><circle cx="17.5" cy="18" r="2.3"/><path d="M8.6 10.9l6.8-3.8M8.6 13.1l6.8 3.8"/>',
        "checklist": '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12.3l2.7 2.7 5.3-6"/>',
        "heading": '<path d="M6 5v14M18 5v14M6 12h12"/>',
        "list": '<path d="M9 7h11M9 12h11M9 17h11"/><circle cx="4.8" cy="7" r=".9" fill="%C"/><circle cx="4.8" cy="12" r=".9" fill="%C"/><circle cx="4.8" cy="17" r=".9" fill="%C"/>'
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
    function shortDate(value) { const date = new Date(value); return isNaN(date.getTime()) ? "" : Qt.formatDateTime(date, t("dd/MM · HH:mm")) }
    function longDate(value) { const date = new Date(value); return isNaN(date.getTime()) ? "" : Qt.formatDateTime(date, t("dd/MM/yyyy · HH:mm")) }
    // Generated titles ("Gravação — date") are translated; meeting titles are user data and never are.
    function recordingTitle(item) { return !item ? "" : item.hasMeetingTitle === false ? t(item.title || "") : (item.title || "") }
    function artifactParts(value) { return String(value || "").split(" · ").filter(part => part.length > 0).map(part => t(part)) }
    function audioLabel() {
        const configured = captureStatus.audio && captureStatus.audio.configured
        if (!configured) return t("Áudio não validado")
        return ({both: t("Microfone + áudio do sistema"), microphone: t("Somente microfone"), desktop: t("Somente áudio do sistema"), none: t("Áudio desativado")})[configured.audioSource] || t("Áudio: ") + configured.audioSource
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
            if (item.status === "failed" || mediaMissing(item)) attention += 1
        }
        return {total: items.length, transcripts: transcripts, active: active, attention: attention}
    }
    // Media removed by the retention policy (transcript-only, audio-only) is a choice, not a problem: never "attention".
    function mediaMissing(item) { return item.location === "missing" && item.media !== "removed" && item.media !== "audio-only" }
    function mediaGone(item) { return item.location === "missing" || item.location === "transcript-only" }


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
    property var settingsData: ({})
    property var settingsDraft: ({})
    property var settingsDiag: ({})
    // The draft changes the shown diagnostic was made for, so a later edit can flag it as out of date.
    property string settingsDiagChanges: "{}"
    property int settingsGeneration: 0
    property string settingsError: ""
    property string settingsNotice: ""
    property bool settingsNeedsReload: false
    property bool settingsFirstRun: false
    property bool settingsFirstRunChecked: false
    readonly property bool settingsEditable: backend.available && !!settingsData.revision && !hasSettingsPending("settings-read") && !hasSettingsPending("settings-save")
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
    property bool uxModal: settingsDialog.visible || setupWizard.visible || processDialog.visible || aboutDialog.visible || captureConsent.visible || framesDialog.visible || onboardingDialog.visible || agentDialog.visible || recordingTools.visible || reviewDialog.visible || exportDialog.visible || summaryDialog.visible || speakerSuggestDialog.visible
    function summaryBusy() { return summaryRunning || hasPending("summary-plan") || hasPending("summary-run") }
    function summaryPlanText() {
        const p=summaryPlan
        if (!p.requestId) return hasPending("summary-plan") ? t("Preparando plano local; nenhum modelo chamado…") : t("Escolha o limite e prepare o plano. Nenhum modelo é chamado nesta etapa.")
        const provider=p.provider||({}), cost=p.cost||({})
        return t("Modelo: ")+provider.provider+" / "+provider.model+t("\nDestino: ")+(provider.endpoint||t("Indisponível"))+
            t("\nRevisão ")+p.revision+" · "+p.inputCharacters+t(" caracteres de transcrição · ")+p.chunkCount+t(" partes · limite ")+p.maxRequests+t(" chamadas")+
            t("\nContexto do job: ")+(p.contextIncluded?t("incluído"):t("omitido"))+t(". Notas humanas sem tempo e rótulos acústicos não entram no modelo.")+
            t("\nCusto: ")+(cost.state==="known"?String(cost.estimatedUsd)+t(" USD"):t("desconhecido; processamento local consome recursos, sem estimativa monetária"))+
            t("\nLimite persistente: 32 pedidos por gravação, até 8 chamadas por plano. Nova sessão não repõe o limite.")
    }
    function abandonSummary() {
        if (!summaryCompleted && summaryRequestId && summaryJobId && backend.available) send("summary-cancel",summaryJobId,{requestId:summaryRequestId})
        summaryGeneration+=1;summaryPlan=({});summaryConsent.checked=false;summaryRequestId="";summaryJobId="";summaryRunning=false;summaryPolling=false;summaryCompleted=false
    }
    function summaryConnectionLost() {
        summaryGeneration+=1;summaryPlan=({});summaryConsent.checked=false;summaryRunning=false;summaryPolling=false;summaryNeedsReload=true
        if(summaryDialog.visible)summaryError=t("Conexão perdida; a geração pode ter iniciado. Releia o resumo antes de preparar outro pedido. O original foi preservado.")
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
        sourceReferenceSeconds=time; framesDialog.close(); if(mediaReady)seek(time); else notice=t("Referência selecionada em ") + preciseClock(time) + t(". Playback físico não validado.")
    }
    function followFrameReference() {
        if (!frameResult.sourceKey || frameResult.sourceKey !== selected.key) return
        const time = frameResult.timestampSeconds
        sourceReferenceSeconds = time; framesDialog.close()
        if (mediaReady) seek(time)
        else notice = t("Referência selecionada em ") + preciseClock(time) + t(". Abra o vídeo para reproduzir; playback não validado no fixture.")
    }
    function confirmFrames() {
        if (framePreview.id && !hasPending("frames-confirm")) send("frames-confirm", selected.key, {previewId: framePreview.id, consent: true, consentKey: framePreview.consentKey || ""})
    }
    FramesDialog { id: framesDialog }
    property alias frameQuestion: framesDialog.frameQuestion
    property alias frameScroll: framesDialog.frameScroll
    property alias frameSeconds: framesDialog.frameSeconds
    property alias plannerTranscriptConsent: framesDialog.plannerTranscriptConsent
    property alias scopeEnd: framesDialog.scopeEnd
    property alias scopeStart: framesDialog.scopeStart
    property alias frameCancelButton: framesDialog.frameCancelButton
    property alias frameColumn: framesDialog.frameColumn
    property alias frameSummaryModel: framesDialog.frameSummaryModel
    property alias frameVisionModel: framesDialog.frameVisionModel


    AgentDialog { id: agentDialog }
    property alias agentConsent: agentDialog.agentConsent
    property alias agentMode: agentDialog.agentMode
    property alias agentScrollView: agentDialog.agentScrollView
    property alias grantPicker: agentDialog.grantPicker
    property alias providerConsent: agentDialog.providerConsent
    property alias providerContext: agentDialog.providerContext
    property alias providerCostLimit: agentDialog.providerCostLimit
    property alias providerImageTokens: agentDialog.providerImageTokens
    property alias providerInputRate: agentDialog.providerInputRate
    property alias providerModel: agentDialog.providerModel
    property alias providerOutputRate: agentDialog.providerOutputRate
    property alias providerPicker: agentDialog.providerPicker
    property alias providerRequests: agentDialog.providerRequests
    property alias providerTariffSource: agentDialog.providerTariffSource
    property alias providerUnknown: agentDialog.providerUnknown

    RecordingToolsDialog { id: recordingTools }
    property alias toolsScroll: recordingTools.toolsScroll


    SettingsDialog { id: settingsDialog }
    property alias settingsTabs: settingsDialog.settingsTabs
    SetupWizard { id: setupWizard }

    function handleSettingsResponse(request, message) {
        // Reads, saves and restores all carry the saved interface language.
        if (message.ok && ["settings-read", "settings-save", "settings-restore"].indexOf(request.op) >= 0) {
            const savedValues = message.result.values || (message.result.settings && message.result.settings.values)
            if (savedValues) { languagePreference = savedValues["studio.language"] || "auto"; studioSettings = savedValues; if (request.op !== "settings-read") languagePreview = "" }
        }
        if (request.origin === "wizard") { setupWizard.handleResponse(request, message); return }
        if (request.settingsGeneration !== settingsGeneration) return
        const result = message.result
        if (request.op === "settings-read" && !settingsDialog.visible) {
            // Startup probe: run the guided setup once when no configuration exists yet.
            if (message.ok && result.exists === false && !settingsFirstRunChecked) { settingsFirstRun = true; setupWizard.open() }
            settingsFirstRunChecked = true
            return
        }
        if (!settingsDialog.visible) return
        if (["settings-read", "settings-save", "settings-diagnose", "settings-service"].indexOf(request.op) < 0) { settingsDialog.handleExtra(request, message); return }
        if (!message.ok) {
            if (request.op === "settings-diagnose") { settingsDiag = ({}); settingsNotice = ""; settingsError = message.error; return }
            if (request.op === "settings-save") settingsNeedsReload = true
            if (request.op === "settings-read") settingsNeedsReload = true
            settingsError = message.error
            return
        }
        if (request.op === "settings-read") {
            settingsData = result; settingsDraft = Object.assign({}, result.values); settingsError = ""; settingsNeedsReload = false; settingsFirstRunChecked = true
            settingsDialog.sectionLoaded(settingsTabs.currentIndex)
        } else if (request.op === "settings-diagnose") {
            settingsDiag = result; settingsDiagChanges = request.diagChanges || "{}"
        } else if (request.op === "settings-save") {
            if (result.needsReload) { settingsNeedsReload = true; settingsNotice = t("Salvo. Releia a configuração para continuar editando."); settingsData = ({}); settingsDraft = ({}); refreshLibraryAfterSettings(); return }
            settingsData = result; settingsDraft = Object.assign({}, result.values); settingsNeedsReload = false; settingsFirstRun = false
            const changed = result.changed || []
            const affectsMonitor = changed.some(function(f){ return f.startsWith("callDetection.") || f === "backend" || f.startsWith("capture.") || f === "recordingsDir" || f.startsWith("obs.") })
            const affectsTimers = changed.some(function(f){ return f === "recordingsDir" || f === "processing.syncIntervalMinutes" || f === "archive.syncIntervalMinutes" })
            settingsNotice = t("Configuração salva") + (result.backupCreated ? t(" (com cópia de segurança da anterior)") : "") + "." + (affectsMonitor ? t(" Aplique o monitor em Serviços e diagnóstico para valer nas próximas chamadas.") : "") + (affectsTimers ? t(" Reaplique os timers em Serviços e diagnóstico.") : "") + (result.cleanupPending ? t(" Uma cópia temporária privada pode ter ficado na pasta da configuração.") : "")
            runSettingsDiagnose()
            refreshLibraryAfterSettings()
        } else if (request.op === "settings-service") {
            settingsDiag = Object.assign({}, settingsDiag, { services: result.services })
            settingsNotice = ({
                "calls-apply": t("Monitor de chamadas aplicado e reiniciado com a configuração atual."),
                "calls-disable": t("Monitor de chamadas desativado. Nenhuma gravação automática será iniciada."),
                "tray-apply": t("Bandeja instalada e reiniciada."),
                "tray-disable": t("Bandeja removida."),
                "sync-apply": t("Processamento em segundo plano ativado."),
                "sync-disable": t("Processamento em segundo plano desativado. A fila foi preservada."),
                "archive-apply": t("Timer de arquivo de originais ativado."),
                "archive-disable": t("Timer de arquivo de originais desativado."),
                "backup-apply": t("Timer de backup no Proton Drive ativado."),
                "backup-disable": t("Timer de backup no Proton Drive desativado."),
                "reminders-apply": t("Lembretes de reunião aplicados e reiniciados com a configuração atual."),
                "reminders-disable": t("Lembretes de reunião desativados.")
            })[result.action] || t("Serviço atualizado.")
            runSettingsDiagnose()
        }
    }
    function hasSettingsPending(op) {
        return Object.keys(pending).some(id => pending[id].op===op && pending[id].settingsGeneration===settingsGeneration)
    }
    function loadSettings(withDiagnose) {
        if(hasSettingsPending("settings-save")||hasSettingsPending("settings-read"))return
        settingsGeneration+=1;settingsData=({});settingsDraft=({})
        if(!backend.available){settingsNeedsReload=true;settingsError=t("Serviço indisponível. Reconecte e releia a configuração antes de salvar.");return}
        settingsError="";settingsNeedsReload=false;send("settings-read","")
        if(withDiagnose)send("settings-diagnose","")
    }
    // The diagnostic follows the draft, like the assistant's: unsaved choices are checked as they would be saved.
    function runSettingsDiagnose() {
        if(!backend.available)return
        const changes=settingsChanges()
        send("settings-diagnose","",Object.keys(changes).length?{changes:changes}:({}),{diagChanges:JSON.stringify(changes)})
    }
    function runSettingsService(action) { settingsError="";settingsNotice="";send("settings-service","",{action:action}) }
    function setSettingsField(field, value) { const next=Object.assign({},settingsDraft);next[field]=value;settingsDraft=next;if(field==="studio.language")languagePreview=value }
    function settingsSame(left, right) { return JSON.stringify(left === undefined ? null : left) === JSON.stringify(right === undefined ? null : right) }
    function settingsChanges() {
        const values=settingsData.values||({}), nullable=settingsData.nullable||[], emptyAllowed=settingsData.emptyAllowed||[], changes={}
        for(const field in settingsDraft) {
            const value=settingsDraft[field]
            if(settingsSame(value, values[field]))continue
            // Cleared text is an edit only where empty text is valid (vocabulary, S3 bucket or prefix);
            // cleared optional fields become null (the key is removed); other empty fields are ignored.
            if(value===""&&emptyAllowed.indexOf(field)<0)continue
            if(value===null&&nullable.indexOf(field)<0)continue
            changes[field]=value
        }
        return changes
    }
    function settingsHasChanges() { return Object.keys(settingsChanges()).length>0 }
    function saveSettingsDraft() {
        const changes=settingsChanges()
        if(!Object.keys(changes).length)return
        settingsError="";settingsNotice="";send("settings-save","",{revision:settingsData.revision,changes:changes})
    }
    function settingsLoopback(url) { return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(String(url||"")) }
    function settingsCredentialText(source) { return source==="secrets.env"?t("salva pelo Studio"):source==="environment"?t("definida no ambiente"):source==="worker.env"?t("definida em worker.env"):source==="calls.env"?t("definida em calls.env"):source==="config"?t("definida na configuração"):source==="missing"?t("não encontrada"):"—" }
    function settingsDeviceOptions(monitor) {
        const audio=settingsDiag.audio||({}), field=monitor?"capture.desktop":"capture.microphone", current=settingsDraft[field]
        const fallback=monitor?audio.defaultDesktop:audio.defaultMicrophone
        const options=[{label:t("Padrão do sistema")+(fallback?" ("+fallback+")":""),value:"default"}]
        for(const device of (audio.devices||[])) if(device.monitor===monitor) options.push({label:device.description+" · "+device.name,value:device.name})
        if(current&&current!=="default"&&!options.some(function(o){return o.value===current})) options.push({label:current+t(" (não encontrado agora)"),value:current})
        return options
    }
    function settingsServiceStatus(name) {
        const s=settingsDiag.services?settingsDiag.services[name]:null
        if(!s)return "skipped"
        if(!s.installed)return "missing"
        return s.active&&!s.staleConfig&&!s.outdated?"ok":"warning"
    }
    function settingsServiceText(name) {
        const s=settingsDiag.services?settingsDiag.services[name]:null
        if(!s)return ""
        if(!s.installed)return t("Não instalado.")
        return (s.active?t("Ativo"):t("Parado"))+(s.enabled?t(", inicia com a sessão."):t(", não inicia com a sessão."))+(s.staleConfig?t(" Ainda usa a configuração anterior: aplique para valer."):"")+(s.outdated?t(" A pasta das gravações mudou: aplique de novo."):"")
    }
    // A committed save or restore can move the recordings folder: the library list is read again.
    // A list sent before the change may describe the previous folder: a newer epoch makes its answer stale.
    function refreshLibraryAfterSettings() { if (!backend.available) return; libraryEpoch += 1; libraryRefreshing = true; send("list", "") }
    function settingsConnectionLost() {
        setupWizard.connectionLost()
        if(!settingsDialog.visible)return
        const saving=hasSettingsPending("settings-save")||hasSettingsPending("settings-service")
        settingsGeneration+=1;settingsNeedsReload=true
        settingsError=saving?t("Conexão perdida durante a operação; o resultado não foi confirmado. Reconecte e releia antes de tentar de novo."):t("Serviço desconectado. Reconecte e releia a configuração antes de salvar.")
    }

    OnboardingDialog { id: onboardingDialog }
    property alias localChoice: onboardingDialog.localChoice
    property alias onboardingScroll: onboardingDialog.onboardingScroll

    function hasOnboardingPending(op) {
        return Object.keys(pending).some(id => pending[id].op===op && pending[id].onboardingGeneration===onboardingGeneration)
    }
    function loadOnboarding() {
        if(hasOnboardingPending("onboarding-save-local")||hasOnboardingPending("onboarding-read"))return
        onboardingGeneration+=1;onboardingDraft=({});localChoice.checked=false
        if(!backend.available){invalidateOnboarding(t("Serviço indisponível. Reconecte e releia a configuração antes de salvar."));return}
        onboardingError="";onboardingNeedsReload=false;send("onboarding-read","")
    }
    function invalidateOnboarding(message) {
        onboardingGeneration+=1;onboardingDraft=({});localChoice.checked=false;onboardingNeedsReload=true;onboardingError=message
    }
    function onboardingConnectionLost() {
        if(!onboardingDialog.visible)return
        onboardingSaveUncertain=onboardingSaveUncertain||hasOnboardingPending("onboarding-save-local")
        invalidateOnboarding(onboardingSaveUncertain?t("Conexão perdida durante o salvamento; o resultado ainda não foi confirmado. Reconecte e releia a configuração antes de tentar novamente."):t("Serviço desconectado. Reconecte e releia a configuração antes de salvar."))
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
    onClosing:event=>{if(revisionPending()||hasPending("export-save")){event.accepted=false;notice=t("Aguarde a confirmação da operação local antes de fechar.")}}

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
    function origin(value) { return ({local: t("Neste computador"), vaio: t("Worker remoto"), proton: "Proton Drive", missing: t("Mídia indisponível"), "transcript-only": t("Mídia indisponível"), "audio-only": t("Neste computador")})[value] || "" }
    function statusText(value) { return ({completed: t("Processada"), archived: t("Backup concluído"), failed: t("Processamento falhou"), queued: t("Na fila"), processing: t("Processando"), "archive-pending": t("Backup pendente"), unprocessed: t("Sem processamento")})[value] || value }
    function speakerLabel(segment) { return segment.speaker || t("Falante incerto") }
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
        if (!configured) return t("Áudio ainda não validado")
        if (configured.audioSource === "none") return t("Áudio desativado na configuração")
        const selected = captureStatus.audio.selected || {}
        const mic = selected.microphone || configured.microphone || t("Padrão do sistema")
        const desktop = selected.desktop || configured.desktop || t("Padrão do sistema")
        return t("Mic: ") + mic + t(" · Desktop: ") + desktop
    }
    function diarizationKey() { return detail.diarizationId || detail.jobId || "" }
    function hasPending(op) { return Object.keys(pending).some(id => pending[id].op === op) }
    function revisionPending() { return hasPending("revision-save") || hasPending("revision-undo") }
    function suggestionsFor(speakerId) { return (speakerSuggestions.items || []).filter(function(item){return item.speakerId===speakerId}) }
    function suggestionName(item) { return item.name || (item.self ? t("Você") : "") }
    function suggestionDetail(item) {
        if (item.source === "microphone") return tf("microfone · %1% da fala", Math.round(Number(item.localShare || 0) * 100))
        if (item.source === "voice") return tf("voz · %1% de semelhança", Math.round(Number(item.score || 0) * 100))
        const quote = item.evidence && item.evidence.length ? item.evidence[0].quote : ""
        return t("conversa") + (quote ? " · “" + quote + "”" : "")
    }
    function speakerUnnamed(row) { return !row.label || /^Falante \d+$/.test(row.label) }
    // One distinct name per speaker still without a name; disagreeing sources stay for the person to decide.
    function applicableSuggestions() {
        const operations = []
        for (const row of speakerRows) {
            if (!speakerUnnamed(row)) continue
            const names = suggestionsFor(row.speakerId).map(suggestionName).filter(function(name){return !!name})
            const distinct = names.filter(function(name, index){return names.findIndex(function(other){return other.toLowerCase() === name.toLowerCase()}) === index})
            if (distinct.length === 1) operations.push({kind: "speaker-label", speakerId: row.speakerId, label: distinct[0]})
        }
        return operations
    }
    function applySpeakerSuggestions() {
        const operations = applicableSuggestions()
        if (!operations.length || !detail.review || revisionPending() || !backend.available) return
        reviewGeneration+=1; clearDerivedView(); reviewError=""
        send("revision-save",diarizationKey(),{expectedRevision:detail.review.revision.revision,base:detail.review.revision.base,operations:operations})
    }
    function requestSpeakerSuggestions(conversation) {
        const id = diarizationKey()
        if (!backend.available || !id || speakersQueued) return
        const destination = speakerSuggestions.destination || ({})
        const payload = conversation ? {conversation: true, consent: true, consentKey: destination.consentKey || ""} : {conversation: false}
        if (send("speakers-suggest", id, payload) >= 0) speakersQueued = true
    }
    function speakerConversationText() {
        const destination = speakerSuggestions.destination || ({})
        if (!destination.model) return t("Também procurar nomes citados na conversa (modelo de resumo indisponível)")
        if (destination.provider === "openai") return tf("Também procurar nomes citados na conversa, enviando as falas para a OpenAI · %1 (provedor externo)", destination.model)
        return destination.external ? tf("Também procurar nomes citados na conversa, enviando as falas para o Ollama em %1 · %2 (fora deste computador)", destination.endpoint, destination.model)
            : tf("Também procurar nomes citados na conversa com o Ollama local · %1", destination.model)
    }
    function speakerSuggestionStatus() {
        const state = speakerSuggestions
        if (!state || state.state === "unavailable") return ""
        if (state.state === "idle") return state.voice && state.voice.message ? t("Voz: ") + t(state.voice.message) : ""
        const parts = [t(state.message || "")]
        if (state.microphone && state.microphone.message) parts.push(t("Microfone: ") + t(state.microphone.message))
        if (state.conversation && state.conversation.message) parts.push(t("Conversa: ") + t(state.conversation.message))
        if (state.voice && state.voice.message) parts.push(t("Voz: ") + t(state.voice.message))
        if (state.conversation && state.conversation.participants) parts.push(tf("Conversa: com %1 nome(s) da Agenda do Google.", state.conversation.participants))
        if (state.conversation && state.conversation.partial) parts.push(tf("Conversa: só %1 de %2 falas couberam no envio.", state.conversation.sentTurns, state.conversation.totalTurns))
        return parts.filter(function(part){return !!part}).join(" ")
    }
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
        if(reviewDialog.visible || revisionPending()) { reviewNeedsReload=true; reviewError=t("Conexão perdida; o salvamento pode ter ocorrido. Releia antes de tentar novamente.") }
        if(exportDialog.visible) { exportError=t("Conexão perdida; confira a exportação após reconectar antes de salvar novamente."); exportResult=({}) }
        reviewGeneration+=1; exportGeneration+=1; clearDerivedView()
    }
    function previewExport() {
        exportGeneration+=1; exportResult=({}); exportError=""
        if(backend.available && detail.review)send("export-preview",diarizationKey(),{format:exportFormat.currentValue,track:exportTrack.currentValue})
    }
    function activeSpeakerLabels(seconds) {
        const turns = (detail.diarization && detail.diarization.turns) || []
        const labels = turns.filter(turn => Number(turn.start) <= seconds && seconds < Number(turn.end)).map(turn => turn.label || turn.speaker || t("Falante incerto"))
        return labels.filter((label, index) => labels.indexOf(label) === index).join(" + ")
    }
    // `meta` adds non-sensitive routing facts to the pending entry; payloads are never stored.
    function send(op, key, payload, meta) {
        if (["agent-authorize","provider-authorize","agent-frames","provider-analyze"].includes(op)) agentError=""
        const id = backend.request(op, key || "", payload || ({}))
        if (id < 0) { if(isFamilyOp(op))return -1; if(op.startsWith("summary-"))summaryConnectionLost();if(op.startsWith("revision-")){reviewNeedsReload=true;reviewError=t("Pedido sem confirmação; reconecte e releia antes de tentar novamente.")}if(op.startsWith("export-")){exportError=t("Pedido sem confirmação; atualize a prévia após reconectar.");exportResult=({})}if(op.startsWith("agent-")||op.startsWith("provider-"))agentError=t("Serviço indisponível; dados preservados. Feche e reconecte para continuar."); if(op.startsWith("frames-"))uxError=t("Serviço indisponível; dados preservados. Reabra após reconectar.");if(op.startsWith("onboarding-"))invalidateOnboarding(t("O serviço não recebeu este pedido. Reconecte e releia a configuração antes de salvar."));if(op.startsWith("settings-")&&settingsDialog.visible){settingsNeedsReload=true;settingsError=t("O serviço não recebeu este pedido. Reconecte e releia a configuração.");return -1} errorText = t("O serviço da biblioteca está indisponível. Reabra esta janela."); return -1 }
        const next = Object.assign({}, pending)
        next[id] = Object.assign({op: op, key: key, generation: generation, frameGeneration: frameGeneration, onboardingGeneration: onboardingGeneration, settingsGeneration: settingsGeneration, agentGeneration:agentGeneration, reviewGeneration:reviewGeneration,exportGeneration:exportGeneration,summaryGeneration:summaryGeneration,libraryEpoch:libraryEpoch}, meta || ({}))
        pending = next
        return id
    }
    function backToLibrary() {
        if(revisionPending() || hasPending("export-save"))return
        leaveRecording()
        view = "home"
        search.forceActiveFocus(Qt.TabFocusReason)
    }
    // Closes the open meeting (dialogs, player, per-recording state); backToLibrary and navigate share it.
    function leaveRecording() {
        summaryDialog.close(); reviewDialog.close(); exportDialog.close(); processDialog.close(); speakerSuggestDialog.close(); reviewGeneration+=1; exportGeneration+=1
        closeAgentAccess(); framesDialog.close(); cancelFramePreview()
        generation += 1; sourceReferenceSeconds = -1; pendingSeek = -1; selected = ({}); detail = {transcript: {segments: [], text: "", timing: "none"}, diarization: {state: "idle"}}
        detailLoading = false; resolving = false; contextLoading = false; contextText = ""; contextCopyText = ""; contextPath = ""; contextCitations = []
        mediaReady = false; pendingPath = ""; position = 0; duration = 0; location = ""; playbackOperation = ""; operationPolling = false; errorText = ""; notice = ""
        if (playerInitialized) video.commandAsync(["stop"])
    }
    // Sidebar navigation (Início, Ações, Pessoas, Clientes) and the live view. Refuses, like backToLibrary,
    // while a local save is unconfirmed.
    function navigate(name) {
        if (!viewAvailable(name) || revisionPending() || hasPending("export-save")) return false
        if (selected.key) leaveRecording()
        view = name
        return true
    }
    // New op families (DESIGN-STUDIO §2.3): each reply goes to the component that asked (meta.origin),
    // and failures stay in that component's own state, never in errorText or notice.
    readonly property var familyPrefixes: ["notes-", "live-", "templates-", "assistant-", "recipes-", "share-", "actions-", "action-", "people-", "person-", "clients-", "client-", "meeting-client-", "meeting-override", "home-", "inbox-", "first-run-", "media-", "library-search", "summary-prefs-"]
    function isFamilyOp(op) { return familyPrefixes.some(function(prefix){ return op.indexOf(prefix) === 0 }) }
    function familyOwner(origin) {
        return ({})[origin] || null
    }
    function routeFamilyResponse(request, message) {
        const owner = familyOwner(request.origin || "")
        if (owner && typeof owner.handleResponse === "function") owner.handleResponse(request, message)
    }
    // The bridge went away: pending family requests are gone; each owner resets what it was waiting for.
    function familiesConnectionLost() {
    }
    function selectRecording(item) { showVisualSummary=false;
        if(revisionPending() || hasPending("export-save"))return
        summaryDialog.close(); reviewDialog.close(); exportDialog.close(); processDialog.close(); speakerSuggestDialog.close(); reviewGeneration+=1; exportGeneration+=1
        closeAgentAccess(); framesDialog.close(); cancelFramePreview()
        generation += 1; sourceReferenceSeconds = -1; pendingSeek = -1
        selected = item
        detail = {transcript: {segments: [], text: "", timing: "none"}, diarization: {state: "idle"}}
        detailLoading = true; errorText = ""; notice = ""; subtitleQueued = false
        mediaReady = false; pendingPath = ""; position = 0; duration = 0; location = ""
        resolving = false; playbackOperation = ""; operationPolling = false; initialTranscriptTiming = ""; diarizationQueued = false; speakersQueued = false
        contextText = ""; contextCopyText = ""; contextPath = ""; contextCitations = []; contextLoading = false
        if (playerInitialized) video.commandAsync(["stop"])
        send("detail", item.key)
        // Explicit open keeps remote retrieval under the user's control.
        if (item.location === "local" || smokeKey) openRecording()
    }
    function openRecording() {
        if (!backend.available || !selected.key || resolving) return
        resolving = true; errorText = ""; notice = t("Verificando e recuperando a mídia…")
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
    // Whether the open meeting can play at all (media removed or missing means transcript only).
    function mediaPlayable() { return !!selected.key && !mediaGone(selected) && !(detail.media && detail.media.features && detail.media.features.playback === false) }
    // A cited moment: seek when the media plays, open it and seek once it is ready, or show the
    // transcript at that segment when there is no audio or the person asked for the transcript.
    function openCitation(segmentId, seconds, toTranscript) {
        if (toTranscript || !mediaPlayable()) { detailView.focusSegment(segmentId, seconds); return }
        if (mediaReady) seek(seconds)
        else { pendingSeek = seconds; openRecording() }
    }
    function requestMeetingContext() {
        const id = diarizationKey()
        if (!backend.available || !id || contextLoading || revisionPending()) return
        contextLoading = true; contextText = ""; contextCopyText = ""; tabs.currentIndex = 3
        if (send("context-meeting", id, {maxCharacters: 10000}) < 0) contextLoading = false
    }
    Shortcut { sequence: "Space"; enabled: mediaReady && !textHasFocus && !uxModal && !captionToggle.activeFocus && !captionHasFocus(); onActivated: togglePlay() }
    Shortcut { sequence: "Right"; enabled: mediaReady && !textHasFocus && !uxModal && !captionHasFocus(); onActivated: seek(position + 5) }
    Shortcut { sequence: "Left"; enabled: mediaReady && !textHasFocus && !uxModal && !captionHasFocus(); onActivated: seek(position - 5) }
    SummaryDialog { id: summaryDialog }
    property alias summaryBudget: summaryDialog.summaryBudget
    property alias summaryConsent: summaryDialog.summaryConsent
    ReviewDialog { id: reviewDialog }
    property alias revisionSpeaker: reviewDialog.revisionSpeaker
    property alias revisionText: reviewDialog.revisionText
    ExportDialog { id: exportDialog }
    property alias exportFormat: exportDialog.exportFormat
    property alias exportTrack: exportDialog.exportTrack
    AboutDialog { id: aboutDialog }
    CaptureConsentDialog { id: captureConsent }
    ProcessRecordingDialog { id: processDialog }
    SpeakerSuggestDialog { id: speakerSuggestDialog }
    // The meeting page lives in MeetingView.qml; these keep the ids the controller, the dialogs and the journeys use.
    property alias tabs: detailView.tabs
    property alias video: detailView.video
    property alias videoFrame: detailView.videoFrame
    property alias captionOverlay: detailView.captionOverlay
    property alias captionViewport: detailView.captionViewport
    property alias caption: detailView.caption
    property alias captionToggle: detailView.captionToggle
    property alias timeline: detailView.timeline
    property alias revisionSegmentsList: detailView.revisionSegmentsList
    property alias revisionSpeakersList: detailView.revisionSpeakersList
    property alias revisionTurnsList: detailView.revisionTurnsList
    property alias contextExcerpts: detailView.contextExcerpts
    property alias contextArea: detailView.contextArea
    property alias compactContext: detailView.compactContext
    property alias processButton: detailView.processButton
    property alias agentAccessButton: detailView.agentAccessButton
    property alias visualSummaryButton: detailView.visualSummaryButton
    property alias summaryRegenerateButton: detailView.summaryRegenerateButton
    property alias exportButton: detailView.exportButton
    property alias openRecordingButton: detailView.openRecordingButton
    property alias reviewNoteButton: detailView.reviewNoteButton
    property alias speakerSuggestButton: detailView.speakerSuggestButton
    Shortcut { sequence: "Escape"; enabled: !!selected.key && !uxModal; onActivated: backToLibrary() }
    Timer { interval: processingWait || summaryRunning || hasPending("frames-preview") || hasPending("frames-confirm") ? 500 : 2000; running: backend.available; repeat: true; onTriggered: { if (!hasPending("processing-status")) send("processing-status", "") } }
    Label { z: 100; anchors.bottom: parent.bottom; anchors.bottomMargin: 48; anchors.horizontalCenter: parent.horizontalCenter; width: Math.min(parent.width - 32, implicitWidth); visible: !!processingWait; text: t(processingWait); textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: warningColor; padding: 10; leftPadding: 14; rightPadding: 14; background: Rectangle { color: surface; radius: 10; border.width: 1; border.color: warningColor } }
    // Actionable notices ("Desfazer", "Abrir") from the new features; errorText and notice stay in the status bar.
    FtToast { id: toast; anchors.bottom: parent.bottom; anchors.bottomMargin: 44; anchors.horizontalCenter: parent.horizontalCenter }
    Timer { interval: 1000; running: captureStatus.active; repeat: true; onTriggered: statusNow = Date.now() }
    Timer { interval: 1000; running: summaryPolling && backend.available; repeat: true; onTriggered: { if (!hasPending("summary-status")) send("summary-status", summaryJobId, { requestId: summaryRequestId }) } }
    Component.onCompleted: if (backend.available) { send("list-cached", ""); send("list", ""); send("capture-status", ""); send("jobs-list", ""); send("ux-capabilities", ""); send("settings-read", "") }
    Connections {
        target: backend
        function onFailed(message) { summaryConnectionLost();revisionConnectionLost();onboardingConnectionLost();settingsConnectionLost();familiesConnectionLost();if(agentDialog.visible)agentError=message; captureKnown = false; pending = {}; errorText = message; loading = false; resolving = false; detailLoading = false; operationPolling = false; captureBusy = false; contextLoading = false }
        function onAvailabilityChanged() {
            if (!backend.available) { summaryConnectionLost();revisionConnectionLost();onboardingConnectionLost();settingsConnectionLost();familiesConnectionLost();if(agentDialog.visible)agentError=t("Serviço desconectado; dados preservados. Feche e reconecte para continuar."); captureKnown = false; pending = {}; loading = false; resolving = false; detailLoading = false; operationPolling = false; captureBusy = false; contextLoading = false; notice = t("Serviço desconectado. Use Reconectar para continuar.") }
            else { errorText = ""; notice = t("Serviço conectado."); setupWizard.reconnected(); if (!libraryFresh) send("list-cached", ""); send("capture-status", ""); send("jobs-list", ""); send("list", ""); send("ux-capabilities", ""); if (!settingsFirstRunChecked && !hasSettingsPending("settings-read")) send("settings-read", "") }
        }
        function onResponse(message) {
            const request = pending[message.id]
            if (!request) return
            const next = Object.assign({}, pending)
            delete next[message.id]
            pending = next
            if (["detail", "resolve", "playback-status", "context-meeting", "diarization-name", "subtitles", "diarization", "speakers-suggest","revision-save","revision-undo","export-preview","export-save"].includes(request.op) && request.generation !== generation) return
            if (["detail","context-meeting","revision-save","revision-undo"].includes(request.op) && request.reviewGeneration !== reviewGeneration) return
            if(request.op.startsWith("export-") && request.exportGeneration!==exportGeneration)return
            if (request.op === "playback-status") operationPolling = false
            if (request.op === "list" && request.libraryEpoch !== libraryEpoch) return
            if (request.op === "list") { loading = false; libraryRefreshing = false }
            if (request.op === "detail") detailLoading = false
            if (request.op.startsWith("frames-") && request.op !== "frames-cancel" && (request.generation !== generation || request.frameGeneration !== frameGeneration)) return
            if((request.op.startsWith("agent-")||request.op.startsWith("provider-")) && (request.generation !== generation || request.agentGeneration !== agentGeneration)) return
            if (request.op.startsWith("summary-") && request.op!=="summary-cancel" && (request.generation!==generation || request.summaryGeneration!==summaryGeneration))return
            if (request.op.startsWith("onboarding-") && request.onboardingGeneration !== onboardingGeneration) return
            if (isFamilyOp(request.op)) { routeFamilyResponse(request, message); return }
            if (request.op.startsWith("settings-")) { handleSettingsResponse(request, message); return }
            if (request.op.startsWith("recording-process")) { processDialog.handleResponse(request, message); return }
            if (!message.ok && (request.op.startsWith("agent-")||request.op.startsWith("provider-"))) { agentError=message.error; return }
            if (!message.ok && request.op === "processing-status") { processingWait = t("Estado do processamento indisponível; nenhuma alteração na captura."); return }
            if (!message.ok && request.op.startsWith("onboarding-")) { if(request.op==="onboarding-save-local")onboardingSaveUncertain=true;invalidateOnboarding(message.error+t(" Releia a configuração e confirme sua escolha antes de salvar novamente."));return }
            if (!message.ok && request.op.startsWith("summary-") && request.op!=="summary-cancel") {summaryRunning=false;summaryPolling=false;summaryNeedsReload=true;summaryConsent.checked=false;summaryPlan=({});summaryError=message.error;return}
            if (request.op==="summary-cancel")return
            if (!message.ok && request.op.startsWith("frames-")) { uxError = message.error; return }
            if (!message.ok && request.op.startsWith("revision-")) { reviewNeedsReload=true;reviewError=message.error+t(" Releia os dados antes de tentar novamente.");errorText=reviewError;detailLoading=true;send("detail",selected.key);return }
            if (!message.ok && request.op.startsWith("export-")) { exportError=message.error;exportResult=({});return }
            if (!message.ok) { errorText = message.error; notice = ""; captureBusy = false; contextLoading = false; if (request.op === "subtitles") subtitleQueued = false; if (request.op === "diarization") diarizationQueued = false; if (request.op === "speakers-suggest") speakersQueued = false; if (request.op === "resolve" || request.op === "playback-status") { resolving = false; playbackOperation = "" } return }
            const result = message.result
            if(request.op === "summary-plan") {summaryPlan=result;summaryConsent.checked=false;summaryError=""
            } else if((request.op === "summary-run" && result.status !== "running") || (request.op === "summary-status" && result.status === "completed")) {summaryRunning=false;summaryPolling=false;summaryCompleted=true;notice=t("Resumo novo ligado à revisão; confira a fonte. Original preservado.");summaryDialog.close();clearDerivedView();detailLoading=true;send("detail",selected.key)
            } else if(request.op === "summary-run") {summaryPolling=true
            } else if(request.op === "summary-status") {if(result.status !== "running"){summaryRunning=false;summaryPolling=false;summaryNeedsReload=true;summaryConsent.checked=false;summaryPlan=({});summaryError=result.error||""}
            } else if(request.op === "provider-authorize") {providerConsent.checked=false;showAgentSetup=false;preferredGrantId=result.id;changeAgentGrant()
            } else if(request.op === "provider-analyze") {providerPendingGrant="";providerResult=result;send("agent-status",selected.key)
            } else if(request.op === "provider-cancel") {agentError=t("Pedido de análise cancelado; resultado/custo podem ser incertos se já enviado.")
            } else if(request.op === "agent-status") { const prior=preferredGrantId||activeGrant.id;preferredGrantId="";agentState=result;const index=visibleGrants.findIndex(function(g){return g.id===prior});grantPicker.currentIndex=index>=0?index:0;if(!agentLoaded){showAgentSetup=!visibleGrants.length;agentLoaded=true}
            } else if(request.op === "agent-connect") { agentDialog.connection = result
            } else if(request.op === "agent-frames") { frameGrantPending="";agentResult=result; send("agent-status",selected.key)
            } else if(["agent-authorize","agent-pause","agent-resume","agent-revoke"].includes(request.op)) { if(request.op==="agent-authorize"){showAgentSetup=false;preferredGrantId=result.id;changeAgentGrant()}else send("agent-status",selected.key);agentConsent.checked=false; agentResult=({});
            } else if(request.op === "agent-cancel") { agentError=t("Consulta cancelada; autorização preservada.")
            } else if (request.op === "ux-capabilities") { cliVersion = result.productVersion || ""; releaseInfo = result.release || ({}); mockFramesEnabled = !!result.mockFrames; realFramesEnabled = !!result.realFrames
                features = result.features && typeof result.features === "object" ? result.features : ({}); firstRun = result.firstRun && typeof result.firstRun === "object" ? result.firstRun : ({})
            } else if (request.op === "processing-status") { processingWait = result.waiting.length ? result.waiting[0].message : ""
            } else if (request.op === "frames-cancel") { send("processing-status", "")
            } else if (request.op === "frames-check-models") { frameCapability = result
            } else if (request.op === "frames-scope") { frameScope = result
            } else if (request.op === "frames-plan") { framePlan = result
            } else if (request.op === "frames-preview" || request.op === "frames-preview-plan") { framePreview = result
            } else if (request.op === "frames-confirm") { frameResult = result; showVisualSummary=false; if (!result.synthetic && result.summaryMarkdown) { const updated=Object.assign({},detail); updated.visualReview=result; detail=updated }
            } else if (request.op === "onboarding-read") { onboardingDraft = result;onboardingError="";onboardingNeedsReload=false;onboardingSaveUncertain=false
            } else if (request.op === "onboarding-save-local") { if(settingsDialog.visible)loadSettings(false); notice = result.cleanupPending?t("Escolha local salva; uma cópia temporária privada pode permanecer na pasta da configuração. Nenhum serviço iniciado."):t("Escolha local salva; nenhum serviço iniciado."); onboardingDialog.close()
            } else if (request.op === "list-cached") {
                if (!libraryFresh && Array.isArray(result.items)) { items = result.items; loading = false; libraryRefreshing = hasPending("list") }
            } else if (request.op === "list") {
                libraryFresh = true
                items = result.items
                if (selected.key) { const current = items.find(item => item.key === selected.key); if (current) { selected = current; detailLoading = true; send("detail", selected.key) } else backToLibrary() }
                if (!selected.key && smokeKey) {
                    const target = items.find(item => item.key === smokeKey)
                    if (target) selectRecording(target); else errorText = t("Gravação de verificação ausente.")
                }
            } else if (request.op === "automation-pause" || request.op === "automation-resume" || request.op === "capture-status" || request.op === "capture-start" || request.op === "capture-stop" || request.op === "capture-recover" || request.op === "audio-defaults") {
                captureStatus = result
                captureKnown = true
                if (request.op !== "capture-status" || !["capture-start", "capture-stop", "capture-recover", "audio-defaults", "automation-pause", "automation-resume"].some(op => hasPending(op))) captureBusy = false
                if (request.op !== "capture-status") notice = request.op === "automation-pause" ? t("Novas gravações automáticas pausadas. A captura atual continua até Parar.") : request.op === "automation-resume" ? t("Automação retomada para futuras chamadas; confira suas regras.") : request.op === "capture-start" ? t("Captura iniciada.") : request.op === "capture-stop" ? (result.stopWarning ? t("Captura parada, com aviso: ") + t(result.stopWarning) : t("Captura finalizada e enfileirada.")) : request.op === "capture-recover" ? t("Recuperação solicitada.") : t("Áudio padrão atualizado.")
            } else if (request.op === "jobs-list") {
                jobs = result.items || []
                if (selectedJob.id) selectedJob = jobs.find(job => job.id === selectedJob.id) || ({})
            } else if (request.op === "job-process" || request.op === "job-retry") {
                notice = result.warning || (result.status === "completed" ? t("Este job já está concluído.") : result.status === "active" ? t("Este job já está em processamento.") : t("Job enviado para processamento."))
                send("jobs-list", "")
            } else if(request.op === "revision-save" || request.op === "revision-undo") {
                notice=request.op==="revision-undo"?t("Revisão anterior restaurada por uma nova revisão; original preservado."):t("Revisão humana salva; derivados antigos precisam de revisão.")
                reviewDialog.close();clearDerivedView();detailLoading=true;send("detail",selected.key)
            } else if(request.op === "export-preview") {
                exportResult=result;exportError=""
            } else if(request.op === "export-save") {
                exportResult=Object.assign({},exportResult,result);exportError="";notice=t("Exportação privada salva neste computador.")
            } else if (request.op === "diarization-name") {
                notice = t("Nome do falante salvo nesta gravação.")
                detailLoading = true; send("detail", selected.key)
            } else if (request.op === "context-meeting") {
                contextLoading = false
                contextCopyText = JSON.stringify(result)
                contextText = result.context || result.text || JSON.stringify(result, null, 2)
                contextPath = result.path || result.sourcePath || ""
                contextCitations = result.citations || []
            } else if (request.op === "detail") {
                if(summaryDialog.visible && summaryPlan.requestId && (!result.review || summaryPlan.revision!==result.review.revision.revision)) {abandonSummary();summaryNeedsReload=true;summaryError=t("A revisão mudou. Releia e prepare um novo plano; o original foi preservado.")}
                if (!initialTranscriptTiming) initialTranscriptTiming = result.transcript.timing
                selected = Object.assign({}, selected, {
                    status: result.status, backup: result.backup,
                    title: typeof result.title === "string" ? result.title : selected.title,
                    hasMeetingTitle: typeof result.hasMeetingTitle === "boolean" ? result.hasMeetingTitle : selected.hasMeetingTitle,
                    artifactStatus: typeof result.artifactStatus === "string" ? result.artifactStatus : selected.artifactStatus
                })
                if (JSON.stringify(detail) !== JSON.stringify(result)) detail = result
                if (diarizationQueued && result.diarization.state === "review") notice = t("Falantes identificados. Abra a aba Falantes para revisar.")
                else if (diarizationQueued && result.diarization.state === "failed") { notice = ""; errorText = result.diarization.message || t("A identificação não foi concluída.") }
                diarizationQueued = result.diarization.state === "running"
                const suggestionState = result.speakerSuggestions ? result.speakerSuggestions.state : ""
                if (speakersQueued && suggestionState === "ready") notice = t("Sugestões de nomes prontas. Confira na aba Falantes antes de aplicar.")
                else if (speakersQueued && suggestionState === "failed") { notice = ""; errorText = t(result.speakerSuggestions.message || "") || t("A busca de nomes não foi concluída.") }
                speakersQueued = suggestionState === "running"
                if (smokeDiarization && (result.diarization.turns || []).length > 0) tabs.currentIndex = 2
                if (subtitleQueued && result.subtitleState === "ready") { subtitleQueued = false; notice = t("Legendas prontas.") }
                else if (result.subtitleState === "running") subtitleQueued = true
                else if (subtitleQueued && ["idle", "failed", "unknown"].includes(result.subtitleState)) { subtitleQueued = false; notice = ""; errorText = result.subtitleMessage || t("Não há legendas alinhadas verificadas. O estado da solicitação está indisponível; a transcrição original foi preservada.") }
            } else if (request.op === "resolve" || request.op === "playback-status") {
                if (result.state === "running") { playbackOperation = result.operationId; return }
                resolving = false; playbackOperation = ""
                if (result.state === "failed") { errorText = result.message; notice = ""; return }
                location = result.location; pendingPath = result.path; notice = ""; loadMedia()
            } else if (request.op === "subtitles") {
                subtitleQueued = true; notice = t("Legendas solicitadas ao worker configurado. Esta janela atualizará quando estiverem prontas.")
            } else if (request.op === "diarization") {
                diarizationQueued = true
                detail = Object.assign({}, detail, {diarization: {state: "running", message: t("Identificação automática em preparação…")}, diarizationId: result.id})
                notice = t("Identificação de falantes em preparação.")
            } else if (request.op === "speakers-suggest") {
                speakersQueued = true
                detail = Object.assign({}, detail, {speakerSuggestions: Object.assign({}, speakerSuggestions, {state: "running", message: "Procurando nomes em segundo plano"})})
                notice = t("Sugestões de nomes em preparação. Nada é aplicado sem você.")
            }
        }
    }
    Timer {
        interval: 5000; repeat: true; running: backend.available && !!selected.key && (subtitleQueued || diarizationQueued || speakersQueued || ["pending", "transferring", "queued", "processing"].includes(selected.status) || !!smokeKey)
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
                    Label { visible: !compactLayout; text: Qt.application.version + t(" · experimental"); color: muted; font.pixelSize: 11 }
                }
                Item { Layout.fillWidth: true }
                FtChip { visible: !backend.available; kind: "danger"; iconName: "plug"; text: t("Serviço desconectado") }
                FtButton { text: t("Reconectar"); visible: !backend.available; enabled: !backend.available; compact: true; onClicked: backend.reconnect() }
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
                                text: !captureKnown ? t("Captura: estado desconhecido") : captureStatus.active ? t("REC ") + clock(Math.max(0, (statusNow - Date.parse(captureStatus.session && captureStatus.session.startedAt || new Date(statusNow).toISOString())) / 1000)) : t("Captura parada")
                                color: captureStatus.active ? recordingColor : ink
                                font.pixelSize: 13
                                font.weight: Font.DemiBold
                            }
                            Label {
                                visible: captureKnown && !compactLayout
                                text: captureNeedsAttention() ? t("Verifique a captura") : captureStatus.paused ? t("Automação pausada") : audioLabel()
                                color: captureNeedsAttention() || !(captureStatus.audio && captureStatus.audio.configured) ? warningColor : muted
                                font.pixelSize: 11
                                HoverHandler { id: captureHover }
                                ToolTip.visible: captureHover.hovered
                                ToolTip.text: t(captureStatus.warning || (captureStatus.audio && captureStatus.audio.error) || "") || audioSummary()
                            }
                        }
                        FtButton { id:headerStop; objectName:"headerStop"; Keys.onReturnPressed:clicked(); Keys.onEnterPressed:clicked(); visible:captureStatus.active; variant:"danger"; compact:true; iconName:"stop"; text:t("Parar captura"); enabled:backend.available&&captureKnown&&!captureBusy; onClicked:{captureBusy=true;if(send("capture-stop","")<0)captureBusy=false} }
                        FtButton { id:captureStartButton; objectName:"captureStartButton"; visible:!captureStatus.active; compact:true; iconName:"record"; iconTint:recordingColor; text:t("Gravar…"); Accessible.name:t("Iniciar uma gravação manual após confirmação"); enabled:backend.available&&captureKnown&&!captureBusy&&!captureStatus.active; onClicked:{captureConsent.intent="capture";captureConsent.open()} }
                    }
                }
                FtButton {
                    id: automationButton
                    objectName: "automationButton"
                    visible: backend.available
                    compact: true
                    variant: "ghost"
                    iconName: captureStatus.paused ? "automation-play" : "automation-pause"
                    text: captureStatus.paused ? t("Retomar automação…") : t("Pausar novas gravações")
                    Accessible.name: captureStatus.paused ? t("Retomar gravações automáticas") : t("Pausar novas gravações automáticas; a captura atual continua")
                    enabled: backend.available && !captureBusy
                    onClicked: { if (captureStatus.paused) { captureConsent.intent = "resume"; captureConsent.open() } else { captureBusy = true; if (send("automation-pause", "") < 0) captureBusy = false } }
                }
                FtButton { iconOnly: true; variant: "ghost"; iconName: "refresh"; text: t("Atualizar biblioteca"); Accessible.name: t("Atualizar biblioteca"); enabled: backend.available && !loading && !libraryRefreshing; onClicked: { loading = true; send("list", "") } }
                FtButton { iconOnly: true; variant: "ghost"; iconName: lightTheme ? "moon" : "sun"; text: lightTheme ? t("Tema escuro") : t("Tema claro"); Accessible.name: text; onClicked: lightTheme = !lightTheme }
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
                        Label { text: t("Biblioteca"); color: ink; font.pixelSize: 15; font.weight: Font.DemiBold; Layout.fillWidth: true }
                        FtChip { visible: !loading; text: (items.length === 1 ? t("1 gravação") : items.length + t(" gravações")) + (libraryRefreshing ? t(" · atualizando…") : "") }
                    }
                    FtTextField { id: search; Layout.fillWidth: true; leadingIcon: "search"; placeholderText: t("Buscar gravação…"); Accessible.name: t("Buscar gravação") }
                    BusyIndicator { Layout.alignment: Qt.AlignHCenter; running: loading && backend.available; visible: running }
                    Label { visible: !loading && !filtered.length; text: items.length ? t("Nenhuma gravação corresponde à busca.") : t("Nenhuma gravação encontrada."); color: muted; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 13 }
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
                        Accessible.name: t("Gravações da biblioteca")
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
                            Accessible.name: recordingTitle(modelData) + ", " + origin(modelData.location) + ", " + statusText(modelData.status)
                            background: Rectangle {
                                radius: 10
                                color: libraryItem.current ? selectedSurface : libraryItem.hovered ? hoverSurface : "transparent"
                                border.width: libraryItem.visualFocus || (libraryItem.ListView.isCurrentItem && libraryView.activeFocus) ? 2 : 0
                                border.color: accent
                                Rectangle { visible: libraryItem.current; width: 3; radius: 1.5; color: accent; anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom; anchors.topMargin: 10; anchors.bottomMargin: 10 }
                            }
                            contentItem: ColumnLayout {
                                spacing: 4
                                Label { text: recordingTitle(modelData); textFormat: Text.PlainText; color: ink; font.pixelSize: 14; font.weight: libraryItem.current ? Font.DemiBold : Font.Medium; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight; Layout.fillWidth: true }
                                Label { text: shortDate(modelData.modifiedAt) + " · " + origin(modelData.location); textFormat: Text.PlainText; color: modelData.location === "missing" ? warningColor : muted; font.pixelSize: 12; elide: Text.ElideRight; Layout.fillWidth: true }
                                RowLayout {
                                    spacing: 6
                                    Rectangle { implicitWidth: 7; implicitHeight: 7; radius: 3.5; color: kindColor(statusKind(modelData.status)) }
                                    Label { text: statusText(modelData.status); textFormat: Text.PlainText; color: muted; font.pixelSize: 12 }
                                }
                                Label { visible: modelData.hasMeetingTitle === false; text: artifactParts(modelData.artifactStatus).join(" · "); textFormat: Text.PlainText; color: muted; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                            }
                            onClicked: selectRecording(modelData)
                        }
                    }
                    Rectangle { Layout.fillWidth: true; Layout.preferredHeight: 1; color: divider }
                    FtNavButton { objectName: "recordingControlsButton"; iconName: "tools"; text: t("Gravação e tarefas…"); onClicked: recordingTools.open() }
                    FtNavButton { id: onboardingButton; objectName: "onboardingButton"; iconName: "settings"; text: t("Configurações…"); enabled: backend.available; onClicked: settingsDialog.open() }
                    FtNavButton { id: aboutButton; objectName: "aboutButton"; iconName: "info"; text: t("Sobre o FalaTrace"); onClicked: aboutDialog.open() }
                }
            }

            Rectangle {
                id: mainArea
                Layout.fillWidth: true
                Layout.fillHeight: true
                color: canvas

                HomeView { id: homeView }
                MeetingView { id: detailView }
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
                Label { objectName: "keyboardHelp"; textFormat: Text.PlainText; text: t(errorText || notice || "") || (captionHasFocus() ? t("Legendas: setas, Page Up/Down ou Espaço percorrem o texto · Tab sai") : t("Espaço: reproduzir/pausar · Setas: ±5 s · Esc: biblioteca · Trechos: navegar à origem")); color: errorText ? errorColor : notice ? ink : muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                Label { text: window.width < 1180 ? t("Serviços continuam ao fechar a janela") : t("Captura, processamento e backups continuam nos serviços ao fechar esta janela."); color: muted; font.pixelSize: 11; horizontalAlignment: Text.AlignRight; Layout.maximumWidth: window.width * 0.42; elide: Text.ElideRight }
            }
        }
    }
}
