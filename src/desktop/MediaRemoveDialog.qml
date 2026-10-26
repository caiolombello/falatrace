import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// "Remover mídia agora…" (DESIGN-STUDIO §2.16): checks first what can go (media-plan, then
// media-status: the media is hashed, so it is start + poll), offers "Só o áudio" or "Só o texto" with
// what each keeps and frees, says whether other copies stay, and removes only after an explicit
// confirmation (media-remove with the plan's consentKey, then media-status). Cancel has the focus;
// nothing is removed by Enter. Failures stay in this dialog.
FtDialog {
    id: mediaRemoveDialog
    objectName: "mediaRemoveDialog"
    property string recordingKey: ""
    property string recordingTitleText: ""
    // "" · planning · ready · removing · failed
    property string stage: ""
    property var plan: ({})
    property string requestId: ""
    property string mode: ""
    property string error: ""
    property int mediaGeneration: 0
    property alias consent: mediaRemoveConsent
    readonly property var options: asList(plan.options)
    readonly property var chosenOption: { for (const option of options) if (option.mode === mode) return option; return null }
    title: t("Remover mídia")
    anchors.centerIn: parent
    width: Math.min(560, window.width - 48)
    modal: true
    closePolicy: stage === "removing" ? Popup.NoAutoClose : Popup.CloseOnEscape

    function sizeText(bytes) {
        const value = Number(bytes)
        if (!(value > 0)) return ""
        const gb = value / 1e9, mb = value / 1e6
        const number = function(n) { const text = n.toFixed(n >= 10 ? 0 : 1); return uiLanguage === "en" ? text : text.replace(".", ",") }
        return gb >= 1 ? tf("%1 GB", number(gb)) : tf("%1 MB", number(Math.max(0.1, mb)))
    }
    function start() {
        mediaGeneration += 1; recordingKey = selected.key || ""; recordingTitleText = recordingTitle(selected) || selected.fileName || ""
        stage = "planning"; plan = ({}); requestId = ""; mode = ""; error = ""; mediaRemoveConsent.checked = false
        if (send("media-plan", recordingKey, ({}), {origin: "media", mediaGeneration: mediaGeneration}) < 0) { stage = "failed"; error = t("Sem conexão com o FalaTrace.") }
    }
    function remove() {
        if (stage !== "ready" || !chosenOption || chosenOption.eligible !== true || !mediaRemoveConsent.checked || !backend.available) return
        stage = "removing"; error = ""; requestId = ""
        if (send("media-remove", recordingKey, {mode: mode, consentKey: plan.consentKey}, {origin: "media", mediaGeneration: mediaGeneration}) < 0) { stage = "failed"; error = t("Sem conexão com o FalaTrace.") }
    }
    Timer {
        interval: 500; repeat: true
        running: mediaRemoveDialog.requestId !== "" && (mediaRemoveDialog.stage === "planning" || mediaRemoveDialog.stage === "removing") && backend.available
        onTriggered: { if (!hasPending("media-status")) send("media-status", "", {requestId: mediaRemoveDialog.requestId}, {origin: "media", mediaGeneration: mediaRemoveDialog.mediaGeneration}) }
    }
    function handleResponse(request, message) {
        // A removal answered after the dialog closed is still a real change: the library is read again.
        if (request.mediaGeneration !== mediaGeneration) { if (message.ok && message.result && message.result.removed === true) refreshLibrary(); return }
        if (!message.ok) { stage = "failed"; error = t(message.error); requestId = ""; return }
        const result = message.result
        if (request.op === "media-plan" || request.op === "media-remove") { requestId = result.requestId || ""; return }
        if (result.status === "running") return
        requestId = ""
        if (result.status === "failed") { stage = "failed"; error = t(result.error || "") || t("Não deu para remover a mídia."); return }
        if (result.kind === "plan") {
            plan = result; stage = "ready"
            const eligible = asList(result.options).filter(function(option){ return option.eligible === true })
            mode = eligible.length ? eligible[0].mode : ""
            return
        }
        // Removed: notes, transcript and questions keep working; the library shows the new state.
        close()
        toast.show(result.mode === "audio-only" ? t("Vídeo removido. O áudio, as notas e a transcrição continuam.") : t("Mídia removida. Notas, transcrição e perguntas continuam."), "", null)
        refreshLibrary()
        if (selected.key === request.key || selected.key === recordingKey) { detailLoading = true; send("detail", selected.key) }
    }
    function connectionLost() {
        if (stage === "removing") { stage = "failed"; error = t("Não deu para confirmar a remoção. Confira a gravação depois de reconectar.") }
        else if (stage === "planning") { stage = "failed"; error = t("Sem conexão com o FalaTrace.") }
        requestId = ""
    }
    onOpened: { start(); mediaRemoveCancel.forceActiveFocus(Qt.TabFocusReason) }
    onClosed: { if (stage !== "removing") { mediaGeneration += 1; stage = ""; requestId = "" } }

    contentItem: ColumnLayout {
        spacing: 10
        Label { text: mediaRemoveDialog.recordingTitleText; visible: text !== ""; textFormat: Text.PlainText; color: muted; font.pixelSize: 13; elide: Text.ElideRight; Layout.fillWidth: true }
        RowLayout {
            visible: mediaRemoveDialog.stage === "planning"
            spacing: 10
            BusyIndicator { running: parent.visible; implicitWidth: 24; implicitHeight: 24 }
            Label { text: t("Conferindo a gravação, os backups e o que pode sair…"); textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true }
        }
        // Nothing can go now: why.
        ColumnLayout {
            visible: mediaRemoveDialog.stage === "ready" && mediaRemoveDialog.plan.eligible !== true
            Layout.fillWidth: true
            spacing: 4
            Label { text: t("Agora não dá para remover a mídia desta gravação."); textFormat: Text.PlainText; color: ink; font.pixelSize: 14; font.weight: Font.Medium; wrapMode: Text.WordWrap; Layout.fillWidth: true }
            Repeater { model: asList(mediaRemoveDialog.plan.reasons); Label { required property var modelData; text: "– " + t(modelData); textFormat: Text.PlainText; color: muted; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true } }
        }
        // The choices, with what each keeps.
        Repeater {
            model: mediaRemoveDialog.stage === "ready" || mediaRemoveDialog.stage === "removing" || mediaRemoveDialog.stage === "failed" ? mediaRemoveDialog.options : []
            delegate: ItemDelegate {
                id: optionRow
                required property var modelData
                readonly property bool chosen: mediaRemoveDialog.mode === modelData.mode
                objectName: "mediaOption-" + modelData.mode
                Layout.fillWidth: true
                enabled: modelData.eligible === true && mediaRemoveDialog.stage === "ready"
                hoverEnabled: true
                leftPadding: 12; rightPadding: 12; topPadding: 10; bottomPadding: 10
                Accessible.role: Accessible.RadioButton
                Accessible.checked: chosen
                Accessible.name: optionTitle.text + ". " + optionBody.text
                background: Rectangle { radius: 10; color: optionRow.chosen ? selectedSurface : optionRow.hovered ? hoverSurface : surfaceAlt; border.width: optionRow.visualFocus ? 2 : 1; border.color: optionRow.visualFocus || optionRow.chosen ? accent : divider; opacity: optionRow.enabled || optionRow.chosen ? 1 : 0.6 }
                contentItem: RowLayout {
                    spacing: 10
                    Rectangle {
                        Layout.alignment: Qt.AlignTop; Layout.topMargin: 2
                        implicitWidth: 16; implicitHeight: 16; radius: 8
                        color: "transparent"; border.width: 2; border.color: optionRow.chosen ? accent : dividerStrong
                        Rectangle { anchors.centerIn: parent; width: 8; height: 8; radius: 4; color: accent; visible: optionRow.chosen }
                    }
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 3
                        RowLayout {
                            spacing: 8
                            Label { id: optionTitle; text: optionRow.modelData.mode === "audio-only" ? t("Só o áudio") : t("Só o texto"); textFormat: Text.PlainText; color: ink; font.pixelSize: 14; font.weight: Font.DemiBold }
                            Label { visible: text !== ""; text: optionRow.modelData.mode === "audio-only" ? t("libera o espaço do vídeo") : mediaRemoveDialog.sizeText(optionRow.modelData.bytesFreed) ? tf("libera %1", mediaRemoveDialog.sizeText(optionRow.modelData.bytesFreed)) : ""; textFormat: Text.PlainText; color: accent; font.pixelSize: 12 }
                        }
                        Label {
                            id: optionBody
                            Layout.fillWidth: true
                            text: optionRow.modelData.mode === "audio-only" ? t("Sem vídeo nem quadros. Ouvir, identificar falantes e refazer a transcrição continuam.") : t("Sem ouvir, sem nova identificação de falantes e sem refazer a transcrição. Notas, transcrição, perguntas e envio continuam.")
                            textFormat: Text.PlainText; color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap
                        }
                        Repeater { model: optionRow.modelData.eligible === true ? [] : asList(optionRow.modelData.reasons).slice(0, 2); Label { required property var modelData; text: t(modelData); textFormat: Text.PlainText; color: warningColor; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true } }
                    }
                }
                onClicked: mediaRemoveDialog.mode = modelData.mode
            }
        }
        Label {
            visible: (mediaRemoveDialog.stage === "ready" || mediaRemoveDialog.stage === "removing") && mediaRemoveDialog.plan.eligible === true
            text: mediaRemoveDialog.plan.scope === "total" ? t("Não há outra cópia verificada desta gravação: a mídia some de vez.") : t("As cópias no Proton Drive e no outro computador continuam.")
            textFormat: Text.PlainText; color: mediaRemoveDialog.plan.scope === "total" ? warningColor : muted; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true
        }
        Label {
            visible: mediaRemoveDialog.stage === "ready" && mediaRemoveDialog.plan.legacyTranscript === true
            text: t("A transcrição desta gravação não tem recibo de verificação; ela continua aqui como está.")
            textFormat: Text.PlainText; color: muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true
        }
        WrappedCheck {
            id: mediaRemoveConsent
            objectName: "mediaRemoveConsent"
            visible: (mediaRemoveDialog.stage === "ready" || mediaRemoveDialog.stage === "removing") && mediaRemoveDialog.plan.eligible === true
            enabled: mediaRemoveDialog.stage === "ready" && !!mediaRemoveDialog.chosenOption && mediaRemoveDialog.chosenOption.eligible === true
            text: t("Entendo que não dá para desfazer.")
            Accessible.name: text
        }
        RowLayout {
            visible: mediaRemoveDialog.stage === "removing"
            spacing: 10
            BusyIndicator { running: parent.visible; implicitWidth: 24; implicitHeight: 24 }
            Label { text: mediaRemoveDialog.mode === "audio-only" ? t("Guardando o áudio e removendo o vídeo…") : t("Removendo a mídia…"); textFormat: Text.PlainText; color: muted; font.pixelSize: 13 }
        }
        Label { objectName: "mediaRemoveError"; visible: !!mediaRemoveDialog.error; text: mediaRemoveDialog.error; textFormat: Text.PlainText; color: errorColor; font.pixelSize: 13; wrapMode: Text.WordWrap; Layout.fillWidth: true }
    }
    footer: Item {
        implicitHeight: 64
        RowLayout {
            anchors.fill: parent; anchors.leftMargin: 20; anchors.rightMargin: 20
            spacing: 10
            FtButton { visible: mediaRemoveDialog.stage === "failed"; compact: true; variant: "ghost"; iconName: "refresh"; text: t("Conferir de novo"); enabled: backend.available; onClicked: mediaRemoveDialog.start() }
            Item { Layout.fillWidth: true }
            FtButton { id: mediaRemoveCancel; objectName: "mediaRemoveCancel"; variant: "outline"; text: t("Cancelar"); enabled: mediaRemoveDialog.stage !== "removing"; onClicked: mediaRemoveDialog.close() }
            FtButton {
                objectName: "mediaRemoveConfirm"
                variant: "danger"
                iconName: "trash"
                text: mediaRemoveDialog.stage === "removing" ? t("Removendo…") : t("Remover mídia")
                enabled: backend.available && mediaRemoveDialog.stage === "ready" && !!mediaRemoveDialog.chosenOption && mediaRemoveDialog.chosenOption.eligible === true && mediaRemoveConsent.checked
                onClicked: mediaRemoveDialog.remove()
            }
        }
    }
}
