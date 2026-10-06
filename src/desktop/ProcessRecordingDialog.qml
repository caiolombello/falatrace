import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Transcribe and summarise one recording on request. The plan names every destination
// before anything happens; the bridge queues only the exact plan confirmed here (its
// consent key), so a changed file or configuration asks again.
FtDialog {
    id:processDialog; objectName:"processDialog"; title:"Processar gravação"
    anchors.centerIn:parent; width:Math.min(window.width-48,600); modal:true
    closePolicy:busy?Popup.NoAutoClose:Popup.CloseOnEscape
    property alias processConsent: processConsent
    property alias processRun: processRun
    property int processGeneration: 0
    property string recordingKey: ""
    property var plan: ({})
    property string error: ""
    readonly property bool busy: hasProcessPending("recording-process")
    readonly property bool planning: hasProcessPending("recording-process-plan")
    readonly property bool ready: !!plan.consentKey && plan.action !== "none"
    readonly property bool external: !!plan.transcription && !!plan.summary && (plan.transcription.external === true || plan.summary.external === true)

    function hasProcessPending(op) { return Object.keys(pending).some(function(id){ return pending[id].op === op && pending[id].processGeneration === processDialog.processGeneration }) }
    function load() {
        plan = ({}); error = ""; processConsent.checked = false
        if (send("recording-process-plan", recordingKey, ({}), { processGeneration: processGeneration }) < 0) error = "Serviço indisponível. Reconecte e tente de novo."
    }
    function run() {
        if (!ready || !processConsent.checked || busy) return
        error = ""
        send("recording-process", recordingKey, { consent: true, consentKey: plan.consentKey }, { processGeneration: processGeneration })
    }
    function actionText() {
        return plan.action === "create" ? "Criar o processamento desta gravação"
            : plan.action === "retry" ? "Repetir o processamento que falhou"
            : plan.action === "queue" ? "Processar agora a gravação que está na fila" : "Nada a fazer"
    }
    function durationText() {
        if (plan.durationSeconds === null || plan.durationSeconds === undefined) return ""
        const minutes = Math.max(1, Math.round(plan.durationSeconds / 60))
        return "Duração: cerca de " + minutes + (minutes === 1 ? " minuto." : " minutos.")
    }
    function destinationText(destination) { return destination ? destination.where + " · " + destination.provider + "/" + destination.model : "" }
    function resultNotice(result) {
        if (result.warning) return result.warning
        if (result.status === "completed") return "Esta gravação já estava processada."
        if (result.status === "active") return "O processamento desta gravação já está em andamento."
        return (result.created ? "Processamento criado e iniciado." : "Processamento iniciado.") + " Acompanhe em Gravação e tarefas."
    }
    function handleResponse(req, message) {
        if (req.op === "recording-process") {
            // A queued job is reported even when the dialog moved on: it is a real side effect.
            if (message.ok) { notice = resultNotice(message.result); send("jobs-list", ""); if (!hasPending("list")) send("list", "") }
            if (req.processGeneration !== processGeneration || !visible) { if (!message.ok) errorText = message.error; return }
            if (message.ok) close()
            else { error = message.error; processConsent.checked = false }
            return
        }
        if (req.processGeneration !== processGeneration || !visible) return
        if (!message.ok) { error = message.error; return }
        plan = message.result
    }

    onOpened:{ processGeneration += 1; recordingKey = selected.key || ""; load(); processCancel.forceActiveFocus(Qt.TabFocusReason) }
    onClosed:{ processGeneration += 1; plan = ({}); error = ""; processConsent.checked = false; if (processButton.visible) processButton.forceActiveFocus(Qt.TabFocusReason) }

    contentItem:ColumnLayout {
        spacing:10
        Label { visible:processDialog.planning; text:"Preparando o plano…"; color:muted; Layout.fillWidth:true }
        Label { objectName:"processReason"; visible:!!processDialog.plan.reason; text:processDialog.plan.reason || ""; textFormat:Text.PlainText; wrapMode:Text.WordWrap; color:ink; font.weight:Font.DemiBold; Layout.fillWidth:true }
        ColumnLayout {
            visible:!!processDialog.plan.transcription; spacing:8; Layout.fillWidth:true
            Label { text:processDialog.actionText() + (processDialog.plan.target === "remote" ? ", no worker remoto." : ", neste computador."); visible:processDialog.ready; textFormat:Text.PlainText; wrapMode:Text.WordWrap; color:muted; Layout.fillWidth:true }
            Label { text:processDialog.durationText(); visible:text !== ""; textFormat:Text.PlainText; color:muted; Layout.fillWidth:true }
            Repeater {
                model:[{ label:"Transcrição", destination:processDialog.plan.transcription }, { label:"Resumo", destination:processDialog.plan.summary }]
                RowLayout {
                    required property var modelData
                    Layout.fillWidth:true; spacing:10
                    ColumnLayout {
                        Layout.fillWidth:true; spacing:2
                        Label { text:modelData.label; color:ink; font.weight:Font.DemiBold }
                        Label { objectName:"processDestination-" + modelData.label; text:processDialog.destinationText(modelData.destination); textFormat:Text.PlainText; wrapMode:Text.WrapAnywhere; color:muted; Layout.fillWidth:true }
                    }
                    FtChip { Layout.alignment:Qt.AlignTop; text:modelData.destination && modelData.destination.external ? "Sai deste computador" : "Fica neste computador"; kind:modelData.destination && modelData.destination.external ? "warning" : "accent" }
                }
            }
            Label {
                visible:processDialog.ready && processDialog.external
                text:"O áudio ou o texto desta gravação será enviado aos destinos marcados acima, com as chaves e endereços da configuração atual."
                textFormat:Text.PlainText; wrapMode:Text.WordWrap; color:warningColor; Layout.fillWidth:true
            }
            Label {
                visible:processDialog.ready
                text:"O original é preservado. O resumo é gerado por modelo e precisa de revisão da fonte."
                textFormat:Text.PlainText; wrapMode:Text.WordWrap; color:muted; Layout.fillWidth:true
            }
        }
        Label { objectName:"processError"; visible:!!processDialog.error; text:processDialog.error; textFormat:Text.PlainText; wrapMode:Text.WordWrap; color:errorColor; Layout.fillWidth:true }
        WrappedCheck {
            id:processConsent; objectName:"processConsent"
            visible:processDialog.ready
            enabled:processDialog.ready && !processDialog.busy
            text:"Tenho a permissão das pessoas gravadas e autorizo este processamento com os destinos acima."
            Accessible.name:text
        }
    }
    footer:Item {
        implicitHeight:64
        RowLayout {
            anchors.fill:parent; anchors.leftMargin:20; anchors.rightMargin:20; spacing:10
            FtButton { visible:!!processDialog.error; compact:true; variant:"ghost"; iconName:"refresh"; text:"Revisar de novo"; enabled:backend.available && !processDialog.planning && !processDialog.busy; onClicked:processDialog.load() }
            Item { Layout.fillWidth:true }
            FtButton { id:processCancel; objectName:"processCancel"; text:"Cancelar"; variant:"outline"; enabled:!processDialog.busy; onClicked:processDialog.close() }
            FtButton { id:processRun; objectName:"processRun"; text:processDialog.busy ? "Enviando…" : "Processar agora"; variant:"primary"; iconName:"spark"; enabled:backend.available && processDialog.ready && processConsent.checked && !processDialog.busy; onClicked:processDialog.run() }
        }
    }
}
