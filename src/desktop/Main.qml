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
    property bool lightTheme: false
    property color canvas: lightTheme ? "#F4F1E9" : "#0B1716"
    property color surface: lightTheme ? "#FFFFFF" : "#142725"
    property color panel: lightTheme ? "#E8EEE7" : "#102B2A"
    property color buttonSurface: lightTheme ? "#DDE8E0" : "#243D37"
    property color selectedSurface: lightTheme ? "#DDEFE4" : "#24443B"
    property color hoverSurface: lightTheme ? "#E6EEE8" : "#1A342E"
    property color warningColor: lightTheme ? "#A34125" : "#FFB377"
    property color errorColor: lightTheme ? "#A34125" : "#FFB4AB"
    property color recordingColor: lightTheme ? "#B62234" : "#FF7373"
    property color ink: lightTheme ? "#102B2A" : "#F4F1E9"
    property color muted: lightTheme ? "#566B66" : "#AAC0B8"
    property color accent: lightTheme ? "#0F705A" : "#57D5B0"
    property double statusNow: Date.now()
    property var items: []
    property var filtered: items.filter(item => (item.title + " " + item.fileName).toLocaleLowerCase().includes(search.text.toLocaleLowerCase()))
    property var selected: ({})
    property var detail: ({transcript: {segments: [], text: "", timing: "none"}, diarization: {state: "idle"}})
    property var pending: ({})
    property int generation: 0
    property bool loading: true
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
            return captions ? source : "Legendas desativadas · " + source
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
    property bool captureBusy: false
    property bool captureKnown: false
    property var speakerRows: {
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
    palette.text: ink
    palette.placeholderText: muted
    palette.disabled.text: muted
    palette.disabled.buttonText: muted
    palette.buttonText: ink
    palette.button: buttonSurface
    palette.base: surface
    palette.highlight: accent
    palette.highlightedText: lightTheme ? "#FFFFFF" : "#0B1716"

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
    property bool uxModal: aboutDialog.visible || captureConsent.visible || framesDialog.visible || onboardingDialog.visible || agentDialog.visible || recordingTools.visible
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
    Dialog {
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
            TextField { id: frameVisionModel; objectName: "frameVisionModel"; visible: !mockFramesEnabled; placeholderText: "Modelo instalado com capability vision"; Accessible.name: "Modelo local de visão"; Layout.fillWidth: true; maximumLength: 200; onTextEdited: { cancelFramePreview(); frameCapability=({}) } }
            TextField { id: frameSummaryModel; objectName: "frameSummaryModel"; visible: !mockFramesEnabled; placeholderText: "Modelo instalado com capability completion"; Accessible.name: "Modelo local para resumo"; Layout.fillWidth: true; maximumLength: 200; onTextEdited: { cancelFramePreview(); frameCapability=({}) } }
            Button { visible: !mockFramesEnabled; text: hasPending("frames-check-models") ? "Verificando…" : "Verificar modelos locais"; enabled: !!selected.key && !!frameVisionModel.text && !!frameSummaryModel.text && !hasPending("frames-check-models") && !hasPending("frames-confirm"); onClicked: { cancelFramePreview(); frameCapability=({}); send("frames-check-models",selected.key,{visionModel:frameVisionModel.text,summaryModel:frameSummaryModel.text}) } }
            Label { visible: !mockFramesEnabled && !!frameCapability.id; text: "Capabilities observadas: vision / completion · " + (frameCapability.endpoint || "") + " · " + frameCapability.visionModel + " / " + frameCapability.summaryModel + " · verificação expira em 5 min"; wrapMode: Text.WordWrap; textFormat: Text.PlainText; color: accent; Layout.fillWidth: true }
            Label { visible: !mockFramesEnabled && !!frameCapability.id; text: "Budget · usuário/instalação · período lifetime (sem renovação): " + (frameCapability.budgetLimits ? frameCapability.budgetLimits.maxInferences + " inferências / " + frameCapability.budgetLimits.maxPreviews + " previews" : "indisponível") + (frameCapability.temporaryAlphaDefaults ? " · defaults temporários alpha" : " · configuração explícita, mudanças auditadas") + ". Modelo local usa recursos da máquina; nenhum preço monetário estimado."; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: muted; Layout.fillWidth: true }
            Label { visible: !mockFramesEnabled; text: "Seleção explícita da transcrição · segundos absolutos do vídeo. Somente segmentos inteiros dentro do intervalo; trechos que cruzam bordas ficam omitidos."; wrapMode: Text.WordWrap; textFormat: Text.PlainText; color: muted; Layout.fillWidth: true }
            RowLayout { visible: !mockFramesEnabled; Layout.fillWidth:true; TextField { id:scopeStart; objectName:"scopeStart"; placeholderText:"Início (s)"; text:"0"; maximumLength:16; Layout.fillWidth:true; Accessible.name:"Início absoluto da seleção em segundos"; onTextEdited:selectionChanged() } TextField { id:scopeEnd; objectName:"scopeEnd"; placeholderText:"Fim (s)"; maximumLength:16; Layout.fillWidth:true; Accessible.name:"Fim absoluto da seleção em segundos"; onTextEdited:selectionChanged() } }
            Button { objectName:"prepareScopeButton"; visible:!mockFramesEnabled; text:hasPending("frames-scope")?"Preparando trecho…":"Revisar trecho incluído e omitido"; enabled:!!selected.key && !!scopeEnd.text && !hasPending("frames-scope") && !hasPending("frames-confirm"); onClicked:prepareTranscriptScope() }
            Label { objectName:"scopeSummaryLabel"; visible:!!frameScope.id; text:frameScope.id?"Incluído: " + preciseClock(frameScope.startSeconds) + "–" + preciseClock(frameScope.endSeconds) + " · " + frameScope.includedCount + " de " + frameScope.totalSegments + " segmentos · " + frameScope.characters + "/" + frameScope.maxCharacters + " caracteres serializados\nOmitido: " + frameScope.omittedCount + " (antes " + frameScope.omittedBefore + ", depois " + frameScope.omittedAfter + ", cruzam borda " + frameScope.omittedIntersecting + "). Limite: " + frameScope.maxSegments + " segmentos. " + (frameScope.withinLimits?"Trecho abaixo disponível para revisar; nada enviado ao planner.":"Acima do limite ou vazio: nenhum conteúdo enviado; reduza/ajuste a seleção. Sem truncamento automático."):""; wrapMode:Text.WordWrap; textFormat:Text.PlainText; color:frameScope.withinLimits?ink:warningColor; Layout.fillWidth:true }
            Repeater { model: frameScope.segments || []; delegate: Label { required property var modelData; text:modelData.id + " · " + preciseClock(modelData.start) + "–" + preciseClock(modelData.end) + " · " + modelData.text; wrapMode:Text.WordWrap; textFormat:Text.PlainText; color:muted; Layout.fillWidth:true } }
            CheckBox { id: plannerTranscriptConsent; objectName: "plannerTranscriptConsent"; visible: !mockFramesEnabled; text: "Autorizar somente o trecho revisado ao planner local (sem imagens)"; checked: false; enabled:!!frameScope.id && frameScope.withinLimits; Layout.fillWidth: true; onToggled: { if (!checked) cancelFramePreview() } }
            Button { objectName: "planFramesButton"; visible: !mockFramesEnabled; text: hasPending("frames-plan") ? "Planejando…" : "Decidir pelo transcript: precisa de frames?"; enabled: !!frameCapability.id && !!frameScope.id && frameScope.withinLimits && plannerTranscriptConsent.checked && !hasPending("frames-plan") && !hasPending("frames-confirm"); onClicked: planFrames() }
            Label { objectName: "plannerDecisionLabel"; visible: !!framePlan.id; text: framePlan.id ? "Decisão: " + framePlan.decision + " · " + framePlan.rationale + (framePlan.plannerCacheHit ? "\nPlano reutilizado do cache; nenhuma nova inferência de planejamento." : "\nUma tentativa de planner local consumida.") + (framePlan.decision === "frames" ? "\nPlano proposto; nenhum frame enviado. Revisar fonte → preview → consentimento." : "\nNenhum frame solicitado/enviado; resumo existente preservado.") : ""; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: ink; Layout.fillWidth: true }
            Repeater { model: framePlan.sources || []; delegate: Label { required property var modelData; text: modelData.segmentId + " · citação: " + modelData.quote; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: muted; Layout.fillWidth: true } }
            Repeater { model: framePlan.plan ? framePlan.plan.requests : []; delegate: Label { required property var modelData; text: preciseClock(modelData.timestampSeconds) + " · " + modelData.reason + " · " + modelData.segmentIds.join(", ") + "\nPergunta visual: " + modelData.question; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: ink; Layout.fillWidth: true } }
            Button { visible: framePlan.decision === "frames"; text: "Preparar previews do plano revisado"; enabled: !!framePlan.id && !hasPending("frames-preview-plan") && !hasPending("frames-confirm"); onClicked: previewPlannedFrames() }
            Label { text: "Pergunta"; color: ink }
            TextField { id: frameQuestion; objectName: "frameQuestion"; Layout.fillWidth: true; maximumLength: 1000; Accessible.name: "Pergunta para evidência visual"; onTextEdited: cancelFramePreview() }
            Label { text: "Horário em segundos, dentro de um segmento"; color: ink }
            TextField { id: frameSeconds; objectName: "frameSeconds"; Layout.fillWidth: true; maximumLength: 10; Accessible.name: "Timestamp em segundos"; onTextEdited: cancelFramePreview() }
            Button { text: hasPending("frames-preview") ? "Preview pendente…" : "Preparar preview"; enabled: !!selected.key && (mockFramesEnabled || !!frameCapability.id) && !hasPending("frames-preview") && !hasPending("frames-confirm"); onClicked: prepareFrames() }
            Label { visible: !!framePreview.id; text: framePreview.id ? "Origem: item selecionado · " + preciseClock(framePreview.plan.requests[0].timestampSeconds) + " · " + framePreview.plan.requests[0].segmentIds.join(", ") + (mockFramesEnabled ? "\n1 pedido · provider mock-local · sem custo de modelo · expira em 5 min" : "\nDestino: " + framePreview.endpoint + "\nVisão: " + framePreview.visionModel + " · resumo: " + framePreview.summaryModel + "\nEnviar: " + (framePreview.frames ? framePreview.frames.length : 1) + " JPEG(s); primeiro (" + framePreview.frameBytes + " bytes), pergunta e metadata; depois " + (framePreview.scope ? "somente trecho selecionado + observações para resumo parcial." : "transcrição completa + observações para resumo.") + "\nHash mídia: " + framePreview.mediaHash + "\nHash transcrição: " + framePreview.transcriptHash + "\nFrames: " + (framePreview.frames || []).map(function(f){return preciseClock(f.timestampSeconds) + " · " + f.bytes + " bytes · " + f.sha256}).join("\n") + "\nSaldo no preview (antes de confirmar): " + framePreview.remainingInferences + " inferências comuns / " + framePreview.remainingPreviews + " previews. Consentimento expira em até 5 min.") : ""; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: accent; Layout.fillWidth: true }
            Image { visible: !!framePreview.frameData; source: framePreview.frameData || ""; Layout.fillWidth: true; Layout.preferredHeight: visible ? 100 : 0; fillMode: Image.PreserveAspectFit; Accessible.name: "Frame local do timestamp solicitado; não é resultado de IA" }
            Repeater { model: framePreview.framePreviews ? framePreview.framePreviews.slice(1) : []; delegate: Image { required property var modelData; source: modelData.frameData; Layout.fillWidth: true; Layout.preferredHeight: 100; fillMode: Image.PreserveAspectFit; Accessible.name: "Frame adicional do plano consentido" } }
            Button { text: hasPending("frames-confirm") ? "Pedido pendente…" : (mockFramesEnabled ? "Confirmar uso do mock local" : "Autorizar visão + novo resumo local"); enabled: !!framePreview.id && !hasPending("frames-confirm") && !frameResult.sourceKey; onClicked: confirmFrames() }
            Label { visible: !!frameResult.sourceKey; text: (frameResult.synthetic ? "Resultado sintético · requer revisão\n" : "Observação do adapter local · requer revisão\n") + (frameResult.text || ""); textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: ink; Layout.fillWidth: true }
            Label { visible: !!frameResult.summaryMarkdown; text: frameResult.scope ? "Resumo parcial do intervalo selecionado · requer revisão\n" + frameResult.summaryMarkdown : "Resumo visual solicitado · requer revisão\n" + (frameResult.summaryMarkdown || ""); textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: ink; Layout.fillWidth: true }
            Button { visible: !!frameResult.sourceKey; text: "Ir à origem " + preciseClock(frameResult.timestampSeconds); onClicked: followFrameReference() }
            Repeater { model: frameResult.observations || []; delegate: Button { required property var modelData; text: "Origem " + preciseClock(modelData.timestampSeconds) + " · " + modelData.uncertainty; onClicked: followAt(modelData.timestampSeconds) } }
            Label { visible: !!uxError; text: uxError; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: errorColor; Layout.fillWidth: true }
          }
        }
        footer: Item { implicitHeight: 52; Button { id: frameCancelButton; objectName: "frameCancelButton"; anchors.right: parent.right; anchors.rightMargin: 12; anchors.verticalCenter: parent.verticalCenter; text: "Cancelar / fechar"; onClicked: framesDialog.reject() } }
    }

    component WrappedCheck: CheckBox {
        id:checkControl; Layout.fillWidth:true
        background:Rectangle { color:"transparent"; radius:4; border.width:checkControl.visualFocus?2:0; border.color:accent }
        contentItem:Text { text:checkControl.text; font:checkControl.font; color:checkControl.enabled?ink:muted; wrapMode:Text.WordWrap; leftPadding:checkControl.indicator.width+checkControl.spacing; verticalAlignment:Text.AlignVCenter }
    }

    Dialog {
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
            ComboBox { id:agentMode; objectName:"agentMode"; enabled:!agentDialog.saving; model:["Meu agente · contexto e imagens locais","Analisar com OpenAI ou Google · API"]; Layout.fillWidth:true; onCurrentIndexChanged:{cancelProvider();providerRequestUUID="";agentGeneration+=1;agentConsent.checked=false;providerConsent.checked=false;agentResult=({});showAgentSetup=visibleGrants.length===0;if(agentDialog.visible)send("agent-status",selected.key)} Accessible.name:"Como usar a gravação com IA" }
            Label { visible:agentMode.currentIndex===0; text:"O agente recebe apenas os dados autorizados. Consultar um frame não executa um modelo de IA. A conexão do seu agente com a CLI é configurada separadamente."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
            Label { visible:agentMode.currentIndex===1; text:agentState.providerAnalysis && agentState.providerAnalysis.available ? "Envio API habilitado. Confira o acesso ao modelo e a tarifa antes de analisar. Assinatura de chat não inclui uso de API." : "Envio API desativado nesta instalação. Você pode preparar a autorização; nenhuma análise será enviada. Acesso ao modelo e tarifas ainda não foram verificados."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:warningColor }
            BusyIndicator { running:hasPending("agent-status")&&!agentLoaded; visible:running; Layout.alignment:Qt.AlignHCenter }

            ComboBox { id:grantPicker; objectName:"grantPicker"; visible:visibleGrants.length>1; Layout.fillWidth:true; model:visibleGrants.map(function(g){return g.recipient.id+(g.recipient.model?" · "+g.recipient.model:"")+" · "+(g.revoked?"revogado":g.paused?"pausado":"ativo")}); Accessible.name:"Autorizações existentes"; onActivated:changeAgentGrant() }
            Frame { visible:!!activeGrant.id; Layout.fillWidth:true; padding:16
             background:Rectangle { color:surface; radius:10; border.color:buttonSurface }
             ColumnLayout { width:parent.width; spacing:10
              Label { text:activeGrant.id ? (activeGrant.revoked?"Acesso revogado":activeGrant.paused?"Acesso pausado":agentMode.currentIndex===1&&(!agentState.providerAnalysis||!agentState.providerAnalysis.available)?"Autorização salva · envio desativado":"Acesso autorizado") : ""; color:activeGrant.paused||activeGrant.revoked||(agentMode.currentIndex===1&&(!agentState.providerAnalysis||!agentState.providerAnalysis.available))?warningColor:accent; font.pixelSize:17; font.weight:Font.DemiBold }
              Label { objectName:"agentGrantLabel"; text:activeGrant.id ? activeGrant.recipient.id+(activeGrant.recipient.model?" · "+activeGrant.recipient.model:"")+"\n"+activeGrant.data.map(function(d){return d==="frames"?"Frames sob pedido":"Transcrição, resumo e busca"}).join(" + ")+"\n"+(activeGrant.scope.includesFuture?"Gravações registradas atuais e futuras · exclusões respeitadas":activeGrant.scope.recordingIds.length===1?"Somente esta gravação":activeGrant.scope.recordingIds.length+" gravações autorizadas")+" · até "+activeGrant.limits.maxFrames+" frames / "+Math.round(activeGrant.limits.maxBytes/1048576)+" MiB por pedido" : ""; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:ink }
              Label { visible:!!activeGrant.scope&&!!activeGrant.scope.includesFuture; text:"Não há filtro garantido de segredos. Exclua gravações sensíveis para cada destinatário antes de consultar frames."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:warningColor }
              Label { visible:!!activeGrant.revoked; text:"Consultas futuras foram bloqueadas. Para autorizar novamente, faça uma nova escolha abaixo. Cópias já entregues não são recolhidas."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
              RowLayout {
               Button { objectName:"agentPauseButton"; text:activeGrant.paused?"Retomar acesso":"Pausar acesso"; enabled:!!activeGrant.id&&!activeGrant.revoked&&!agentDialog.saving; onClicked:changeAgentAccess(activeGrant.paused?"agent-resume":"agent-pause") }
               Button { objectName:"agentRevokeButton"; text:"Revogar acesso"; enabled:!!activeGrant.id&&!activeGrant.revoked&&!agentDialog.saving; onClicked:changeAgentAccess("agent-revoke") }
              }
             }
            }
            Label { objectName:"agentUsageLabel"; text:agentState.budget.budgetLimits ? "Saldo local: "+agentState.budget.remainingPreviews+" extrações de frame · "+agentState.budget.remainingInferences+" análises. Reiniciar ou criar outra autorização não renova o saldo." : "Lendo limites…"; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
            Button { visible:visibleGrants.length>0; text:showAgentSetup?"Ocultar nova autorização":"Autorizar outro destinatário ou outros dados…"; enabled:!agentDialog.saving; onClicked:{showAgentSetup=!showAgentSetup;agentConsent.checked=false;providerConsent.checked=false} }

            ColumnLayout { visible:showAgentSetup && agentMode.currentIndex===0; Layout.fillWidth:true; spacing:10
             Label { text:"1. Destinatário e dados"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
             Label { text:"Nome do agente local"; color:muted }
             TextField { id:agentRecipient; objectName:"agentRecipient"; text:"local-agent"; placeholderText:"Ex.: meu-assistente"; enabled:!agentDialog.saving; Layout.fillWidth:true; onTextChanged:agentConsent.checked=false; Accessible.name:"Nome do agente local autorizado" }
             WrappedCheck { id:agentContextData; objectName:"agentContextData"; text:"Consultar transcrição, resumo e buscar esta gravação"; checked:true; enabled:!agentDialog.saving; onCheckedChanged:agentConsent.checked=false }
             WrappedCheck { id:agentFrameData; objectName:"agentFrameData"; text:"Pedir frames, inclusive quando não há transcrição"; checked:true; enabled:!agentDialog.saving; onCheckedChanged:agentConsent.checked=false }
             Label { text:"2. Autorizar uma vez"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
             Label { text:"Somente esta gravação e sua versão atual. Até 2 frames / 2 MiB por pedido, com cache privado de 5 minutos. Futuras gravações não são incluídas. O agente não precisa pedir nova confirmação a cada frame dentro desses limites."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
             WrappedCheck { id:agentConsent; objectName:"agentConsent"; text:"Autorizo este agente a consultar os dados selecionados"; enabled:!agentDialog.saving }
            }

            ColumnLayout { visible:agentMode.currentIndex===1 && showAgentSetup; enabled:!agentDialog.saving; Layout.fillWidth:true; spacing:10
             Label { text:"1. Destino e modelo"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
             ComboBox { id:providerPicker; objectName:"providerPicker"; model:["OpenAI","Google"]; Layout.fillWidth:true; onCurrentIndexChanged:providerConsent.checked=false }
             Label { text:providerPicker.currentIndex===0?"Destino: https://api.openai.com/v1/responses":"Destino: https://generativelanguage.googleapis.com/v1beta"; textFormat:Text.PlainText; wrapMode:Text.WrapAnywhere; Layout.fillWidth:true; color:muted; font.pixelSize:12 }
             TextField { id:providerModel; objectName:"providerModel"; placeholderText:"Nome do modelo com suporte a imagens e JSON"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:"Modelo escolhido para a análise" }
             WrappedCheck { id:providerCapabilities; text:"O modelo escolhido aceita imagens e JSON. O acesso ainda não foi verificado aqui."; onCheckedChanged:providerConsent.checked=false }
             WrappedCheck { id:providerContext; text:"Incluir até 1.000 caracteres da transcrição existente"; onCheckedChanged:providerConsent.checked=false }
             Label { text:"2. Limites e custo"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
             RowLayout { Label { text:"Máximo de pedidos"; color:ink } SpinBox { id:providerRequests; objectName:"providerRequests"; from:1; to:24; value:2; onValueModified:providerConsent.checked=false; Accessible.name:"Máximo de pedidos desta autorização" } }
             Label { text:"Até 2 frames / 2 MiB por pedido e 512 tokens de resposta. Esses pedidos também consomem o saldo local da instalação. A estimativa abaixo não é um limite de cobrança na conta do provider."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
             Label { text:"Tarifas opcionais · deixe em branco se desconhecidas"; color:ink; wrapMode:Text.WordWrap; Layout.fillWidth:true }
             Label { text:"Entrada · USD por milhão de tokens"; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
             TextField { id:providerInputRate; placeholderText:"Entrada: USD por milhão de tokens"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:placeholderText }
             Label { text:"Saída · USD por milhão de tokens"; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
             TextField { id:providerOutputRate; placeholderText:"Saída: USD por milhão de tokens"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:placeholderText }
             Label { text:"Estimativa de tokens por imagem"; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
             TextField { id:providerImageTokens; placeholderText:"Estimativa de tokens por imagem"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:placeholderText }
             Label { text:"Fonte e data das tarifas"; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
             TextField { id:providerTariffSource; placeholderText:"Fonte e data das tarifas informadas"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:placeholderText }
             Label { text:"Teto estimado acumulado local · USD"; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
             TextField { id:providerCostLimit; placeholderText:"Teto estimado acumulado local em USD (opcional)"; Layout.fillWidth:true; onTextChanged:providerConsent.checked=false; Accessible.name:placeholderText }
             WrappedCheck { id:providerUnknown; objectName:"providerUnknown"; text:"Aceito custo desconhecido. Não significa uso gratuito."; onCheckedChanged:providerConsent.checked=false }
             Label { text:"3. Autorizar uma vez"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
             WrappedCheck { id:providerConsent; objectName:"providerConsent"; text:"Autorizo o destino, modelo, dados e limites acima para esta gravação" }
            }

            ColumnLayout { id:providerQuestionForm; objectName:"providerQuestionForm"; visible:agentMode.currentIndex===1 && !!activeGrant.id && !!agentState.providerAnalysis && agentState.providerAnalysis.available; Layout.fillWidth:true; spacing:10
             Label { text:"Perguntar sobre um momento"; color:ink; font.pixelSize:17; font.weight:Font.DemiBold }
             Label { text:activeGrant.analysis ? "Até "+activeGrant.analysis.maxRequests+" pedidos nesta autorização · "+activeGrant.analysis.maxContextCharacters+" caracteres de contexto\nCusto desconhecido: "+(activeGrant.analysis.acceptUnknownCost?"aceito explicitamente":"análise bloqueada se não houver tarifa") : ""; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
             TextField { id:providerQuestion; objectName:"providerQuestion"; placeholderText:"O que você precisa conferir na imagem?"; Layout.fillWidth:true; onTextChanged:providerRequestUUID=""; Accessible.name:"Pergunta sobre a imagem" }
             RowLayout { Label { text:"Instante (segundos)"; color:muted } TextField { id:providerSeconds; text:"0"; Layout.fillWidth:true; onTextChanged:providerRequestUUID=""; Accessible.name:"Instante da imagem em segundos" } }
             Button { objectName:"providerAnalyzeButton"; text:hasPending("provider-analyze")?"Analisando…":!agentState.providerAnalysis||!agentState.providerAnalysis.available?"Envio API desativado":"Analisar este momento"; enabled:!!agentState.providerAnalysis&&agentState.providerAnalysis.available&&!activeGrant.paused&&!activeGrant.revoked&&!hasPending("provider-analyze")&&!!providerQuestion.text&&isFinite(Number(providerSeconds.text))&&Number(providerSeconds.text)>=0&&providerResult.status!=="uncertain"; onClicked:{agentError="";if(!providerRequestUUID)providerRequestUUID=newRequestUUID();providerPendingGrant=activeGrant.id;send("provider-analyze",selected.key,{grantId:activeGrant.id,requestId:providerRequestUUID,question:providerQuestion.text,timestamps:[Number(providerSeconds.text)]})} }
             Button { visible:hasPending("provider-analyze"); text:"Cancelar pedido"; onClicked:{cancelProvider();agentGeneration+=1;agentError="Pedido cancelado. Se já enviado, confira o estado e a cobrança no provider antes de tentar novamente.";send("agent-status",selected.key)} }
             Label { objectName:"providerResultLabel"; visible:!!providerResult.requestId; text:providerResult.requestId ? (providerResult.status==="uncertain"?"Resultado incerto. Confira o estado e a cobrança no provider antes de fazer outro pedido.":providerResult.overview||providerResult.cost||providerResult.status||"")+"\n"+(providerResult.observations||[]).map(function(o){return o.text+"\nFonte: frame "+(o.frameIndex+1)+" em "+(o.decodedTimestampSeconds===null?"instante não verificado":preciseClock(o.decodedTimestampSeconds))+" · incerteza "+o.uncertainty}).join("\n\n")+"\nObservações parciais. Confira a gravação; o resumo completo não foi alterado." : ""; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:ink }
            }

            ColumnLayout { visible:agentMode.currentIndex===0 && !!activeGrant.id && activeGrant.data.includes("frames"); Layout.fillWidth:true; spacing:10
             Label { text:"Preview opcional"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
             Label { text:"Confira um frame local. Seu agente também pode solicitar imagens dentro dos limites autorizados, sem passar por este preview."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
             RowLayout { Label { text:"Instante (segundos)"; color:muted } TextField { id:agentTime; objectName:"agentTime"; text:"0"; Layout.fillWidth:true; Accessible.name:"Instante para preview opcional" } }
             Button { id:agentPreviewButton; objectName:"agentPreviewButton"; text:hasPending("agent-frames")?"Consultando frame…":"Ver frame local"; enabled:!!activeGrant.id&&!activeGrant.revoked&&!activeGrant.paused&&activeGrant.data.includes("frames")&&!hasPending("agent-frames")&&!agentDialog.saving&&!!agentTime.text&&isFinite(Number(agentTime.text))&&Number(agentTime.text)>=0; onClicked:{agentError="";frameGrantPending=activeGrant.id;send("agent-frames",selected.key,{grantId:activeGrant.id,timestamps:[Number(agentTime.text)]})} }
             Button { id:agentCancelPreview; visible:hasPending("agent-frames"); text:"Cancelar consulta"; onClicked:{if(frameGrantPending)send("agent-cancel",selected.key,{grantId:frameGrantPending});agentGeneration+=1;frameGrantPending="";agentResult=({});agentError="Consulta cancelada; autorização preservada.";send("agent-status",selected.key)} }
             Label { id:agentResultLabel; objectName:"agentResultLabel"; text:agentResult.recordingId ? (agentResult.cacheHit?"Cache local reutilizado":"Frame extraído localmente")+"\n"+agentResult.frames.map(function(f){return "Pedido em "+preciseClock(f.requestedTimestampSeconds)+" → "+(f.decodedTimestampSeconds===null?"instante decodificado desconhecido":preciseClock(f.decodedTimestampSeconds))+" · "+(f.precision==="decoded-pts"?"instante verificado do frame":"instante não verificado")}).join("\n") : ""; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:accent }
             Image { objectName:"agentFrameImage"; visible:!!agentResult.frames&&agentResult.frames.length>0; source:visible?"file://"+agentResult.frames[0].file:""; fillMode:Image.PreserveAspectFit; Layout.fillWidth:true; Layout.preferredHeight:190; Accessible.name:"Frame local consultado, com origem temporal exibida" }
            }
            Button { text:agentDialog.detailsOpen?"Ocultar detalhes técnicos":"Origem, retenção e detalhes técnicos"; visible:!!activeGrant.id; onClicked:agentDialog.detailsOpen=!agentDialog.detailsOpen }
            Label { visible:agentDialog.detailsOpen; text:activeGrant.id ? "Autorização: "+activeGrant.id+"\nGravação: "+(activeGrant.scope.includesFuture?"Escopo desta instalação, incluindo futuras; destinatário vinculado pelo launcher local, sem autenticação do provedor. Exclua gravações sensíveis; não há detector garantido de segredos.":activeGrant.scope.recordingIds.join(", "))+"\nCache privado: "+(activeGrant.limits.cacheTtlMs/1000)+"s; remoção ao consultar após expirar. Revogar bloqueia consultas futuras, sem recolher cópias já entregues."+(activeGrant.recipient.endpoint?"\nDestino: "+activeGrant.recipient.endpoint:"")+(activeGrant.analysis?"\nTarifas informadas: "+JSON.stringify(activeGrant.analysis.rates)+"\nTeto estimado acumulado: "+(activeGrant.analysis.estimatedBudgetUsd===null?"não configurado":activeGrant.analysis.estimatedBudgetUsd+" USD"):"")+(agentResult.mediaHash?"\nOrigem SHA256: "+agentResult.mediaHash:"")+"\n"+(providerResult.observations||[]).map(function(o){return "Fonte SHA256: "+o.mediaHash+"\nFrame SHA256: "+o.frameSha256+" · precisão "+o.precision}).join("\n")+(agentResult.frames||[]).map(function(f){return "\nFrame SHA256: "+f.sha256+" · precisão "+f.precision}).join("") : ""; textFormat:Text.PlainText; wrapMode:Text.WrapAnywhere; Layout.fillWidth:true; color:muted; font.pixelSize:12 }
            Label { visible:agentMode.currentIndex===1 && agentDialog.detailsOpen; text:agentState.providerAnalysis && agentState.providerAnalysis.usage ? "Registro local: "+agentState.providerAnalysis.usage.attempts+" tentativas · estimado conhecido USD "+agentState.providerAnalysis.usage.knownEstimatedUsd+" · "+agentState.providerAnalysis.usage.unknownCostAttempts+" custos desconhecidos · "+agentState.providerAnalysis.usage.uncertainOutcomes+" resultados incertos. Não é o saldo global da conta do provider." : ""; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
          }
        }
        footer:Item { implicitHeight:agentFooter.implicitHeight+24; ColumnLayout { id:agentFooter; anchors.fill:parent; anchors.margins:12; spacing:8
          Label { id:agentErrorLabel; objectName:"agentErrorLabel"; visible:!!agentError; text:agentError; textFormat:Text.PlainText; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:errorColor; Accessible.role:Accessible.AlertMessage }
          RowLayout { Layout.fillWidth:true; spacing:10
          Label { text:agentDialog.saving?"Salvando…":showAgentSetup?"A nova escolha só vale após autorizar.":activeGrant.id?"Fechar mantém a autorização.":"Nenhum acesso autorizado."; color:muted; font.pixelSize:12; Layout.fillWidth:true; wrapMode:Text.WordWrap }
          Button { text:"Fechar"; enabled:!agentDialog.saving; onClicked:closeAgentAccess() }
          Button { visible:showAgentSetup && agentMode.currentIndex===0; objectName:"agentAuthorizeButton"; highlighted:enabled; opacity:enabled?1:0.5; text:agentDialog.saving?"Salvando…":"Autorizar acesso"; enabled:agentConsent.checked && /^[-a-z0-9._]{1,64}$/.test(agentRecipient.text) && (agentContextData.checked||agentFrameData.checked) && !agentDialog.saving; onClicked:send("agent-authorize",selected.key,{recipientId:agentRecipient.text,data:(agentContextData.checked?["context"]:[]).concat(agentFrameData.checked?["frames"]:[]),consent:true}) }
          Button { visible:showAgentSetup && agentMode.currentIndex===1; objectName:"providerAuthorizeButton"; highlighted:enabled; opacity:enabled?1:0.5; text:hasPending("provider-authorize")?"Salvando…":"Salvar autorização de análise"; enabled:providerConsent.checked&&providerCapabilities.checked&&/^[-a-zA-Z0-9._]{1,160}$/.test(providerModel.text)&&!hasPending("provider-authorize"); onClicked:authorizeProvider() }
        } } }
    }

    Dialog {
        id:recordingTools; objectName:"recordingTools"; title:"Gravação e processamento"
        anchors.centerIn:parent; width:Math.min(window.width-48,520); height:Math.min(window.height-64,530); modal:true
        closePolicy:Popup.CloseOnEscape
        contentItem:ScrollView { id:toolsScroll; clip:true; contentWidth:availableWidth
            ColumnLayout { width:toolsScroll.availableWidth; spacing:16
                Label { text:"Confira a origem do áudio e as permissões antes de gravar. Pausar a automação não encerra uma captura em andamento."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
                    Rectangle {
                        Layout.fillWidth: true; Layout.preferredHeight: 220; color: panel; radius: 8
                        ColumnLayout {
                            anchors.fill: parent; anchors.margins: 10; spacing: 6
                            RowLayout { Label { text: "Captura"; color: ink; font.bold: true; font.pixelSize: 12 } Item { Layout.fillWidth: true } Label { text: !captureKnown ? "desconhecida" : captureStatus.active ? "ativa" : "parada"; color: captureStatus.active ? recordingColor : muted; font.pixelSize: 11 } }
                            RowLayout {
                                Button { opacity: enabled ? 1 : 0.5; Layout.preferredWidth: 68; text: "Iniciar"; enabled: backend.available && captureKnown && !captureBusy && !captureStatus.active; onClicked: { captureConsent.intent = "capture"; captureConsent.open() } }
                                Button { opacity: enabled ? 1 : 0.5; Layout.preferredWidth: 68; text: "Parar"; enabled: backend.available && captureKnown && !captureBusy && captureStatus.active; onClicked: { captureBusy = true; if (send("capture-stop", "") < 0) captureBusy = false } }
                                Button { opacity: enabled ? 1 : 0.5; Layout.preferredWidth: 82; text: "Recuperar"; enabled: backend.available && captureKnown && !captureBusy && !captureStatus.active; onClicked: { captureBusy = true; if (send("capture-recover", "") < 0) captureBusy = false } }
                            }
                            Label { textFormat: Text.PlainText; text: captureStatus.warning || (captureStatus.audio && captureStatus.audio.error) || audioSummary(); color: captureStatus.warning || (captureStatus.audio && captureStatus.audio.error) ? warningColor : muted; font.pixelSize: 10; elide: Text.ElideRight; Layout.fillWidth: true; HoverHandler { id: audioHover } ToolTip.visible: audioHover.hovered; ToolTip.text: audioSummary() }
                            Label { text: captureStatus.paused ? "Automação pausada · captura atual continua" : "Automação: confira suas regras"; color: muted; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 10 }
                            Button { opacity: enabled ? 1 : 0.5; text: captureStatus.paused ? "Retomar automação…" : "Pausar novas gravações"; enabled: backend.available && !captureBusy; onClicked: { if (captureStatus.paused) { captureConsent.intent = "resume"; captureConsent.open() } else { captureBusy = true; if (send("automation-pause", "") < 0) captureBusy = false } } }
                            Button { opacity: enabled ? 1 : 0.5; text: "Configurar áudio"; enabled: backend.available && !captureBusy; onClicked: { captureBusy = true; if (send("audio-defaults", "") < 0) captureBusy = false } }
                        }
                    }

                    Rectangle {
                        visible: jobs.length > 0
                        Layout.fillWidth: true; Layout.preferredHeight: 145; color: panel; radius: 8
                        ColumnLayout {
                            anchors.fill: parent; anchors.margins: 10; spacing: 5
                            RowLayout { Label { text: "Processamento"; color: ink; font.bold: true; font.pixelSize: 12 } Item { Layout.fillWidth: true } Label { text: jobs.length; color: muted; font.pixelSize: 11 } }
                            ComboBox { id: jobPicker; Layout.fillWidth: true; model: jobs; textRole: "title"; currentIndex: jobs.findIndex(job => job.id === selectedJob.id); displayText: selectedJob.title || "Selecione uma tarefa"; enabled: backend.available; onActivated: selectedJob = jobs[index] || ({}) }
                            Label { textFormat: Text.PlainText; text: selectedJob.id ? (statusText(selectedJob.state) + (selectedJob.error ? " · " + selectedJob.error : "")) : "Selecione uma tarefa"; color: selectedJob.error ? errorColor : muted; font.pixelSize: 10; elide: Text.ElideRight; Layout.fillWidth: true }
                            RowLayout {
                                Button { opacity: enabled ? 1 : 0.5; text: "Processar"; enabled: backend.available && !hasPending("job-process") && !hasPending("job-retry") && !!selectedJob.id && ["pending", "queued", "transferring"].includes(selectedJob.state); onClicked: send("job-process", selectedJob.id) }
                                Button { opacity: enabled ? 1 : 0.5; text: "Repetir"; enabled: backend.available && !hasPending("job-process") && !hasPending("job-retry") && !!selectedJob.id && selectedJob.state === "failed"; onClicked: send("job-retry", selectedJob.id) }
                            }
                        }
                    }

            }
        }
        footer:Item { implicitHeight:52; Button { text:"Fechar"; anchors.right:parent.right; anchors.rightMargin:12; anchors.verticalCenter:parent.verticalCenter; onClicked:recordingTools.close() } }
    }

    Dialog {
        id:onboardingDialog; objectName:"onboardingDialog"; title:"Configuração e privacidade"
        anchors.centerIn:parent; width:Math.min(window.width-48,580); height:Math.min(window.height-64,600); modal:true
        closePolicy:hasPending("onboarding-save-local")?Popup.NoAutoClose:Popup.CloseOnEscape
        onOpened:{onboardingGeneration+=1;onboardingDraft=({});localChoice.checked=false;uxError="";send("onboarding-read","");localChoice.forceActiveFocus(Qt.TabFocusReason)}
        onClosed:{onboardingGeneration+=1;onboardingDraft=({});localChoice.checked=false;onboardingButton.forceActiveFocus(Qt.TabFocusReason)}
        contentItem:ScrollView { id:onboardingScroll; clip:true; contentWidth:availableWidth
         ColumnLayout { width:onboardingScroll.availableWidth; spacing:16
          Label { text:onboardingDraft.revision?(onboardingDraft.exists?"Suas escolhas atuais":"Comece neste computador"):"Lendo configuração…"; color:ink; font.pixelSize:22; font.weight:Font.DemiBold; wrapMode:Text.WordWrap; Layout.fillWidth:true }
          Label { text:onboardingDraft.exists?"Você só altera a configuração ao salvar. Cancelar mantém tudo como está.":"Escolha o processamento local para a primeira configuração. Esta tela não instala modelos nem inicia uma gravação."; color:muted; wrapMode:Text.WordWrap; Layout.fillWidth:true }
          Frame { visible:!!onboardingDraft.revision; Layout.fillWidth:true; padding:14
           background:Rectangle { color:surface; radius:8; border.color:buttonSurface }
           ColumnLayout { width:parent.width; spacing:8
            Label { text:"RESUMO E DESTINO ATUAIS"; font.pixelSize:11; font.letterSpacing:1; color:accent }
            Label { text:onboardingDraft.revision ? onboardingDraft.summaryProvider+" · "+onboardingDraft.destination : ""; textFormat:Text.PlainText; wrapMode:Text.WrapAnywhere; Layout.fillWidth:true; color:ink }
            Label { text:onboardingDraft.local?"Destino configurado neste computador. Modelo ainda não validado.":"Destino externo ou fora deste computador. Confira antes de enviar conteúdo."; color:onboardingDraft.local?muted:warningColor; wrapMode:Text.WordWrap; Layout.fillWidth:true }
           }
          }
          WrappedCheck { id:localChoice; objectName:"localChoice"; text:"Usar Whisper.cpp para transcrição e Ollama neste computador para resumos"; enabled:!!onboardingDraft.revision&&!hasPending("onboarding-save-local"); Accessible.name:text }
          Label { text:"Ao salvar esta escolha"; font.pixelSize:17; font.weight:Font.DemiBold; color:ink }
          Label { text:"• O processamento automático de novas gravações fica desativado.\n• As demais opções são preservadas. Se já há um arquivo de configuração, é criada uma cópia privada de segurança.\n• Serviços existentes podem usar a nova escolha nas próximas execuções."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
          Label { text:"Whisper.cpp, Ollama e os modelos precisam estar instalados separadamente. Uma assinatura de chat não inclui uso de API. Excluir aqui não apaga cópias remotas ou já exportadas."; wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted; font.pixelSize:12 }
          Label { visible:!!uxError; text:uxError; textFormat:Text.PlainText; wrapMode:Text.WordWrap; color:errorColor; Layout.fillWidth:true }
         }
        }
        footer:Item { implicitHeight:60; RowLayout { anchors.fill:parent; anchors.margins:12; spacing:10
         Item { Layout.fillWidth:true }
         Button { text:"Cancelar"; enabled:!hasPending("onboarding-save-local"); onClicked:onboardingDialog.reject() }
         Button { objectName:"onboardingSaveButton"; highlighted:enabled; opacity:enabled?1:0.5; text:hasPending("onboarding-save-local")?"Salvando…":"Salvar escolha local"; enabled:localChoice.checked&&!!onboardingDraft.revision&&!hasPending("onboarding-save-local"); onClicked:send("onboarding-save-local","",{revision:onboardingDraft.revision}) }
        } }
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
    onActiveFocusItemChanged:Qt.callLater(function(){
        if(agentDialog.visible)revealFocusedControl(agentScrollView)
        if(onboardingDialog.visible)revealFocusedControl(onboardingScroll)
        if(recordingTools.visible)revealFocusedControl(toolsScroll)
        if(framesDialog.visible)revealFocusedControl(frameScroll)
    })

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
    function activeSpeakerLabels(seconds) {
        const turns = (detail.diarization && detail.diarization.turns) || []
        const labels = turns.filter(turn => Number(turn.start) <= seconds && seconds < Number(turn.end)).map(turn => turn.label || turn.speaker || "Falante incerto")
        return labels.filter((label, index) => labels.indexOf(label) === index).join(" + ")
    }
    function send(op, key, payload) {
        if (["agent-authorize","provider-authorize","agent-frames","provider-analyze"].includes(op)) agentError=""
        const id = backend.request(op, key || "", payload || ({}))
        if (id < 0) { if(op.startsWith("agent-")||op.startsWith("provider-"))agentError="Serviço indisponível; dados preservados. Feche e reconecte para continuar."; if(op.startsWith("frames-") || op.startsWith("onboarding-")) uxError = "Serviço indisponível; dados preservados. Reabra após reconectar."; errorText = "O serviço da biblioteca está indisponível. Reabra esta janela."; return -1 }
        const next = Object.assign({}, pending)
        next[id] = {op: op, key: key, generation: generation, frameGeneration: frameGeneration, onboardingGeneration: onboardingGeneration, agentGeneration:agentGeneration}
        pending = next
        return id
    }
    function backToLibrary() {
        closeAgentAccess(); framesDialog.close(); cancelFramePreview()
        generation += 1; sourceReferenceSeconds = -1; selected = ({}); detail = {transcript: {segments: [], text: "", timing: "none"}, diarization: {state: "idle"}}
        detailLoading = false; resolving = false; contextLoading = false; contextText = ""; contextCopyText = ""; contextPath = ""; contextCitations = []
        mediaReady = false; pendingPath = ""; position = 0; duration = 0; location = ""; playbackOperation = ""; operationPolling = false; errorText = ""; notice = ""
        if (playerInitialized) video.commandAsync(["stop"])
        search.forceActiveFocus(Qt.TabFocusReason)
    }
    function selectRecording(item) { showVisualSummary=false;
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
        if (!backend.available || !id || contextLoading) return
        contextLoading = true; contextText = ""; contextCopyText = ""; tabs.currentIndex = 3
        if (send("context-meeting", id, {maxCharacters: 10000}) < 0) contextLoading = false
    }
    Shortcut { sequence: "Space"; enabled: mediaReady && !textHasFocus && !uxModal && !captionToggle.activeFocus && !captionHasFocus(); onActivated: togglePlay() }
    Shortcut { sequence: "Right"; enabled: mediaReady && !textHasFocus && !uxModal && !captionHasFocus(); onActivated: seek(position + 5) }
    Shortcut { sequence: "Left"; enabled: mediaReady && !textHasFocus && !uxModal && !captionHasFocus(); onActivated: seek(position - 5) }
    Dialog {
        id: aboutDialog; objectName: "aboutDialog"; title: "Sobre o FalaTrace"
        anchors.centerIn: parent; width: Math.min(520, window.width - 32); modal: true
        closePolicy: Popup.CloseOnEscape
        onOpened: aboutClose.forceActiveFocus(Qt.TabFocusReason)
        onClosed: aboutButton.forceActiveFocus(Qt.TabFocusReason)
        contentItem: ColumnLayout { spacing: 14
            Label { objectName:"aboutVersion"; text: "Studio em execução: " + Qt.application.version; color: ink; Layout.fillWidth:true; wrapMode:Text.WordWrap }
            Label { text: "Build local: " + studioBuildId; color: muted; Layout.fillWidth:true; wrapMode:Text.WordWrap }
            Label { text: "CLI conectado: " + (backend.available && cliVersion ? cliVersion : "indisponível"); color: muted; Layout.fillWidth:true; wrapMode:Text.WordWrap }
            Label { text: cliVersion && cliVersion !== Qt.application.version ? "Studio e CLI têm versões diferentes. Feche e reabra o Studio após atualizar." : "Versão publicada: não consultada. Esta tela não verifica atualizações pela rede."; color: muted; Layout.fillWidth:true; wrapMode:Text.WordWrap }
            Label { text: "No terminal: falatrace --version"; color: ink; Layout.fillWidth:true; wrapMode:Text.WordWrap }
            Button { id:aboutClose; text:"Fechar"; Layout.alignment:Qt.AlignRight; onClicked:aboutDialog.close() }
        }
    }
    Dialog {
        id: captureConsent
        property string intent: "capture"
        objectName: "captureConsent"
        title: intent === "resume" ? "Retomar gravações automáticas" : "Antes de iniciar a gravação"
        anchors.centerIn: parent
        width: Math.min(window.width - 64, 520)
        modal: true
        standardButtons: Dialog.Ok | Dialog.Cancel
        closePolicy: Popup.CloseOnEscape
        contentItem: Label {
            text: (captureConsent.intent === "resume" ? "As regras já configuradas poderão iniciar novas gravações. Esta ação não inicia uma captura manual. " : "") + "Confirme a permissão das pessoas envolvidas. A captura usa a tela e as fontes de áudio configuradas. Revise o áudio antes de continuar.\n\n" + audioSummary() + "\n\nFechar o Studio não encerra a captura. Use Parar para finalizá-la. O processamento usa os providers configurados; serviços externos podem receber conteúdo."
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            color: ink
            Accessible.name: text
        }
        onOpened: { standardButton(Dialog.Ok).text = intent === "resume" ? "Retomar automação" : "Iniciar gravação"; standardButton(Dialog.Cancel).text = "Cancelar" }
        onAccepted: {
            if (backend.available && !captureBusy && (intent === "resume" || !captureStatus.active)) {
                captureBusy = true
                if (send(intent === "resume" ? "automation-resume" : "capture-start", "", intent === "resume" ? ({}) : {title: ""}) < 0) captureBusy = false
            }
        }
    }
    Shortcut { sequence: "Escape"; enabled: !!selected.key && !uxModal; onActivated: backToLibrary() }
    Timer { interval: processingWait || hasPending("frames-preview") || hasPending("frames-confirm") ? 500 : 2000; running: backend.available; repeat: true; onTriggered: { if (!hasPending("processing-status")) send("processing-status", "") } }
    Label { z: 100; anchors.bottom: parent.bottom; anchors.horizontalCenter: parent.horizontalCenter; width: parent.width - 32; visible: !!processingWait; text: processingWait; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: warningColor; padding: 8; background: Rectangle { color: panel } }
    Timer { interval: 1000; running: captureStatus.active; repeat: true; onTriggered: statusNow = Date.now() }
    Component.onCompleted: if (backend.available) { send("list", ""); send("capture-status", ""); send("jobs-list", ""); send("ux-capabilities", "") }
    Connections {
        target: backend
        function onFailed(message) { if(agentDialog.visible)agentError=message; captureKnown = false; pending = {}; errorText = message; loading = false; resolving = false; detailLoading = false; operationPolling = false; captureBusy = false; contextLoading = false }
        function onAvailabilityChanged() {
            if (!backend.available) { if(agentDialog.visible)agentError="Serviço desconectado; dados preservados. Feche e reconecte para continuar."; captureKnown = false; pending = {}; loading = false; resolving = false; detailLoading = false; operationPolling = false; captureBusy = false; contextLoading = false; notice = "Serviço desconectado. Use Reconectar para continuar." }
            else { errorText = ""; notice = "Serviço conectado."; send("capture-status", ""); send("jobs-list", ""); send("list", ""); send("ux-capabilities", "") }
        }
        function onResponse(message) {
            const request = pending[message.id]
            if (!request) return
            const next = Object.assign({}, pending)
            delete next[message.id]
            pending = next
            if (["detail", "resolve", "playback-status", "context-meeting", "diarization-name", "subtitles", "diarization"].includes(request.op) && request.generation !== generation) return
            if (request.op === "playback-status") operationPolling = false
            if (request.op === "list") loading = false
            if (request.op === "detail") detailLoading = false
            if (request.op.startsWith("frames-") && request.op !== "frames-cancel" && (request.generation !== generation || request.frameGeneration !== frameGeneration)) return
            if((request.op.startsWith("agent-")||request.op.startsWith("provider-")) && (request.generation !== generation || request.agentGeneration !== agentGeneration)) return
            if (request.op.startsWith("onboarding-") && request.onboardingGeneration !== onboardingGeneration) return
            if (!message.ok && (request.op.startsWith("agent-")||request.op.startsWith("provider-"))) { agentError=message.error; return }
            if (!message.ok && request.op === "processing-status") { processingWait = "Estado do processamento indisponível; nenhuma alteração na captura."; return }
            if (!message.ok && (request.op.startsWith("frames-") || request.op.startsWith("onboarding-"))) { uxError = message.error; return }
            if (!message.ok) { errorText = message.error; notice = ""; captureBusy = false; contextLoading = false; if (request.op === "subtitles") subtitleQueued = false; if (request.op === "diarization") diarizationQueued = false; if (request.op === "resolve" || request.op === "playback-status") { resolving = false; playbackOperation = "" } return }
            const result = message.result
            if(request.op === "provider-authorize") {providerConsent.checked=false;showAgentSetup=false;preferredGrantId=result.id;changeAgentGrant()
            } else if(request.op === "provider-analyze") {providerPendingGrant="";providerResult=result;send("agent-status",selected.key)
            } else if(request.op === "provider-cancel") {agentError="Pedido de análise cancelado; resultado/custo podem ser incertos se já enviado."
            } else if(request.op === "agent-status") { const prior=preferredGrantId||activeGrant.id;preferredGrantId="";agentState=result;const index=visibleGrants.findIndex(function(g){return g.id===prior});grantPicker.currentIndex=index>=0?index:0;if(!agentLoaded){showAgentSetup=!visibleGrants.length;agentLoaded=true}
            } else if(request.op === "agent-frames") { frameGrantPending="";agentResult=result; send("agent-status",selected.key)
            } else if(["agent-authorize","agent-pause","agent-resume","agent-revoke"].includes(request.op)) { if(request.op==="agent-authorize"){showAgentSetup=false;preferredGrantId=result.id;changeAgentGrant()}else send("agent-status",selected.key);agentConsent.checked=false; agentResult=({});
            } else if(request.op === "agent-cancel") { agentError="Consulta cancelada; autorização preservada."
            } else if (request.op === "ux-capabilities") { cliVersion = result.productVersion || ""; mockFramesEnabled = !!result.mockFrames; realFramesEnabled = !!result.realFrames
            } else if (request.op === "processing-status") { processingWait = result.waiting.length ? result.waiting[0].message : ""
            } else if (request.op === "frames-cancel") { send("processing-status", "")
            } else if (request.op === "frames-check-models") { frameCapability = result
            } else if (request.op === "frames-scope") { frameScope = result
            } else if (request.op === "frames-plan") { framePlan = result
            } else if (request.op === "frames-preview" || request.op === "frames-preview-plan") { framePreview = result
            } else if (request.op === "frames-confirm") { frameResult = result; showVisualSummary=false; if (!result.synthetic && result.summaryMarkdown) { const updated=Object.assign({},detail); updated.visualReview=result; detail=updated }
            } else if (request.op === "onboarding-read") { onboardingDraft = result; localChoice.forceActiveFocus(Qt.TabFocusReason)
            } else if (request.op === "onboarding-save-local") { notice = "Escolha local salva; nenhum serviço iniciado."; onboardingDialog.close()
            } else if (request.op === "list") {
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
                if (!initialTranscriptTiming) initialTranscriptTiming = result.transcript.timing
                selected = Object.assign({}, selected, {status: result.status, backup: result.backup})
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

    ColumnLayout {
        anchors.fill: parent; spacing: 0
        Rectangle {
            Layout.fillWidth: true; Layout.preferredHeight: 76; color: panel
            RowLayout {
                anchors.fill: parent; anchors.margins: 22; spacing: 14
                Image { source: lightTheme ? "../../docs/assets/falatrace-mark-light.svg" : "../../docs/assets/falatrace-mark-dark.svg"; sourceSize.width: 40; sourceSize.height: 40; Layout.preferredWidth: 40; Layout.preferredHeight: 40; Accessible.name: "FalaTrace" }
                ColumnLayout {
                    spacing: 2
                    Label { text: "FalaTrace Studio"; color: ink; font.pixelSize: 20; font.weight: Font.DemiBold }
                    Label { text: Qt.application.version + " · experimental"; color: muted; font.pixelSize: 12 }
                }
                Item { Layout.fillWidth: true }
                ColumnLayout {
                    spacing: 4
                    Label { text: !captureKnown ? "Captura: estado desconhecido" : captureStatus.active ? "■ REC · " + clock(Math.max(0, (statusNow - Date.parse(captureStatus.session && captureStatus.session.startedAt || new Date(statusNow).toISOString())) / 1000)) : "○ Captura parada"; color: captureStatus.active ? recordingColor : muted; font.pixelSize: 11 }
                    Label { text: captureStatus.audio && captureStatus.audio.configured && captureStatus.audio.configured.audioSource ? "Áudio: " + captureStatus.audio.configured.audioSource : "Áudio não validado"; color: captureStatus.audio && captureStatus.audio.configured ? muted : warningColor; font.pixelSize: 10 }
                }
                Button { opacity: enabled ? 1 : 0.5; text: lightTheme ? "Tema escuro" : "Tema claro"; Accessible.name: text; onClicked: lightTheme = !lightTheme }
                Button { id:headerStop; objectName:"headerStop"; Keys.onReturnPressed:clicked(); Keys.onEnterPressed:clicked(); visible:captureStatus.active; text:"Parar captura"; enabled:backend.available&&captureKnown&&!captureBusy; onClicked:{captureBusy=true;if(send("capture-stop","")<0)captureBusy=false} }
                Button { visible:!captureStatus.active || window.width>=1100; opacity: enabled ? 1 : 0.5; text: window.width < 1100 ? "Atualizar" : "Atualizar biblioteca"; Accessible.name: "Atualizar biblioteca"; enabled: backend.available && !loading; onClicked: { loading = true; send("list", "") } }
                Button { opacity: enabled ? 1 : 0.5; text: "Reconectar"; visible: !backend.available; enabled: !backend.available; onClicked: backend.reconnect() }
            }
        }
        RowLayout {
            Layout.fillWidth: true; Layout.fillHeight: true; spacing: 0
            Rectangle {
                Layout.preferredWidth: window.width < 1100 ? 248 : 276; Layout.fillHeight: true; color: surface
                ColumnLayout {
                    anchors.fill: parent; anchors.margins: 16; spacing: 14
                    RowLayout { Label { text: "Gravações"; color: ink; font.pixelSize: 16; font.bold: true } Item { Layout.fillWidth: true } Label { text: items.length; color: muted } }
                    TextField { id: search; Layout.fillWidth: true; placeholderText: "Buscar gravação…"; Accessible.name: "Buscar gravação" }
                    BusyIndicator { Layout.alignment: Qt.AlignHCenter; running: loading; visible: loading }
                    Label { visible: !loading && !filtered.length; text: items.length ? "Nenhum resultado." : "Nenhuma gravação encontrada."; color: muted; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    ListView {
                        id: libraryView
                        currentIndex: filtered.findIndex(item => item.key === selected.key)
                        Layout.fillWidth: true; Layout.fillHeight: true; clip: true; spacing: 6; model: filtered
                        ScrollBar.vertical: ScrollBar {}
                        delegate: ItemDelegate {
                            required property var modelData
                            width: ListView.view.width; height: 102
                            enabled: backend.available
                            Accessible.name: modelData.title + ", " + origin(modelData.location)
                            background: Rectangle { radius: 8; color: selected.key === modelData.key ? selectedSurface : parent.hovered ? hoverSurface : "transparent" }
                            contentItem: ColumnLayout {
                                spacing: 5
                                Label { text: modelData.title; color: ink; font.pixelSize: 13; font.weight: Font.Medium; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight; Layout.fillWidth: true; textFormat: Text.PlainText }
                                Label { text: Qt.formatDateTime(new Date(modelData.modifiedAt), "dd MMM · hh:mm"); color: muted; font.pixelSize: 11 }
                                Label { text: origin(modelData.location) + " · " + statusText(modelData.status); color: selected.key === modelData.key ? accent : muted; font.pixelSize: 10; elide: Text.ElideRight; Layout.fillWidth: true }
                            }
                            onClicked: selectRecording(modelData)
                        }
                    }
                    Button { id:aboutButton; objectName:"aboutButton"; text:"Sobre / versão…"; Layout.fillWidth:true; onClicked:aboutDialog.open() }
                    Button { objectName:"recordingControlsButton"; text:"Gravação e tarefas…"; Layout.fillWidth:true; onClicked:recordingTools.open() }
                    Button { id:agentAccessButton; objectName:"agentAccessButton"; text:"Acesso para IA…"; Layout.fillWidth:true; enabled:backend.available && !!selected.recordingId; onClicked:openAgentAccess() }
                    Button { id:onboardingButton; objectName:"onboardingButton"; text: "Configuração e privacidade…"; Layout.fillWidth: true; enabled: backend.available; onClicked: onboardingDialog.open() }
                    Button { text: mockFramesEnabled ? "Frames · mock local…" : "Análise visual local…"; Layout.fillWidth: true; enabled: backend.available && (mockFramesEnabled || realFramesEnabled) && !!selected.key; onClicked: { cancelFramePreview(); framesDialog.open() } ToolTip.visible: hovered; ToolTip.text: mockFramesEnabled ? "Ensaio sintético explícito, sem provider real." : "Preview local; análise e novo resumo somente após consentimento explícito." }

                }
            }
            ColumnLayout {
                Layout.fillWidth: true; Layout.fillHeight: true; Layout.margins: window.height < 720 ? 14 : 22; spacing: window.height < 720 ? 8 : 14
                Button { opacity: enabled ? 1 : 0.5; visible: !!selected.key; text: "← Biblioteca"; onClicked: backToLibrary(); Accessible.name: "Voltar à biblioteca" }
                Label { text: selected.title || "Sua biblioteca de gravações"; color: ink; font.pixelSize: 21; font.weight: Font.DemiBold; Layout.fillWidth: true; elide: Text.ElideRight; textFormat: Text.PlainText }
                Label { text: selected.key ? (mediaReady && location ? "Reproduzindo de " + origin(location) : "Origem: " + origin(selected.location)) + (selected.backup && selected.backup !== "none" ? "  ·  Cópias: " + selected.backup.replace("+", " + ").toUpperCase() : "") : "Selecione uma gravação para acessar o vídeo e o conteúdo."; color: muted; font.pixelSize: 12; Layout.fillWidth: true; elide: Text.ElideRight }
                RowLayout {
                    Layout.fillWidth: true; Layout.fillHeight: true; spacing: 18
                    ColumnLayout {
                        Layout.fillWidth: true; Layout.fillHeight: true; spacing: 10
                        Rectangle {
                            Layout.fillWidth: true; Layout.fillHeight: true; Layout.minimumHeight: 220; color: "#05080d"; radius: 8; clip: true
                            RecordingVideo {
                                id: video; objectName: "recordingVideo"; anchors.fill: parent
                                onReady: { playerInitialized = true; setPropertyAsync("pause", true); setPropertyAsync("hwdec", smokeSoftware ? "no" : "auto-safe"); setPropertyAsync("volume", 70); loadMedia() }
                            }
                            ColumnLayout {
                                anchors.centerIn: parent; width: parent.width - 48; visible: !mediaReady
                                BusyIndicator { Layout.alignment: Qt.AlignHCenter; running: resolving; visible: resolving }
                                Label { Layout.fillWidth: true; text: resolving ? "Preparando a gravação…" : selected.key ? (selected.location === "missing" ? "Mídia indisponível" : "Gravação pronta para abrir") : "Escolha uma gravação"; color: "#F4F1E9"; font.pixelSize: 18; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.WordWrap }
                                Button { opacity: enabled ? 1 : 0.5; Layout.alignment: Qt.AlignHCenter; visible: !!selected.key && !resolving; enabled: backend.available && selected.location !== "missing"; text: "Abrir gravação"; onClicked: openRecording() }
                            }
                            Rectangle {
                                anchors.top: parent.top; anchors.left: parent.left; anchors.margins: 12
                                width: Math.min(parent.width - 24, currentVoices.implicitWidth + 20); height: currentVoices.implicitHeight + 12; radius: 5; color: "#d910141a"
                                visible: mediaReady && !!activeSpeakerLabels(position)
                                Label { id: currentVoices; anchors.centerIn: parent; width: parent.width - 20; text: activeSpeakerLabels(position) + " · automático"; textFormat: Text.PlainText; color: "#57D5B0"; font.pixelSize: 12; wrapMode: Text.WordWrap; maximumLineCount: 2; elide: Text.ElideRight }
                            }
                            Rectangle {
                                id: captionOverlay; objectName: "captionOverlay"
                                anchors.bottom: parent.bottom; anchors.bottomMargin: 24; anchors.horizontalCenter: parent.horizontalCenter
                                width: Math.min(parent.width - 36, caption.implicitWidth + 28); height: Math.min(caption.implicitHeight + 16, parent.height * 0.5); radius: 5; color: "#d910141a"
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
                                    ScrollBar.vertical: ScrollBar { policy: captionViewport.contentHeight > captionViewport.height ? ScrollBar.AlwaysOn : ScrollBar.AlwaysOff }
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
                        Slider { id: timeline; Layout.fillWidth: true; from: 0; to: window.duration || 1; value: window.position; enabled: mediaReady; Accessible.name: "Posição do vídeo"; onMoved: window.seek(value) }
                        RowLayout {
                            Button { Layout.minimumWidth: 40; Layout.preferredWidth: window.width < 1100 ? 40 : 100; Accessible.name: paused ? "Reproduzir" : "Pausar"; opacity: enabled ? 1 : 0.5; text: window.width < 1100 ? (paused ? "▶" : "Ⅱ") : paused ? "▶ Reproduzir" : "Ⅱ Pausar"; enabled: mediaReady; onClicked: togglePlay() }
                            Button { Layout.minimumWidth: 54; Layout.preferredWidth: window.width < 1100 ? 54 : 100; Accessible.name: "Voltar dez segundos"; opacity: enabled ? 1 : 0.5; text: "−10 s"; enabled: mediaReady; onClicked: seek(position - 10) }
                            Label { text: clock(position) + " / " + clock(duration); color: muted; font.family: "monospace"; font.pixelSize: 12 }
                            Item { Layout.fillWidth: true }
                            CheckBox { id: captionToggle; objectName: "captionToggle"; text: window.width < 1100 ? "CC" : "Legendas"; Accessible.name: "Exibir legendas quando houver uma faixa disponível"; checked: captions; enabled: !!selected.key; onToggled: captions = checked }
                        }
                        Label { objectName: "captionStatus"; visible: !!selected.key; text: captionStatusText; textFormat: Text.PlainText; color: captionAvailable ? muted : warningColor; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    }
                    Rectangle {
                        Layout.preferredWidth: Math.max(290, Math.min(390, window.width * 0.28)); Layout.fillHeight: true; color: surface; radius: 8
                        ColumnLayout {
                            anchors.fill: parent; anchors.margins: 14; spacing: 12
                            TabBar {
                                id: tabs; Layout.fillWidth: true
                                Repeater {
                                model: ["Transcrição", "Resumo", "Falantes", "Contexto IA"]
                                    TabButton { opacity: enabled ? 1 : 0.5;
                                        required property string modelData
                                        text: modelData
                                        contentItem: Label { text: parent.text; color: parent.checked ? accent : muted; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter; font.pixelSize: 12 }
                                        background: Rectangle { color: parent.checked ? selectedSurface : canvas; radius: 4 }
                                    }
                                }
                            }
                            Button { id: visualSummaryButton; objectName: "visualSummaryButton"; visible: tabs.currentIndex===1 && !!detail.visualReview && !!detail.visualReview.summaryMarkdown; text: showVisualSummary ? "Voltar ao resumo original" : (detail.visualReview && detail.visualReview.scope ? "Ver resumo parcial do intervalo visual" : "Ver resumo visual solicitado"); onClicked: showVisualSummary=!showVisualSummary }
                            Label { visible: tabs.currentIndex===1 && showVisualSummary && !!detail.visualReview; text: detail.visualReview && detail.visualReview.scope ? "PARCIAL · " + preciseClock(detail.visualReview.scope.startSeconds) + "–" + preciseClock(detail.visualReview.scope.endSeconds) + " · restante omitido; revisar origem" : "Resumo visual solicitado · revisar origem"; textFormat: Text.PlainText; color: warningColor; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                            Label { visible: tabs.currentIndex === 1; text: detail.summaryInfo ? "Configuração do job: " + detail.summaryInfo + " · Resumo de IA: confira a fonte e os avisos de revisão." : "Resumo de IA: confira a fonte e os avisos de revisão."; textFormat: Text.PlainText; color: muted; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 11 }
                            Label { visible: tabs.currentIndex === 0 && detail.transcript.timing === "block"; text: "Texto original; tempos aproximados por bloco."; color: muted; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                            Label { visible: tabs.currentIndex === 2; textFormat: Text.PlainText; text: detail.diarization.message || "Identifique os falantes para revisar suas participações nesta gravação."; color: detail.diarization.state === "failed" ? errorColor : muted; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                            Label { visible: tabs.currentIndex === 2 && (detail.diarization.turns || []).length > 0; text: "A aba Transcrição mantém o texto original. Os horários desta aba pertencem à identificação de vozes."; color: muted; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                            ListView {
                                visible: tabs.currentIndex === 0 && (detail.transcript.segments || []).length > 0
                                Layout.fillWidth: true; Layout.fillHeight: true; model: detail.transcript.segments || []; clip: true; spacing: 6
                                ScrollBar.vertical: ScrollBar {}
                                delegate: ItemDelegate {
                                    required property var modelData; required property int index
                                    width: ListView.view.width; height: segmentContent.implicitHeight + 20
                                    enabled: mediaReady
                                    background: Rectangle { radius: 6; color: activeSegment === index ? selectedSurface : parent.hovered ? hoverSurface : "transparent" }
                                    contentItem: ColumnLayout { id: segmentContent; spacing: 5; Label { text: clock(modelData.start); color: accent; font.pixelSize: 11; font.family: "monospace" } Label { visible: !!modelData.speaker; text: "Falante: " + (modelData.speaker || ""); textFormat: Text.PlainText; color: muted; font.pixelSize: 11 } Label { text: modelData.text; textFormat: Text.PlainText; color: ink; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 13 } }
                                    onClicked: seek(modelData.start)
                                }
                            }
                            ColumnLayout {
                                visible: tabs.currentIndex === 2
                                Layout.fillWidth: true; Layout.fillHeight: true; spacing: 6
                                Label { text: "Nomes dos falantes"; color: muted; font.pixelSize: 10 }
                                ListView {
                                    Layout.fillWidth: true; Layout.preferredHeight: Math.min(112, Math.max(54, speakerRows.length * 54)); model: speakerRows; clip: true; spacing: 4
                                    delegate: ItemDelegate {
                                        required property var modelData
                                        width: ListView.view.width; height: 50
                                        enabled: backend.available && !!selected.key
                                        Accessible.name: modelData.label || "Falante incerto"
                                        contentItem: RowLayout {
                                            spacing: 6
                                            Label { text: modelData.speakerId; color: accent; Layout.preferredWidth: 70; elide: Text.ElideRight; font.pixelSize: 10 }
                                            TextField { id: renameField; placeholderText: "Falante incerto"; text: modelData.label; Layout.fillWidth: true; font.pixelSize: 11; onAccepted: if (text.trim()) send("diarization-name", diarizationKey(), {speakerId: modelData.speakerId, label: text.trim()}) }
                                            Button { opacity: enabled ? 1 : 0.5; text: "Salvar"; Layout.preferredWidth: 58; enabled: backend.available && !!renameField.text.trim() && renameField.text.trim() !== modelData.label; onClicked: send("diarization-name", diarizationKey(), {speakerId: modelData.speakerId, label: renameField.text.trim()}) }
                                        }
                                    }
                                }
                                Label { text: "Falas do diarizador · texto automático, revisar"; color: muted; font.pixelSize: 10; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                                Label { visible: !!detail.diarization.textCoverage && detail.diarization.textCoverage.shownTurns < detail.diarization.textCoverage.totalTurns; text: detail.diarization.textCoverage ? "Texto parcial na interface: " + detail.diarization.textCoverage.shownTurns + "/" + detail.diarization.textCoverage.totalTurns + " falas. Os horários e nomes continuam disponíveis; o resultado local completo foi preservado." : ""; textFormat: Text.PlainText; color: warningColor; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 10 }
                                ListView {
                                    Layout.fillWidth: true; Layout.fillHeight: true; model: detail.diarization.turns || []; clip: true; spacing: 3
                                    ScrollBar.vertical: ScrollBar {}
                                    delegate: ItemDelegate {
                                        required property var modelData
                                        width: ListView.view.width; height: turnContent.implicitHeight + 18; enabled: mediaReady
                                        Accessible.name: (modelData.label || modelData.speaker || "Falante incerto") + ", " + preciseClock(modelData.start) + " a " + preciseClock(modelData.end) + ". " + (modelData.text !== undefined ? modelData.text : "Texto não disponível nesta prévia.")
                                        contentItem: ColumnLayout {
                                            id: turnContent; spacing: 5
                                            RowLayout { spacing: 6; Label { text: preciseClock(modelData.start) + "–" + preciseClock(modelData.end); color: accent; font.family: "monospace"; font.pixelSize: 10; Layout.preferredWidth: 128 } Label { text: modelData.label || modelData.speaker || "Falante incerto"; textFormat: Text.PlainText; color: accent; font.pixelSize: 12; Layout.fillWidth: true; elide: Text.ElideRight } }
                                            Label { text: modelData.text !== undefined ? modelData.text : "Texto não disponível nesta prévia."; textFormat: Text.PlainText; color: modelData.text !== undefined ? ink : muted; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 13 }
                                        }
                                        onClicked: seek(Number(modelData.start))
                                    }
                                }
                            }
                            RowLayout {
                                visible: tabs.currentIndex === 3
                                Layout.fillWidth: true
                                Button { opacity: enabled ? 1 : 0.5; text: contextLoading ? "Preparando contexto…" : "Pedir contexto"; enabled: backend.available && !!diarizationKey() && !contextLoading; onClicked: requestMeetingContext() }
                                Button { opacity: enabled ? 1 : 0.5; text: "Copiar contexto"; enabled: !!contextText && !!contextCopyText; onClicked: { compactContext.selectAll(); compactContext.copy(); compactContext.deselect() } }
                            }
                            TextEdit { id: compactContext; visible: false; text: contextCopyText; textFormat: TextEdit.PlainText }
                            Label { textFormat: Text.PlainText; visible: tabs.currentIndex === 3 && !!contextPath; text: "Fonte: " + contextPath; color: muted; font.pixelSize: 10; elide: Text.ElideMiddle; Layout.fillWidth: true }
                            Label { textFormat: Text.PlainText; visible: tabs.currentIndex === 3 && contextCitations.length > 0; text: "Citações: " + contextCitations.join(" · "); color: muted; font.pixelSize: 10; elide: Text.ElideRight; Layout.fillWidth: true }
                            ScrollView {
                                visible: tabs.currentIndex !== 0 && tabs.currentIndex !== 2 || (tabs.currentIndex === 0 && !(detail.transcript.segments || []).length)
                                Layout.fillWidth: true; Layout.fillHeight: true; clip: true
                                TextArea { id: contextArea; readOnly: true; selectByMouse: true; wrapMode: TextEdit.Wrap; textFormat: TextEdit.PlainText; color: ink; font.pixelSize: 13; text: tabs.currentIndex === 0 ? detail.transcript.text || (detailLoading ? "Carregando…" : "Transcrição ainda não disponível.") : tabs.currentIndex === 1 ? (showVisualSummary && detail.visualReview ? detail.visualReview.summaryMarkdown : detail.summary) || "Resumo ainda não disponível." : tabs.currentIndex === 3 ? (contextText || (contextLoading ? "Preparando contexto sob demanda…" : "Peça o contexto para esta gravação quando precisar.")) : detail.timesheet || "Nenhum apontamento vinculado a esta gravação." }
                            }
                            Button { opacity: enabled ? 1 : 0.5; visible: tabs.currentIndex === 0 && !!detail.subtitleId; Layout.fillWidth: true; text: subtitleQueued ? "Legendas em preparação…" : "Gerar legendas no worker configurado"; enabled: backend.available && !subtitleQueued && detail.subtitleState !== "ready"; onClicked: { subtitleQueued = true; if (send("subtitles", detail.subtitleId) < 0) subtitleQueued = false } }
                            Button { opacity: enabled ? 1 : 0.5; visible: (tabs.currentIndex === 0 || tabs.currentIndex === 2) && !!detail.diarizationId && !(tabs.currentIndex === 2 && detail.diarization.state === "review"); Layout.fillWidth: true; text: diarizationQueued ? "Identificação em preparação…" : detail.diarization.state === "review" ? "Ver falantes" : "Identificar falantes"; enabled: backend.available && !diarizationQueued; onClicked: { if (detail.diarization.state === "review") tabs.currentIndex = 2; else { diarizationQueued = true; if (send("diarization", detail.diarizationId) < 0) diarizationQueued = false } } }
                        }
                    }
                }
                Label { objectName: "keyboardHelp"; textFormat: Text.PlainText; text: (errorText ? "⚠ " + errorText : "") || notice || (captionHasFocus() ? "Legendas: setas, Page Up/Down ou Espaço percorrem o texto · Tab sai" : "Espaço: reproduzir/pausar · Setas: ±5 s · Esc: biblioteca · Trechos: navegar à origem"); color: errorText ? errorColor : muted; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
            }
        }
        Label { Layout.fillWidth: true; leftPadding: 22; bottomPadding: 12; topPadding: 10; text: "Captura, processamento e backups continuam nos serviços ao fechar esta janela."; color: muted; font.pixelSize: 11 }
    }
}
