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
        "settings": '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="6.5"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
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
    property bool uxModal: settingsDialog.visible || setupWizard.visible || aboutDialog.visible || captureConsent.visible || framesDialog.visible || onboardingDialog.visible || agentDialog.visible || recordingTools.visible || reviewDialog.visible || exportDialog.visible || summaryDialog.visible
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
            settingsDiag = result
        } else if (request.op === "settings-save") {
            if (result.needsReload) { settingsNeedsReload = true; settingsNotice = "Salvo. Releia a configuração para continuar editando."; settingsData = ({}); settingsDraft = ({}); return }
            settingsData = result; settingsDraft = Object.assign({}, result.values); settingsNeedsReload = false; settingsFirstRun = false
            const changed = result.changed || []
            const affectsMonitor = changed.some(function(f){ return f.startsWith("callDetection.") || f === "backend" || f.startsWith("capture.") || f === "recordingsDir" || f.startsWith("obs.") })
            const affectsTimers = changed.some(function(f){ return f === "recordingsDir" || f === "processing.syncIntervalMinutes" || f === "archive.syncIntervalMinutes" })
            settingsNotice = "Configuração salva" + (result.backupCreated ? " (com cópia de segurança da anterior)" : "") + "." + (affectsMonitor ? " Aplique o monitor em Serviços e diagnóstico para valer nas próximas chamadas." : "") + (affectsTimers ? " Reaplique os timers em Serviços e diagnóstico." : "") + (result.cleanupPending ? " Uma cópia temporária privada pode ter ficado na pasta da configuração." : "")
            runSettingsDiagnose()
        } else if (request.op === "settings-service") {
            settingsDiag = Object.assign({}, settingsDiag, { services: result.services })
            settingsNotice = ({
                "calls-apply": "Monitor de chamadas aplicado e reiniciado com a configuração atual.",
                "calls-disable": "Monitor de chamadas desativado. Nenhuma gravação automática será iniciada.",
                "tray-apply": "Bandeja instalada e reiniciada.",
                "tray-disable": "Bandeja removida.",
                "sync-apply": "Processamento em segundo plano ativado.",
                "sync-disable": "Processamento em segundo plano desativado. A fila foi preservada.",
                "archive-apply": "Timer de arquivo de originais ativado.",
                "archive-disable": "Timer de arquivo de originais desativado.",
                "backup-apply": "Timer de backup no Proton Drive ativado.",
                "backup-disable": "Timer de backup no Proton Drive desativado."
            })[result.action] || "Serviço atualizado."
            runSettingsDiagnose()
        }
    }
    function hasSettingsPending(op) {
        return Object.keys(pending).some(id => pending[id].op===op && pending[id].settingsGeneration===settingsGeneration)
    }
    function loadSettings(withDiagnose) {
        if(hasSettingsPending("settings-save")||hasSettingsPending("settings-read"))return
        settingsGeneration+=1;settingsData=({});settingsDraft=({})
        if(!backend.available){settingsNeedsReload=true;settingsError="Serviço indisponível. Reconecte e releia a configuração antes de salvar.";return}
        settingsError="";settingsNeedsReload=false;send("settings-read","")
        if(withDiagnose)send("settings-diagnose","")
    }
    function runSettingsDiagnose() { if(backend.available)send("settings-diagnose","") }
    function runSettingsService(action) { settingsError="";settingsNotice="";send("settings-service","",{action:action}) }
    function setSettingsField(field, value) { const next=Object.assign({},settingsDraft);next[field]=value;settingsDraft=next }
    function settingsSame(left, right) { return JSON.stringify(left === undefined ? null : left) === JSON.stringify(right === undefined ? null : right) }
    function settingsChanges() {
        const values=settingsData.values||({}), nullable=settingsData.nullable||[], changes={}
        for(const field in settingsDraft) {
            const value=settingsDraft[field]
            if(settingsSame(value, values[field])||value==="")continue
            // Cleared optional fields become null (the key is removed); other empty fields are ignored.
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
    function settingsCredentialText(source) { return source==="secrets.env"?"salva pelo Studio":source==="environment"?"definida no ambiente":source==="worker.env"?"definida em worker.env":source==="calls.env"?"definida em calls.env":source==="config"?"definida na configuração":source==="missing"?"não encontrada":"—" }
    function settingsDeviceOptions(monitor) {
        const audio=settingsDiag.audio||({}), field=monitor?"capture.desktop":"capture.microphone", current=settingsDraft[field]
        const fallback=monitor?audio.defaultDesktop:audio.defaultMicrophone
        const options=[{label:"Padrão do sistema"+(fallback?" ("+fallback+")":""),value:"default"}]
        for(const device of (audio.devices||[])) if(device.monitor===monitor) options.push({label:device.description+" · "+device.name,value:device.name})
        if(current&&current!=="default"&&!options.some(function(o){return o.value===current})) options.push({label:current+" (não encontrado agora)",value:current})
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
        if(!s.installed)return "Não instalado."
        return (s.active?"Ativo":"Parado")+(s.enabled?", inicia com a sessão.":", não inicia com a sessão.")+(s.staleConfig?" Ainda usa a configuração anterior: aplique para valer.":"")+(s.outdated?" A pasta das gravações mudou: aplique de novo.":"")
    }
    function settingsConnectionLost() {
        if(!settingsDialog.visible)return
        const saving=hasSettingsPending("settings-save")||hasSettingsPending("settings-service")
        settingsGeneration+=1;settingsNeedsReload=true
        settingsError=saving?"Conexão perdida durante a operação; o resultado não foi confirmado. Reconecte e releia antes de tentar de novo.":"Serviço desconectado. Reconecte e releia a configuração antes de salvar."
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
    // `meta` adds non-sensitive routing facts to the pending entry; payloads are never stored.
    function send(op, key, payload, meta) {
        if (["agent-authorize","provider-authorize","agent-frames","provider-analyze"].includes(op)) agentError=""
        const id = backend.request(op, key || "", payload || ({}))
        if (id < 0) { if(op.startsWith("summary-"))summaryConnectionLost();if(op.startsWith("revision-")){reviewNeedsReload=true;reviewError="Pedido sem confirmação; reconecte e releia antes de tentar novamente."}if(op.startsWith("export-")){exportError="Pedido sem confirmação; atualize a prévia após reconectar.";exportResult=({})}if(op.startsWith("agent-")||op.startsWith("provider-"))agentError="Serviço indisponível; dados preservados. Feche e reconecte para continuar."; if(op.startsWith("frames-"))uxError="Serviço indisponível; dados preservados. Reabra após reconectar.";if(op.startsWith("onboarding-"))invalidateOnboarding("O serviço não recebeu este pedido. Reconecte e releia a configuração antes de salvar.");if(op.startsWith("settings-")&&settingsDialog.visible){settingsNeedsReload=true;settingsError="O serviço não recebeu este pedido. Reconecte e releia a configuração.";return -1} errorText = "O serviço da biblioteca está indisponível. Reabra esta janela."; return -1 }
        const next = Object.assign({}, pending)
        next[id] = Object.assign({op: op, key: key, generation: generation, frameGeneration: frameGeneration, onboardingGeneration: onboardingGeneration, settingsGeneration: settingsGeneration, agentGeneration:agentGeneration, reviewGeneration:reviewGeneration,exportGeneration:exportGeneration,summaryGeneration:summaryGeneration}, meta || ({}))
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
    Shortcut { sequence: "Escape"; enabled: !!selected.key && !uxModal; onActivated: backToLibrary() }
    Timer { interval: processingWait || summaryRunning || hasPending("frames-preview") || hasPending("frames-confirm") ? 500 : 2000; running: backend.available; repeat: true; onTriggered: { if (!hasPending("processing-status")) send("processing-status", "") } }
    Label { z: 100; anchors.bottom: parent.bottom; anchors.bottomMargin: 48; anchors.horizontalCenter: parent.horizontalCenter; width: Math.min(parent.width - 32, implicitWidth); visible: !!processingWait; text: processingWait; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: warningColor; padding: 10; leftPadding: 14; rightPadding: 14; background: Rectangle { color: surface; radius: 10; border.width: 1; border.color: warningColor } }
    Timer { interval: 1000; running: captureStatus.active; repeat: true; onTriggered: statusNow = Date.now() }
    Component.onCompleted: if (backend.available) { send("list-cached", ""); send("list", ""); send("capture-status", ""); send("jobs-list", ""); send("ux-capabilities", ""); send("settings-read", "") }
    Connections {
        target: backend
        function onFailed(message) { summaryConnectionLost();revisionConnectionLost();onboardingConnectionLost();settingsConnectionLost();if(agentDialog.visible)agentError=message; captureKnown = false; pending = {}; errorText = message; loading = false; resolving = false; detailLoading = false; operationPolling = false; captureBusy = false; contextLoading = false }
        function onAvailabilityChanged() {
            if (!backend.available) { summaryConnectionLost();revisionConnectionLost();onboardingConnectionLost();settingsConnectionLost();if(agentDialog.visible)agentError="Serviço desconectado; dados preservados. Feche e reconecte para continuar."; captureKnown = false; pending = {}; loading = false; resolving = false; detailLoading = false; operationPolling = false; captureBusy = false; contextLoading = false; notice = "Serviço desconectado. Use Reconectar para continuar." }
            else { errorText = ""; notice = "Serviço conectado."; if (!libraryFresh) send("list-cached", ""); send("capture-status", ""); send("jobs-list", ""); send("list", ""); send("ux-capabilities", ""); if (!settingsFirstRunChecked && !hasSettingsPending("settings-read")) send("settings-read", "") }
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
            if (request.op.startsWith("settings-")) { handleSettingsResponse(request, message); return }
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
            } else if (request.op === "onboarding-save-local") { if(settingsDialog.visible)loadSettings(false); notice = result.cleanupPending?"Escolha local salva; uma cópia temporária privada pode permanecer na pasta da configuração. Nenhum serviço iniciado.":"Escolha local salva; nenhum serviço iniciado."; onboardingDialog.close()
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
                    FtNavButton { id: onboardingButton; objectName: "onboardingButton"; iconName: "settings"; text: "Configurações…"; enabled: backend.available; onClicked: settingsDialog.open() }
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
                                    FtButton { text: "Configurações…"; iconName: "settings"; variant: "outline"; enabled: backend.available; onClicked: settingsDialog.open() }
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
                                    FtButton { text: "Configurações…"; iconName: "settings"; variant: "outline"; onClicked: settingsDialog.open() }
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
