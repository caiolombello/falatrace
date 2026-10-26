import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Ask (DESIGN-STUDIO §2.9): a drawer beside the page, not a Popup, so it stays open while you click
// the moments an answer cites. The scope comes from where you opened it (this meeting, a person, a
// client or the whole library) and the destination is shown before anything is sent: one outside
// this computer needs a confirmation once per conversation (assistant-plan's consentKey binds the
// destination and the scope). The answer streams (assistant-poll every 400 ms); under each
// paragraph its citations open the meeting at that moment. "/" at the start of the input offers
// recipes, read again on each opening and after Settings changes them. The consent and the problem
// cards sit above the input, never below the fold of a long conversation, and the consent takes the
// focus. Every failure stays in this panel: errorText and notice are never touched.
Rectangle {
    id: askPanel
    objectName: "askPanel"
    property bool opened: false
    readonly property bool shown: opened && feature("assistant") && currentView !== "live"
    // Conversation: the scope it is about, its thread id once the bridge saved it, finished messages
    // and the answer coming in (`live`).
    property var scope: ({kind: "library"})
    property string scopeLabel: ""
    property string threadId: ""
    property var messages: []
    property var live: null
    property string runId: ""
    property bool planning: false
    property var plan: ({})
    // Consent keys confirmed in this conversation (destination + scope).
    property var accepted: ({})
    // A question waiting for the consent card ({question, recipeId, recipeName, consentKey}).
    property var waiting: null
    property string problem: ""
    property int askGeneration: 0
    property var recipes: []
    property int recipesGeneration: 0
    property bool threadsOpen: false
    property var threads: []
    property bool threadsLoading: false
    property Item opener: null
    property alias input: askInput
    readonly property bool busy: planning || runId !== ""
    readonly property bool recipeMode: askInput.text.indexOf("/") === 0 && askInput.text.indexOf("\n") < 0 && feature("recipes")
    visible: shown
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    anchors.right: parent.right
    width: compactLayout ? Math.min(340, parent.width - 48) : 384
    z: 30
    color: surface
    Rectangle { anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom; width: 1; color: compactLayout ? dividerStrong : divider }
    // In the compact layout the drawer covers the page: a soft edge separates it.
    Rectangle { visible: compactLayout; anchors.right: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom; width: 10; gradient: Gradient { orientation: Gradient.Horizontal; GradientStop { position: 0; color: "transparent" } GradientStop { position: 1; color: lightTheme ? "#26102B2A" : "#66000000" } } }

    // ── Scope ──
    function viewScope() {
        if (currentView === "meeting" && (detail.jobId || selected.jobId)) return {scope: {kind: "meeting", jobId: String(detail.jobId || selected.jobId).toLowerCase()}, label: recordingTitle(selected) || selected.fileName || ""}
        if (currentView === "people" && peopleView.selectedId) return {scope: {kind: "person", personId: peopleView.selectedId}, label: peopleView.selectedName}
        if (currentView === "clients" && clientsView.selectedCode) return {scope: {kind: "client", clientCode: clientsView.selectedCode}, label: clientsView.selectedName}
        return {scope: {kind: "library"}, label: ""}
    }
    function sameScope(a, b) { return JSON.stringify(a) === JSON.stringify(b) }
    function scopeText() {
        // A conversation keeps its meeting while you navigate: away from it, the chip names it.
        if (scope.kind === "meeting") return currentView === "meeting" && String(detail.jobId || selected.jobId || "").toLowerCase() === scope.jobId ? t("Esta reunião") : tf("Reunião: %1", scopeLabel || t("reunião"))
        if (scope.kind === "person") return tf("Pessoa: %1", scopeLabel)
        if (scope.kind === "client") return tf("Cliente: %1", scopeLabel)
        return t("Toda a biblioteca")
    }
    // A conversation about another scope: a new one (an answer still coming in keeps its own).
    function useScope(info) {
        if (sameScope(info.scope, scope) && (messages.length || live)) { scopeLabel = info.label || scopeLabel; return }
        if (busy) return
        newThread(info)
    }
    function newThread(info) {
        if (runId) cancelRun()
        askGeneration += 1
        const next = info || viewScope()
        scope = next.scope; scopeLabel = next.label || ""
        threadId = ""; messages = []; live = null; waiting = null; problem = ""; plan = ({}); accepted = ({}); planning = false; threadsOpen = false
    }

    // ── Opening and closing ──
    function openWith(info, question, recipe) {
        if (!feature("assistant")) return
        opener = window.activeFocusItem
        useScope(info || viewScope())
        opened = true
        loadRecipes()
        if (typeof question === "string" && question !== "") askInput.text = question
        Qt.callLater(function(){ askInput.forceActiveFocus(Qt.ShortcutFocusReason); askInput.cursorPosition = askInput.length })
        if (recipe && recipe.id) runRecipe(recipe)
    }
    function toggle() { if (shown) close(); else openWith(viewScope(), "", null) }
    function close() {
        opened = false; threadsOpen = false
        if (opener && opener.visible) opener.forceActiveFocus(Qt.TabFocusReason)
        opener = null
    }
    // Esc: stops an answer coming in, else closes the drawer.
    function handleEscape() { if (runId) stop(); else if (threadsOpen) threadsOpen = false; else close() }

    // ── Asking ──
    // Recipes are read on every opening and again when Settings saved, deleted or renamed one (or the
    // language changed) while the drawer is open; the list there was stays until the new one arrives.
    function loadRecipes() {
        if (!feature("recipes") || !backend.available) return
        recipesGeneration += 1
        send("recipes-list", "", ({}), {origin: "ask", recipesGeneration: recipesGeneration})
    }
    function reloadRecipes() { if (shown) loadRecipes() }
    function submit() {
        if (recipeMode) { recipeList.choose(); return }
        const question = askInput.text.trim()
        if (!question || busy || !backend.available) return
        askInput.text = ""
        ask(question, null)
    }
    function runRecipe(recipe) {
        if (busy || !backend.available) return
        askInput.text = ""
        ask("", recipe)
    }
    function ask(question, recipe) {
        problem = ""; waiting = null; planning = true
        const pending = {question: question || "", recipeId: recipe ? recipe.id : "", recipeName: recipe ? recipe.name : ""}
        const payload = {scope: scope, question: pending.question}
        if (pending.recipeId) payload.recipeId = pending.recipeId
        if (send("assistant-plan", "", payload, {origin: "ask", askGeneration: askGeneration, ask: pending}) < 0) { planning = false; problem = t("Sem conexão com o FalaTrace.") }
    }
    function planned(request, result) {
        planning = false
        plan = result
        const pending = request.ask
        if (result.ready !== true) { problem = t(result.message || "") || t("O assistente não está pronto. Confira em Configurações."); restore(pending); focusCard(askConfigure); return }
        // Outside this computer: one confirmation per conversation for this destination and scope.
        if (!(result.destination && result.destination.external === false) && !accepted[result.consentKey]) {
            waiting = Object.assign({}, pending, {consentKey: result.consentKey}); focusCard(askConsentCancel); return
        }
        start(pending, result.consentKey)
    }
    // The card that needs an answer takes the keyboard focus once it is laid out (with the focus ring).
    function focusCard(button) { Qt.callLater(function(){ if (shown && button.visible && button.enabled) button.forceActiveFocus(Qt.TabFocusReason) }) }
    // A question that could not go keeps its words in the input.
    function restore(pending) { if (pending && pending.question && !askInput.text) askInput.text = pending.question }
    function acceptConsent() {
        if (!waiting) return
        const next = Object.assign({}, accepted); next[waiting.consentKey] = true; accepted = next
        const pending = waiting; waiting = null
        start(pending, pending.consentKey)
    }
    function start(pending, consentKey) {
        const shownText = pending.recipeName ? "/" + pending.recipeName : pending.question
        messages = messages.concat([{role: "user", text: shownText, question: pending.question, recipeId: pending.recipeId, recipeName: pending.recipeName}])
        live = {role: "assistant", text: "", citations: [], status: "running", question: pending.question, recipeId: pending.recipeId, recipeName: pending.recipeName}
        const payload = {scope: scope, question: pending.question}
        if (threadId) payload.threadId = threadId
        if (pending.recipeId) payload.recipeId = pending.recipeId
        if (consentKey) payload.consentKey = consentKey
        planning = true
        if (send("assistant-start", "", payload, {origin: "ask", askGeneration: askGeneration}) < 0) { planning = false; finishLive("failed", t("Sem conexão com o FalaTrace.")) }
    }
    function finishLive(status, error) {
        if (!live) return
        const done = Object.assign({}, live, {status: status, error: error || ""})
        messages = messages.concat([done]); live = null; runId = ""
    }
    function stop() {
        if (!runId) return
        send("assistant-cancel", "", {runId: runId}, {origin: "ask", askGeneration: askGeneration})
        finishLive("cancelled", "")
    }
    function cancelRun() { if (runId) send("assistant-cancel", "", {runId: runId}, {origin: "ask", askGeneration: askGeneration}); runId = "" }
    function retry(index) {
        const answer = messages[index]
        if (!answer || busy) return
        const known = answer.recipeId ? recipes.find(function(recipe){ return recipe.id === answer.recipeId }) : null
        if (answer.recipeId) runRecipe({id: answer.recipeId, name: answer.recipeName || (known ? known.name : answer.recipeId)}); else if (String(answer.question || "").trim()) ask(answer.question, null)
    }

    // ── Replies (all of them stay in this panel) ──
    function handleResponse(request, message) {
        if (request.op === "recipes-list") {
            if (request.recipesGeneration !== recipesGeneration || !message.ok) return
            recipes = asList(message.result.recipes).map(function(recipe){ return {id: recipe.id, name: recipe.name, description: recipe.description || "", scope: recipe.scope} })
            return
        }
        if (request.askGeneration !== askGeneration) {
            // A question started for a conversation that was left meanwhile ("Nova conversa", another
            // scope): nobody follows that answer, so it is stopped instead of running on (and costing).
            if (request.op === "assistant-start" && message.ok && message.result && message.result.runId) send("assistant-cancel", "", {runId: message.result.runId}, {origin: "ask", askGeneration: request.askGeneration})
            return
        }
        if (request.op === "assistant-plan") {
            if (!message.ok) { planning = false; problem = t(message.error); restore(request.ask); focusCard(askConfigure); return }
            planned(request, message.result)
        } else if (request.op === "assistant-start") {
            planning = false
            if (!message.ok) { finishLive("failed", t(message.error)); return }
            runId = message.result.runId || ""; threadId = message.result.threadId || threadId
            if (!runId) finishLive("failed", t("Não deu para obter a resposta agora."))
        } else if (request.op === "assistant-poll") {
            if (request.runId !== runId || !live) return
            if (!message.ok) { finishLive("failed", t(message.error)); return }
            const result = message.result
            live = Object.assign({}, live, {text: result.text || "", citations: asList(result.citations), cutOff: result.cutOff === true})
            if (result.threadId) threadId = result.threadId
            if (result.status !== "running") finishLive(result.status === "done" ? "done" : result.status, result.error ? t(result.error) : "")
        } else if (request.op === "assistant-threads") {
            threadsLoading = false
            threads = message.ok ? asList(message.result.threads) : []
        } else if (request.op === "assistant-thread") {
            if (!message.ok) { problem = t(message.error); return }
            const result = message.result
            threadId = result.id || ""; threadsOpen = false; accepted = ({}); waiting = null; live = null; problem = ""
            let asked = {question: "", recipeId: ""}
            messages = asList(result.messages).map(function(item){
                if (item.role === "user") asked = {question: item.recipeId ? "" : (item.text || ""), recipeId: item.recipeId || ""}
                return {role: item.role, text: item.text || "", citations: asList(item.citations), status: "done", question: asked.question, recipeId: item.recipeId || asked.recipeId}
            })
            Qt.callLater(function(){ messageList.positionViewAtEnd() })
        }
    }
    function connectionLost() {
        if (planning || runId) { planning = false; finishLive("failed", t("Sem conexão com o FalaTrace.")) }
        runId = ""; threadsLoading = false
    }
    Timer {
        interval: 400; repeat: true
        running: askPanel.runId !== "" && backend.available
        onTriggered: { if (!hasPending("assistant-poll")) send("assistant-poll", "", {runId: askPanel.runId}, {origin: "ask", askGeneration: askPanel.askGeneration, runId: askPanel.runId}) }
    }
    function showThreads() {
        if (busy && !threadsOpen) return
        threadsOpen = !threadsOpen
        if (!threadsOpen || !backend.available) return
        threadsLoading = true; threads = []
        if (send("assistant-threads", "", {scope: scope}, {origin: "ask", askGeneration: askGeneration}) < 0) threadsLoading = false
    }
    function openThread(id) { if (!busy) send("assistant-thread", "", {threadId: id}, {origin: "ask", askGeneration: askGeneration}) }

    // ── Answers: paragraphs with their citations ──
    function paragraphs(text) {
        return String(text || "").split(/\n\s*\n/).map(function(part){ return part.trim() }).filter(function(part){ return part.length > 0 })
    }
    function citationsIn(paragraph, citations) {
        const wanted = [], seen = ({})
        const pattern = /\[(\d{1,3})\]/g
        let match
        while ((match = pattern.exec(paragraph)) !== null) { const n = Number(match[1]); if (!seen[n]) { seen[n] = true; wanted.push(n) } }
        return citations.filter(function(citation){ return seen[Number(citation.n)] === true }).sort(function(a, b){ return Number(a.n) - Number(b.n) })
    }
    function citationLabel(citation) {
        const at = typeof citation.start === "number" ? clock(citation.start) : ""
        if (scope.kind === "meeting" && String(citation.jobId).toLowerCase() === scope.jobId) return String(citation.n) + (at ? " · " + at : "")
        const title = String(citation.title || "")
        const short = title.length > 18 ? title.slice(0, 17) + "…" : title
        const date = citation.date ? new Date(citation.date) : null
        const day = date && !isNaN(date.getTime()) ? Qt.formatDate(date, t("dd/MM")) : ""
        return [String(citation.n), short, day, at].filter(function(part){ return !!part }).join(" · ")
    }
    function openCited(citation) {
        const start = typeof citation.start === "number" ? citation.start : -1
        if (selected.key && String(detail.jobId || selected.jobId || "").toLowerCase() === String(citation.jobId).toLowerCase()) {
            if (start >= 0) openCitation(citation.segmentId || "", start, false); else detailView.focusSegment(citation.segmentId || "", 0)
        } else openMeetingAt(citation.jobId, citation.segmentId || "", start)
    }
    function copyAnswer(text) {
        askClipboard.text = String(text || "")
        askClipboard.selectAll(); askClipboard.copy(); askClipboard.deselect()
        toast.show(t("Resposta copiada."), "", null)
    }
    function shareAnswer(answer) { shareDialog.openText(answer.text, answer.recipeName || answer.question || scopeText()) }
    // Destination before the first question: what the settings say; after it, what the bridge planned.
    function destinationLabel() {
        const destination = plan.destination
        if (destination && destination.label) return t(destination.label) + (destination.subscription ? " · " + t(destination.subscription) : "")
        const provider = studioSettings["assistant.provider"]
        if (provider === "local") return "Ollama · " + (studioSettings["assistant.localModel"] || "")
        if (provider === "api") return ({openrouter: "OpenRouter", openai: "OpenAI", gemini: "Gemini", xai: "xAI", groq: "Groq", mistral: "Mistral", deepseek: "DeepSeek", together: "Together", anthropic: "Anthropic", custom: t("API compatível")})[studioSettings["assistant.apiPreset"]] || t("Uma API")
        if (provider === "acp") return String(studioSettings["assistant.acpAgent"] || "ACP")
        if (provider === "cli") return String(studioSettings["assistant.cliTool"] || "CLI")
        if (provider === "chatgpt") return "ChatGPT"
        return ""
    }
    // The plan lists the meetings whose excerpts go (a Qt sequence, not a number).
    function planMeetingCount() {
        const meetings = plan.meetings
        return typeof meetings === "number" ? meetings : asList(meetings).length
    }
    function destinationExternal() {
        if (plan.destination) return plan.destination.external !== false
        const provider = studioSettings["assistant.provider"]
        if (provider === undefined) return false
        return provider !== "local" || !ollamaOnThisComputer() || ollamaCloudModel(studioSettings["assistant.localModel"])
    }
    // The local assistant talks to the Ollama address of the settings; only a loopback host stays here.
    function ollamaOnThisComputer() {
        const match = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]*\]|[^\/:?#]*)/i.exec(String(studioSettings["summary.ollamaUrl"] || "http://127.0.0.1:11434"))
        return !!match && ["127.0.0.1", "localhost", "[::1]", "::1"].indexOf(match[1].toLowerCase()) >= 0
    }
    function suggestions() {
        if (scope.kind === "meeting") return [t("Quais foram as decisões?"), t("O que ficou comigo?"), t("Quais perguntas ficaram em aberto?")]
        if (scope.kind === "person") return [tf("O que eu prometi para %1?", scopeLabel), t("Quais assuntos voltam sempre?")]
        if (scope.kind === "client") return [t("O que está pendente com este cliente?"), t("Quais riscos apareceram?")]
        return [t("O que eu prometi esta semana?"), t("Quais decisões tomamos este mês?")]
    }
    function suggestedRecipes() { return recipes.filter(function(recipe){ return recipe.scope === "library" || scope.kind === "meeting" }).slice(0, 3) }

    TextEdit { id: askClipboard; visible: false; textFormat: TextEdit.PlainText }

    component Answer: ColumnLayout {
        id: answer
        property var message: ({})
        property int index: -1
        property bool streaming: false
        spacing: 6
        Repeater {
            model: askPanel.paragraphs(answer.message.text).length ? askPanel.paragraphs(answer.message.text) : (answer.streaming ? [""] : [])
            delegate: ColumnLayout {
                id: paragraphBlock
                required property var modelData
                required property int index
                readonly property var cited: askPanel.citationsIn(modelData, asList(answer.message.citations))
                Layout.fillWidth: true
                spacing: 4
                Label {
                    Layout.fillWidth: true
                    text: paragraphBlock.modelData + (answer.streaming && paragraphBlock.index === askPanel.paragraphs(answer.message.text).length - 1 ? "▍" : (answer.streaming && !paragraphBlock.modelData ? "▍" : ""))
                    textFormat: Text.PlainText; wrapMode: Text.Wrap; color: aiInk; font.pixelSize: 14; lineHeight: 1.3
                }
                Flow {
                    Layout.fillWidth: true
                    spacing: 4
                    visible: paragraphBlock.cited.length > 0
                    Repeater {
                        model: paragraphBlock.cited
                        delegate: AbstractButton {
                            id: citeChip
                            required property var modelData
                            objectName: "askCitation-" + answer.index + "-" + modelData.n
                            focusPolicy: Qt.StrongFocus
                            hoverEnabled: true
                            implicitHeight: 22
                            implicitWidth: citeRow.implicitWidth + 14
                            Accessible.role: Accessible.Button
                            Accessible.name: tf("Abrir a fonte %1", askPanel.citationLabel(modelData))
                            ToolTip.visible: hovered
                            ToolTip.delay: 500
                            ToolTip.text: (modelData.title || "") + (typeof modelData.start === "number" ? " · " + clock(modelData.start) : "")
                            onClicked: askPanel.openCited(modelData)
                            Keys.onReturnPressed: askPanel.openCited(modelData)
                            Keys.onEnterPressed: askPanel.openCited(modelData)
                            background: Rectangle {
                                radius: 11
                                color: citeChip.down ? shade(citationSurface, 0.12) : citeChip.hovered ? shade(citationSurface, 0.05) : citationSurface
                                Rectangle { anchors.fill: parent; anchors.margins: -3; radius: 14; color: "transparent"; border.width: 2; border.color: accent; visible: citeChip.visualFocus }
                            }
                            contentItem: Item {
                                Row {
                                    id: citeRow
                                    anchors.centerIn: parent
                                    spacing: 4
                                    FtIcon { name: typeof citeChip.modelData.start === "number" ? "play" : "transcript"; tint: citationInk; size: 10; anchors.verticalCenter: parent.verticalCenter }
                                    Label { text: askPanel.citationLabel(citeChip.modelData); textFormat: Text.PlainText; color: citationInk; font.pixelSize: 11; font.weight: Font.DemiBold; anchors.verticalCenter: parent.verticalCenter }
                                }
                            }
                        }
                    }
                }
            }
        }
        Label { visible: answer.streaming && !answer.message.text; text: askPanel.destinationExternal() ? t("Esperando a resposta…") : t("Pensando…"); textFormat: Text.PlainText; color: muted; font.pixelSize: 12 }
        Label { visible: answer.message.cutOff === true; text: t("A resposta foi cortada no limite de tamanho."); textFormat: Text.PlainText; color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
        Label { visible: answer.message.status === "cancelled"; text: t("Resposta interrompida."); textFormat: Text.PlainText; color: muted; font.pixelSize: 12 }
        RowLayout {
            visible: answer.message.status === "failed"
            Layout.fillWidth: true
            spacing: 6
            FtIcon { name: "alert"; tint: warningColor; size: 14; Layout.alignment: Qt.AlignTop }
            Label { objectName: "askError-" + answer.index; Layout.fillWidth: true; text: answer.message.error || t("Não deu para obter a resposta agora."); textFormat: Text.PlainText; color: ink; font.pixelSize: 12; wrapMode: Text.WordWrap }
        }
        Flow {
            visible: !answer.streaming
            Layout.fillWidth: true
            spacing: 2
            FtButton { objectName: "askCopy-" + answer.index; visible: !!answer.message.text; compact: true; variant: "ghost"; iconName: "copy"; text: t("Copiar"); implicitHeight: 28; onClicked: askPanel.copyAnswer(answer.message.text) }
            FtButton { objectName: "askShareAnswer-" + answer.index; visible: !!answer.message.text && feature("share"); compact: true; variant: "ghost"; iconName: "send"; text: t("Enviar…"); implicitHeight: 28; enabled: backend.available; onClicked: askPanel.shareAnswer(answer.message) }
            FtButton { objectName: "askRetry-" + answer.index; compact: true; variant: "ghost"; iconName: "refresh"; iconOnly: true; text: t("Perguntar de novo"); implicitHeight: 28; visible: !!answer.message.recipeId || String(answer.message.question || "").trim() !== ""; enabled: backend.available && !askPanel.busy; onClicked: askPanel.retry(answer.index) }
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.leftMargin: 1
        spacing: 0

        // Header: title, new conversation, earlier conversations, close.
        RowLayout {
            Layout.fillWidth: true
            Layout.leftMargin: 14; Layout.rightMargin: 8; Layout.topMargin: 10
            spacing: 4
            FtIcon { name: "chat"; tint: accent; size: 18 }
            Label { text: t("Perguntar"); textFormat: Text.PlainText; color: ink; font.pixelSize: 16; font.weight: Font.DemiBold; Layout.fillWidth: true; leftPadding: 4 }
            FtButton { objectName: "askNew"; iconOnly: true; compact: true; variant: "ghost"; iconName: "plus"; text: t("Nova conversa"); onClicked: askPanel.newThread(askPanel.viewScope()) }
            FtButton { objectName: "askThreadsButton"; iconOnly: true; compact: true; variant: askPanel.threadsOpen ? "secondary" : "ghost"; iconName: "history"; text: t("Conversas anteriores"); enabled: backend.available && (!askPanel.busy || askPanel.threadsOpen); onClicked: askPanel.showThreads() }
            FtButton { objectName: "askClose"; iconOnly: true; compact: true; variant: "ghost"; iconName: "close"; text: t("Fechar (Esc)"); onClicked: askPanel.close() }
        }
        // Scope and destination, before anything is sent.
        Flow {
            Layout.fillWidth: true
            Layout.leftMargin: 14; Layout.rightMargin: 14; Layout.topMargin: 6; Layout.bottomMargin: 8
            spacing: 6
            AbstractButton {
                id: scopeChip
                objectName: "askScopeChip"
                readonly property bool switchable: currentView === "meeting" && !!(detail.jobId || selected.jobId) && !askPanel.busy
                implicitHeight: 26
                implicitWidth: Math.min(askPanel.width - 40, scopeRow.implicitWidth + 18)
                focusPolicy: switchable ? Qt.StrongFocus : Qt.NoFocus
                hoverEnabled: true
                Accessible.role: Accessible.Button
                Accessible.name: tf("Escopo: %1", askPanel.scopeText()) + (switchable ? t(", trocar") : "")
                ToolTip.visible: hovered && switchable
                ToolTip.text: askPanel.scope.kind === "meeting" ? t("Perguntar sobre toda a biblioteca") : t("Perguntar só sobre esta reunião")
                onClicked: { if (!switchable) return; askPanel.newThread(askPanel.scope.kind === "meeting" ? {scope: {kind: "library"}, label: ""} : askPanel.viewScope()) }
                background: Rectangle { radius: 13; color: scopeChip.hovered && scopeChip.switchable ? hoverSurface : surfaceAlt; border.width: scopeChip.visualFocus ? 2 : 1; border.color: scopeChip.visualFocus ? accent : divider }
                contentItem: Item {
                    RowLayout {
                        id: scopeRow
                        anchors.centerIn: parent
                        width: Math.min(implicitWidth, scopeChip.width - 18)
                        spacing: 5
                        FtIcon { name: askPanel.scope.kind === "meeting" ? "note" : askPanel.scope.kind === "person" ? "user" : askPanel.scope.kind === "client" ? "building" : "list"; tint: accent; size: 13 }
                        Label { text: askPanel.scopeText(); textFormat: Text.PlainText; color: ink; font.pixelSize: 12; font.weight: Font.Medium; elide: Text.ElideRight; Layout.fillWidth: true }
                        FtIcon { visible: scopeChip.switchable; name: "chevron-down"; tint: muted; size: 11 }
                    }
                }
            }
            FtChip {
                objectName: "askDestinationChip"
                visible: text !== ""
                iconName: askPanel.destinationExternal() ? "cloud" : "lock"
                kind: askPanel.destinationExternal() ? "warning" : "accent"
                text: askPanel.destinationLabel()
                maximumWidth: askPanel.width - 40
                HoverHandler { id: destinationHover }
                ToolTip.visible: destinationHover.hovered
                ToolTip.text: askPanel.destinationExternal() ? t("Fora deste computador: confirmação antes do primeiro envio de cada conversa.") : t("Neste computador: nada sai daqui.")
            }
        }
        Rectangle { Layout.fillWidth: true; Layout.preferredHeight: 1; color: divider }

        // Earlier conversations about this scope.
        ColumnLayout {
            objectName: "askThreads"
            visible: askPanel.threadsOpen
            Layout.fillWidth: true
            Layout.margins: 12
            spacing: 4
            FtOverline { text: t("Conversas anteriores") }
            BusyIndicator { visible: askPanel.threadsLoading; running: visible; implicitWidth: 24; implicitHeight: 24 }
            Label { visible: !askPanel.threadsLoading && !askPanel.threads.length; text: t("Nenhuma conversa ainda sobre isto."); textFormat: Text.PlainText; color: muted; font.pixelSize: 12 }
            Repeater {
                model: askPanel.threads
                delegate: ItemDelegate {
                    id: threadRow
                    required property var modelData
                    required property int index
                    objectName: "askThread-" + index
                    Layout.fillWidth: true
                    hoverEnabled: true
                    leftPadding: 8; rightPadding: 8; topPadding: 6; bottomPadding: 6
                    background: Rectangle { radius: 7; color: threadRow.hovered ? hoverSurface : "transparent"; border.width: threadRow.visualFocus ? 2 : 0; border.color: accent }
                    contentItem: ColumnLayout {
                        spacing: 1
                        Label { text: threadRow.modelData.title || t("Conversa"); textFormat: Text.PlainText; color: ink; font.pixelSize: 13; elide: Text.ElideRight; Layout.fillWidth: true }
                        Label { text: shortDate(threadRow.modelData.updatedAt); textFormat: Text.PlainText; color: muted; font.pixelSize: 11 }
                    }
                    onClicked: askPanel.openThread(modelData.id)
                }
            }
        }

        // The conversation.
        ListView {
            id: messageList
            objectName: "askMessages"
            visible: !askPanel.threadsOpen
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: 14
            topMargin: 12; bottomMargin: 12
            leftMargin: 14; rightMargin: 14
            model: askPanel.messages
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar {}
            onCountChanged: Qt.callLater(function(){ messageList.positionViewAtEnd() })
            header: ColumnLayout {
                width: messageList.width - 28
                spacing: 8
                visible: !askPanel.messages.length && !askPanel.live
                height: visible ? implicitHeight : 0
                Label { text: askPanel.scope.kind === "meeting" ? t("Pergunte sobre esta reunião. Cada resposta mostra de onde veio.") : t("Pergunte sobre suas reuniões. Cada resposta mostra de onde veio."); textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                Flow {
                    Layout.fillWidth: true
                    spacing: 6
                    Repeater {
                        model: askPanel.suggestions()
                        delegate: FtButton { required property var modelData; compact: true; variant: "outline"; text: modelData; implicitHeight: 30; enabled: backend.available && !askPanel.busy; onClicked: askPanel.ask(modelData, null) }
                    }
                    Repeater {
                        model: askPanel.suggestedRecipes()
                        delegate: FtButton { required property var modelData; objectName: "askRecipeSuggestion-" + modelData.id; compact: true; variant: "ghost"; iconName: "slash"; text: modelData.name; implicitHeight: 30; enabled: backend.available && !askPanel.busy; onClicked: askPanel.runRecipe(modelData) }
                    }
                }
            }
            delegate: Item {
                id: messageItem
                required property var modelData
                required property int index
                objectName: "askMessage-" + index
                width: messageList.width - 28
                implicitHeight: modelData.role === "user" ? userBubble.height : answerBlock.implicitHeight
                Rectangle {
                    id: userBubble
                    visible: messageItem.modelData.role === "user"
                    anchors.right: parent.right
                    width: Math.min(parent.width * 0.86, userText.implicitWidth + 24)
                    height: userText.implicitHeight + 16
                    radius: 12
                    color: surfaceAlt
                    border.width: 1; border.color: divider
                    Label { id: userText; anchors.fill: parent; anchors.margins: 8; anchors.leftMargin: 12; anchors.rightMargin: 12; text: messageItem.modelData.text; textFormat: Text.PlainText; wrapMode: Text.Wrap; color: ink; font.pixelSize: 14; font.weight: messageItem.modelData.recipeId ? Font.DemiBold : Font.Normal }
                }
                Answer { id: answerBlock; visible: messageItem.modelData.role !== "user"; width: parent.width; message: messageItem.modelData; index: messageItem.index }
            }
            footer: ColumnLayout {
                width: messageList.width - 28
                spacing: 10
                Item { implicitHeight: 4 }
                Answer {
                    objectName: "askLive"
                    visible: !!askPanel.live
                    Layout.fillWidth: true
                    message: askPanel.live || ({})
                    index: askPanel.messages.length
                    streaming: !!askPanel.live && askPanel.live.status === "running"
                    onMessageChanged: Qt.callLater(function(){ messageList.positionViewAtEnd() })
                }
                Label { visible: askPanel.plan.truncated === true && askPanel.messages.length > 0; text: t("Algumas reuniões ficaram de fora por causa do tamanho."); textFormat: Text.PlainText; color: muted; font.pixelSize: 11; wrapMode: Text.WordWrap; Layout.fillWidth: true }
            }
        }

        // Under the conversation and above the input, so they are never below the fold of a long
        // conversation: "Preparando…", the consent (once per conversation for a destination outside this
        // computer) and a problem that stopped the question.
        ColumnLayout {
            objectName: "askCards"
            visible: (askPanel.planning && !askPanel.live) || !!askPanel.waiting || askPanel.problem !== ""
            Layout.fillWidth: true
            Layout.leftMargin: 12; Layout.rightMargin: 12; Layout.topMargin: 4
            spacing: 8
            RowLayout {
                visible: askPanel.planning && !askPanel.live
                spacing: 8
                BusyIndicator { running: parent.visible; implicitWidth: 22; implicitHeight: 22 }
                Label { text: t("Preparando…"); color: muted; font.pixelSize: 12 }
            }
            // Consent, inline, once per conversation for a destination outside this computer.
            Rectangle {
                id: askConsentCard
                objectName: "askConsentCard"
                visible: !!askPanel.waiting
                Layout.fillWidth: true
                implicitHeight: consentColumn.implicitHeight + 24
                radius: 10
                color: warningSoft
                border.width: 1; border.color: warningColor
                ColumnLayout {
                    id: consentColumn
                    anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 12
                    spacing: 8
                    Label {
                        objectName: "askConsentText"
                        Layout.fillWidth: true
                        text: askPanel.waiting ? (askPanel.planMeetingCount() === 1 ? tf("Para responder, vou enviar trechos de 1 reunião (≈ %1 mil caracteres) para %2.", Math.max(1, Math.round(Number(askPanel.plan.contextCharacters || 0) / 1000)), askPanel.destinationLabel())
                            : tf("Para responder, vou enviar trechos de %1 reuniões (≈ %2 mil caracteres) para %3.", askPanel.planMeetingCount(), Math.max(1, Math.round(Number(askPanel.plan.contextCharacters || 0) / 1000)), askPanel.destinationLabel())) + " " + t("Você confirma uma vez por conversa.") : ""
                        textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: ink; font.pixelSize: 13
                    }
                    RowLayout {
                        spacing: 8
                        // The card goes once answered: the focus goes back to the question, like Cancelar, never nowhere.
                        FtButton { id: askConsentAccept; objectName: "askConsentAccept"; compact: true; variant: "primary"; iconName: "send"; text: t("Enviar"); enabled: backend.available; onClicked: { askPanel.acceptConsent(); askInput.forceActiveFocus() } }
                        FtButton { id: askConsentCancel; objectName: "askConsentCancel"; compact: true; variant: "outline"; text: t("Cancelar"); onClicked: { askPanel.restore(askPanel.waiting); askPanel.waiting = null; askInput.forceActiveFocus() } }
                    }
                }
            }
            Rectangle {
                objectName: "askProblem"
                Accessible.role: Accessible.AlertMessage
                Accessible.name: askPanel.problem
                visible: askPanel.problem !== ""
                Layout.fillWidth: true
                implicitHeight: problemColumn.implicitHeight + 20
                radius: 10
                color: surfaceAlt
                border.width: 1; border.color: divider
                ColumnLayout {
                    id: problemColumn
                    anchors.left: parent.left; anchors.right: parent.right; anchors.top: parent.top; anchors.margins: 10
                    spacing: 8
                    Label { Layout.fillWidth: true; text: askPanel.problem; textFormat: Text.PlainText; wrapMode: Text.WordWrap; color: ink; font.pixelSize: 13 }
                    // Who answers is set in Settings › Perguntar e receitas: open it there.
                    FtButton { id: askConfigure; objectName: "askConfigure"; compact: true; variant: "outline"; iconName: "settings"; text: t("Configurar…"); enabled: backend.available; onClicked: settingsDialog.openSection(11) }
                }
            }
        }

        // Recipes while typing "/", then the input.
        RecipePicker {
            id: recipeList
            visible: askPanel.recipeMode
            Layout.fillWidth: true
            Layout.leftMargin: 12; Layout.rightMargin: 12
            recipes: askPanel.recipes
            filter: askInput.text.slice(1)
            meetingScope: askPanel.scope.kind === "meeting"
            onChosen: recipe => askPanel.runRecipe(recipe)
        }
        Rectangle {
            Layout.fillWidth: true
            Layout.margins: 12
            implicitHeight: Math.min(140, askInput.implicitHeight + 16)
            radius: 10
            color: fieldSurface
            border.width: askInput.activeFocus ? 2 : 1
            border.color: askInput.activeFocus ? accent : divider
            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 10; anchors.rightMargin: 6
                spacing: 6
                ScrollView {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    TextArea {
                        id: askInput
                        objectName: "askInput"
                        placeholderText: feature("recipes") ? t("Pergunte qualquer coisa · / para receitas") : t("Pergunte qualquer coisa")
                        wrapMode: TextEdit.Wrap
                        textFormat: TextEdit.PlainText
                        color: ink
                        font.pixelSize: 14
                        background: Item {}
                        enabled: backend.available
                        Accessible.name: t("Pergunta")
                        // Tab goes on to Enviar (and Shift+Tab back): it never types a tab character here.
                        Keys.onTabPressed: event => { const next = nextItemInFocusChain(true); if (next) next.forceActiveFocus(Qt.TabFocusReason); event.accepted = true }
                        Keys.onBacktabPressed: event => { const previous = nextItemInFocusChain(false); if (previous) previous.forceActiveFocus(Qt.BacktabFocusReason); event.accepted = true }
                        Keys.onPressed: event => {
                            if (askPanel.recipeMode && (event.key === Qt.Key_Down || event.key === Qt.Key_Up)) { recipeList.move(event.key === Qt.Key_Down ? 1 : -1); event.accepted = true; return }
                            if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && !(event.modifiers & Qt.ShiftModifier)) { askPanel.submit(); event.accepted = true }
                        }
                    }
                }
                FtButton {
                    objectName: askPanel.runId ? "askStop" : "askSend"
                    Layout.alignment: Qt.AlignBottom
                    Layout.bottomMargin: 6
                    iconOnly: true; compact: true
                    variant: askPanel.runId ? "danger" : "primary"
                    iconName: askPanel.runId ? "stop" : "send"
                    text: askPanel.runId ? t("Parar") : t("Enviar")
                    enabled: askPanel.runId ? true : backend.available && !askPanel.busy && (askInput.text.trim() !== "" || askPanel.recipeMode)
                    onClicked: askPanel.runId ? askPanel.stop() : askPanel.submit()
                }
            }
        }
        Label {
            Layout.fillWidth: true
            Layout.leftMargin: 14; Layout.rightMargin: 14; Layout.bottomMargin: 10
            visible: !compactLayout || askPanel.height > 520
            text: t("Enter envia · Shift+Enter quebra a linha · Esc fecha")
            textFormat: Text.PlainText; color: muted; font.pixelSize: 11; elide: Text.ElideRight
        }
    }
}
