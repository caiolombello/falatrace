import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

FtDialog {
    id:recordingTools; objectName:"recordingTools"; title:t("Gravação e processamento")
    property alias toolsScroll: toolsScroll
    anchors.centerIn:parent; width:Math.min(window.width-48,560); height:Math.min(window.height-64,620); modal:true
    closePolicy:Popup.CloseOnEscape
    contentItem:ScrollView { id:toolsScroll; clip:true; contentWidth:availableWidth
        ColumnLayout { width:toolsScroll.availableWidth; spacing:14
            Label { text:t("Confira a origem do áudio e as permissões antes de gravar. Pausar a automação não encerra uma captura em andamento."); wrapMode:Text.WordWrap; Layout.fillWidth:true; color:muted }
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
                        Label { text: t("Captura"); color: ink; font.pixelSize: 15; font.weight: Font.DemiBold; Layout.fillWidth: true }
                        FtChip { kind: captureStatus.active ? "recording" : "neutral"; text: !captureKnown ? t("Estado desconhecido") : captureStatus.active ? t("Ativa") : t("Parada") }
                    }
                    Label { textFormat: Text.PlainText; text: t(captureStatus.warning || (captureStatus.audio && captureStatus.audio.error) || "") || audioSummary(); color: captureNeedsAttention() ? warningColor : muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    Flow {
                        Layout.fillWidth: true; spacing: 8
                        FtButton { text: t("Iniciar…"); iconName: "record"; iconTint: recordingColor; enabled: backend.available && captureKnown && !captureBusy && !captureStatus.active; onClicked: { captureConsent.intent = "capture"; captureConsent.open() } }
                        FtButton { text: t("Parar"); variant: "danger"; iconName: "stop"; enabled: backend.available && captureKnown && !captureBusy && captureStatus.active; onClicked: { captureBusy = true; if (send("capture-stop", "") < 0) captureBusy = false } }
                        FtButton { text: t("Recuperar"); variant: "outline"; enabled: backend.available && captureKnown && !captureBusy && !captureStatus.active; onClicked: { captureBusy = true; if (send("capture-recover", "") < 0) captureBusy = false } ToolTip.visible: hovered; ToolTip.text: t("Finaliza uma captura interrompida sem iniciar outra.") }
                    }
                    Rectangle { Layout.fillWidth: true; Layout.preferredHeight: 1; color: divider }
                    Label { text: captureStatus.paused ? t("Automação pausada · captura atual continua") : t("Automação: confira suas regras"); color: muted; wrapMode: Text.WordWrap; Layout.fillWidth: true; font.pixelSize: 12 }
                    Flow {
                        Layout.fillWidth: true; spacing: 8
                        FtButton { text: captureStatus.paused ? t("Retomar automação…") : t("Pausar novas gravações"); iconName: captureStatus.paused ? "automation-play" : "automation-pause"; enabled: backend.available && !captureBusy; onClicked: { if (captureStatus.paused) { captureConsent.intent = "resume"; captureConsent.open() } else { captureBusy = true; if (send("automation-pause", "") < 0) captureBusy = false } } }
                        FtButton { text: t("Configurar áudio"); variant: "outline"; iconName: "tools"; enabled: backend.available && !captureBusy; onClicked: { captureBusy = true; if (send("audio-defaults", "") < 0) captureBusy = false } }
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
                        Label { text: t("Processamento"); color: ink; font.pixelSize: 15; font.weight: Font.DemiBold; Layout.fillWidth: true }
                        FtChip { text: jobs.length === 1 ? t("1 tarefa") : jobs.length + t(" tarefas") }
                    }
                    FtComboBox { id: jobPicker; Layout.fillWidth: true; model: jobs; textRole: "title"; currentIndex: jobs.findIndex(job => job.id === selectedJob.id); displayText: recordingTitle(selectedJob) || t("Selecione uma tarefa"); enabled: backend.available; onActivated: selectedJob = jobs[index] || ({}) }
                    Label { textFormat: Text.PlainText; text: selectedJob.id ? (statusText(selectedJob.state) + (selectedJob.error ? " · " + t(selectedJob.error) : "")) : t("Selecione uma tarefa"); color: selectedJob.error ? errorColor : muted; font.pixelSize: 12; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                    Label { visible: !!selectedJob.artifactStatus; text: artifactParts(selectedJob.artifactStatus).join(" · "); textFormat: Text.PlainText; color: muted; font.pixelSize: 12; wrapMode: Text.Wrap; Layout.fillWidth: true }
                    Flow {
                        Layout.fillWidth: true; spacing: 8
                        FtButton { text: t("Processar"); enabled: backend.available && !hasPending("job-process") && !hasPending("job-retry") && !!selectedJob.id && ["pending", "queued", "transferring"].includes(selectedJob.state); onClicked: send("job-process", selectedJob.id) }
                        FtButton { text: t("Repetir"); variant: "outline"; enabled: backend.available && !hasPending("job-process") && !hasPending("job-retry") && !!selectedJob.id && selectedJob.state === "failed"; onClicked: send("job-retry", selectedJob.id) }
                    }
                }
            }
        }
    }
    footer:Item { implicitHeight:64; FtButton { text:t("Fechar"); anchors.right:parent.right; anchors.rightMargin:20; anchors.verticalCenter:parent.verticalCenter; onClicked:recordingTools.close() } }
}
