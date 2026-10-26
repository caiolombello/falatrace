import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Enviar (DESIGN-STUDIO §2.12): preview exactly what is sent, then send. Copying and Obsidian stay on
// this computer and send directly; Notion, Slack and an AI app need the consent box, bound to the
// destination the preview named (the bridge refuses a send whose destination changed). The primary
// button names the act. Copies go through a hidden text field. Failures stay in this dialog.
FtDialog {
    id: shareDialog
    objectName: "shareDialog"
    // A meeting's notes (jobId), or a text (an answer, a recipe result).
    property string jobId: ""
    property string shareText: ""
    property string shareTitle: ""
    property string destination: "clipboard"
    property string include: "summary"
    property bool frontmatter: true
    property var preview: ({})
    property var statuses: ({})
    property var sendResult: null
    property string error: ""
    property int shareGeneration: 0
    property alias consent: shareConsent
    property alias previewArea: sharePreview
    readonly property bool previewing: hasSharePending("share-preview")
    readonly property bool sending: hasSharePending("share-send")
    // Fail closed, like the notes and Ask consent: only a preview that says it stays on this computer
    // (external === false) skips the consent step; anything else asks first.
    readonly property bool external: !!preview.previewId && preview.external !== false
    readonly property string aiTarget: String(preview.target || "").indexOf("ai-app:") === 0 ? String(preview.target).slice(7) : ""
    readonly property bool aiWeb: ["chatgpt-web", "claude-web", "gemini-web", "claude-desktop"].indexOf(aiTarget) >= 0
    readonly property var destinations: [
        {id: "clipboard", label: t("Copiar Markdown"), icon: "copy"},
        {id: "obsidian", label: "Obsidian", icon: "note"},
        {id: "notion", label: "Notion", icon: "external"},
        {id: "slack", label: "Slack", icon: "chat"},
        {id: "ai-app", label: statuses["ai-app"] && statuses["ai-app"].label ? statuses["ai-app"].label : t("App de IA"), icon: "spark"}
    ]
    title: jobId ? t("Enviar notas") : t("Enviar resposta")
    anchors.centerIn: parent
    width: Math.min(760, window.width - 48)
    height: Math.min(580, window.height - 48)
    modal: true
    closePolicy: sending ? Popup.NoAutoClose : Popup.CloseOnEscape

    function hasSharePending(op) { return Object.keys(pending).some(function(id){ return pending[id].op === op && pending[id].shareGeneration === shareGeneration }) }
    function openMeeting() {
        if (!feature("share") || !detail.jobId || !backend.available) return
        jobId = String(detail.jobId).toLowerCase(); shareText = ""; shareTitle = recordingTitle(selected) || selected.fileName || ""
        begin()
    }
    function openText(text, title) {
        if (!feature("share") || !String(text || "").trim() || !backend.available) return
        jobId = ""; shareText = String(text); shareTitle = String(title || "").replace(/\s+/g, " ").trim().slice(0, 200)
        begin()
    }
    function begin() {
        destination = "clipboard"; include = "summary"; statuses = ({}); sendResult = null; error = ""
        open()
        requestPreview()
    }
    function choose(id) { if (destination === id && preview.previewId) return; destination = id; requestPreview() }
    function requestPreview() {
        shareGeneration += 1; preview = ({}); sendResult = null; error = ""; shareConsent.checked = false
        const payload = {destination: destination, include: jobId ? include : "summary"}
        if (jobId) payload.jobId = jobId
        else { payload.text = shareText; payload.title = shareTitle }
        if (destination === "obsidian") payload.frontmatter = frontmatter
        if (send("share-preview", "", payload, {origin: "share", shareGeneration: shareGeneration, destination: destination}) < 0) error = t("Sem conexão com o FalaTrace.")
    }
    function sendNow() {
        if (!preview.previewId || sending || !preview.ready) return
        if (external && !shareConsent.checked) return
        error = ""; sendResult = null
        const payload = {previewId: preview.previewId}
        if (external) payload.consent = true
        if (send("share-send", "", payload, {origin: "share", shareGeneration: shareGeneration, destination: destination}) < 0) error = t("Sem conexão com o FalaTrace.")
    }
    function copyText(text) { shareClipboard.text = String(text || ""); shareClipboard.selectAll(); shareClipboard.copy(); shareClipboard.deselect() }
    function handleResponse(request, message) {
        if (request.shareGeneration !== shareGeneration) return
        if (request.op === "share-preview") {
            if (!message.ok) { error = t(message.error); return }
            preview = message.result
            const next = Object.assign({}, statuses); next[request.destination] = {ready: message.result.ready === true, label: message.result.destinationLabel || ""}; statuses = next
            return
        }
        if (!message.ok) {
            // The destination or the content changed since this preview: show the new one before anything goes.
            if (message.error === "O conteúdo mudou desde a prévia; gere a prévia de novo antes de enviar.") requestPreview()
            error = t(message.error)
            return
        }
        const value = message.result
        if (value.content !== undefined) copyText(value.content)
        if (value.url && destination === "ai-app" && value.opened !== true) Qt.openUrlExternally(value.url)
        sendResult = value
    }
    function connectionLost() { if (visible && sending) error = t("Não deu para confirmar o envio. Confira o destino antes de tentar de novo.") }
    function primaryText() {
        if (sending) return t("Enviando…")
        if (destination === "clipboard") return t("Copiar")
        if (destination === "obsidian") return t("Salvar no Obsidian")
        if (destination === "notion") return t("Enviar para o Notion")
        if (destination === "slack") return t("Enviar para o Slack")
        const label = preview.destinationLabel || t("app de IA")
        return aiWeb ? tf("Copiar e abrir o %1", label) : tf("Abrir no %1", label)
    }
    function resultText() {
        if (!sendResult) return ""
        if (destination === "clipboard") return t("Copiado. Cole onde quiser com Ctrl+V.")
        if (destination === "obsidian") return sendResult.kind === "reused" ? tf("Já estava salvo em %1", sendResult.path || "") : tf("Salvo em %1", sendResult.path || "")
        if (destination === "notion") return t("Página criada no Notion.")
        if (destination === "slack") return t("Enviado para o Slack.")
        const label = preview.destinationLabel || t("app de IA")
        return aiWeb ? tf("Copiado. Cole no %1 com Ctrl+V.", label) : tf("Aberto no %1.", label)
    }
    function openResult() {
        if (!sendResult) return
        if (sendResult.url) Qt.openUrlExternally(sendResult.url)
        else if (sendResult.path && destination === "obsidian") Qt.openUrlExternally("obsidian://open?path=" + encodeURIComponent(sendResult.path))
    }
    onOpened: shareCancel.forceActiveFocus(Qt.TabFocusReason)
    onClosed: { shareGeneration += 1; preview = ({}); sendResult = null; error = ""; shareText = ""; if (detailView.shareButton.visible) detailView.shareButton.forceActiveFocus(Qt.TabFocusReason) }

    TextEdit { id: shareClipboard; visible: false; textFormat: TextEdit.PlainText }

    contentItem: GridLayout {
        columns: compactLayout ? 1 : 2
        columnSpacing: 16
        rowSpacing: 10
        // Destinations.
        ColumnLayout {
            Layout.alignment: Qt.AlignTop
            Layout.preferredWidth: compactLayout ? -1 : 200
            Layout.fillWidth: compactLayout
            spacing: 4
            FtOverline { text: t("Para onde") }
            Flow {
                Layout.fillWidth: true
                spacing: 4
                Repeater {
                    model: shareDialog.destinations
                    delegate: ItemDelegate {
                        id: destinationRow
                        required property var modelData
                        readonly property bool chosen: shareDialog.destination === modelData.id
                        readonly property var status: shareDialog.statuses[modelData.id]
                        objectName: "shareDestination-" + modelData.id
                        width: compactLayout ? implicitWidth : 200
                        hoverEnabled: true
                        enabled: !shareDialog.sending
                        leftPadding: 10; rightPadding: 10; topPadding: 7; bottomPadding: 7
                        Accessible.role: Accessible.RadioButton
                        Accessible.checked: chosen
                        Accessible.name: modelData.label + (status ? (status.ready ? t(", pronto") : t(", configurar")) : "")
                        background: Rectangle { radius: 8; color: destinationRow.chosen ? selectedSurface : destinationRow.hovered ? hoverSurface : "transparent"; border.width: destinationRow.visualFocus ? 2 : destinationRow.chosen ? 1 : 0; border.color: destinationRow.visualFocus ? accent : divider }
                        contentItem: RowLayout {
                            spacing: 8
                            FtIcon { name: destinationRow.modelData.icon; tint: accent; size: 15 }
                            Label { text: destinationRow.modelData.label; textFormat: Text.PlainText; color: ink; font.pixelSize: 13; font.weight: destinationRow.chosen ? Font.DemiBold : Font.Normal; elide: Text.ElideRight; Layout.fillWidth: true }
                            Label { visible: !!destinationRow.status && !compactLayout; text: destinationRow.status && destinationRow.status.ready ? t("Pronto") : t("Configurar"); textFormat: Text.PlainText; color: destinationRow.status && destinationRow.status.ready ? accent : warningColor; font.pixelSize: 11 }
                        }
                        onClicked: shareDialog.choose(modelData.id)
                    }
                }
            }
        }
        // What goes, and how.
        ColumnLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 8
            RowLayout {
                Layout.fillWidth: true
                spacing: 10
                FtSegmented {
                    objectName: "shareInclude"
                    visible: !!shareDialog.jobId
                    compact: true; showIcons: false
                    accessibleName: t("O que incluir")
                    currentIndex: shareDialog.include === "summary+notes" ? 1 : shareDialog.include === "full" ? 2 : 0
                    model: [{value: 0, label: t("Notas")}, {value: 1, label: t("Notas + minhas notas"), shortLabel: t("+ minhas")}, {value: 2, label: t("Tudo, com transcrição"), shortLabel: t("Tudo")}]
                    useShortLabels: compactLayout
                    enabled: !shareDialog.sending
                    onActivated: value => { shareDialog.include = value === 1 ? "summary+notes" : value === 2 ? "full" : "summary"; shareDialog.requestPreview() }
                }
                Item { Layout.fillWidth: true }
                WrappedCheck {
                    objectName: "shareFrontmatter"
                    visible: shareDialog.destination === "obsidian"
                    Layout.fillWidth: false
                    text: t("Cabeçalho YAML")
                    checked: shareDialog.frontmatter
                    enabled: !shareDialog.sending
                    onToggled: { shareDialog.frontmatter = checked; shareDialog.requestPreview() }
                }
            }
            Rectangle {
                Layout.fillWidth: true
                Layout.fillHeight: true
                Layout.minimumHeight: 120
                radius: 10
                color: surfaceAlt
                border.width: 1; border.color: divider
                ScrollView {
                    anchors.fill: parent
                    anchors.margins: 1
                    clip: true
                    TextArea {
                        id: sharePreview
                        objectName: "sharePreview"
                        readOnly: true
                        selectByMouse: true
                        wrapMode: TextEdit.Wrap
                        textFormat: TextEdit.PlainText
                        font.family: "monospace"
                        font.pixelSize: 13
                        color: ink
                        text: shareDialog.preview.markdown || ""
                        placeholderText: shareDialog.previewing ? t("Preparando a prévia…") : ""
                        Accessible.name: t("Prévia do que será enviado")
                        background: Item {}
                    }
                }
            }
            Label {
                visible: !!shareDialog.preview.previewId
                text: (shareDialog.external ? tf("Vai para %1, fora deste computador.", shareDialog.preview.destinationLabel || "") : shareDialog.destination === "clipboard" ? t("Fica neste computador: só a área de transferência.") : tf("Fica neste computador: %1.", shareDialog.preview.destinationLabel || ""))
                    + " " + tf("%1 caracteres.", Number(shareDialog.preview.chars || 0)) + (shareDialog.preview.truncated ? " " + t("A prévia mostra só o começo.") : "")
                textFormat: Text.PlainText; color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true
            }
            RowLayout {
                visible: !!shareDialog.preview.previewId && shareDialog.preview.ready !== true
                Layout.fillWidth: true
                spacing: 8
                FtIcon { name: "settings"; tint: warningColor; size: 15 }
                Label { objectName: "shareProblem"; Layout.fillWidth: true; text: t(shareDialog.preview.problem || "") || t("Este destino ainda não está configurado."); textFormat: Text.PlainText; color: ink; font.pixelSize: 13; wrapMode: Text.WordWrap }
                FtButton { compact: true; variant: "outline"; text: t("Configurar…"); onClicked: { shareDialog.close(); settingsDialog.open() } }
            }
            WrappedCheck {
                id: shareConsent
                objectName: "shareConsent"
                visible: shareDialog.external && shareDialog.preview.ready === true
                enabled: !shareDialog.sending && !shareDialog.sendResult
                text: (shareDialog.jobId ? tf("Enviar estas notas para %1 (fora deste computador)", shareDialog.preview.destinationLabel || "") : tf("Enviar esta resposta para %1 (fora deste computador)", shareDialog.preview.destinationLabel || ""))
                    + (shareDialog.include === "full" && shareDialog.jobId ? " · " + t("inclui a transcrição completa") : "")
                Accessible.name: text
            }
            RowLayout {
                objectName: "shareResult"
                visible: !!shareDialog.sendResult
                Layout.fillWidth: true
                spacing: 8
                FtIcon { name: "check"; tint: accent; size: 16 }
                Label { objectName: "shareResultText"; Layout.fillWidth: true; text: shareDialog.resultText(); textFormat: Text.PlainText; color: ink; font.pixelSize: 13; wrapMode: Text.WrapAnywhere }
                FtButton { visible: !!shareDialog.sendResult && (!!shareDialog.sendResult.url || (!!shareDialog.sendResult.path && shareDialog.destination === "obsidian")); compact: true; variant: "outline"; iconName: "external"; text: t("Abrir"); onClicked: shareDialog.openResult() }
            }
            Label { objectName: "shareError"; visible: !!shareDialog.error; text: shareDialog.error; textFormat: Text.PlainText; color: errorColor; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true }
        }
    }
    footer: Item {
        implicitHeight: 64
        RowLayout {
            anchors.fill: parent; anchors.leftMargin: 20; anchors.rightMargin: 20
            spacing: 10
            BusyIndicator { visible: shareDialog.previewing || shareDialog.sending; running: visible; implicitWidth: 24; implicitHeight: 24 }
            Item { Layout.fillWidth: true }
            FtButton { id: shareCancel; objectName: "shareCancel"; variant: "outline"; text: shareDialog.sendResult ? t("Fechar") : t("Cancelar"); enabled: !shareDialog.sending; onClicked: shareDialog.close() }
            FtButton {
                objectName: "shareSend"
                visible: !shareDialog.sendResult
                variant: "primary"
                iconName: shareDialog.destination === "clipboard" ? "copy" : "send"
                text: shareDialog.primaryText()
                enabled: backend.available && !!shareDialog.preview.previewId && shareDialog.preview.ready === true && !shareDialog.sending && (!shareDialog.external || shareConsent.checked)
                onClicked: shareDialog.sendNow()
            }
        }
    }
}
