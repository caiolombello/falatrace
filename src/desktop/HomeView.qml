import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Home: what is in the library (moved verbatim from Main.qml).
Flickable {
    id: homeView
    objectName: "homeView"
    anchors.fill: parent
    visible: currentView === "home"
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
            Label { text: t("Sua biblioteca"); color: ink; font.pixelSize: compactLayout ? 22 : 26; font.weight: Font.DemiBold }
            Label { text: t("Escolha uma gravação para assistir, revisar a transcrição e consultar o contexto com a origem ao lado."); color: muted; font.pixelSize: 14; wrapMode: Text.WordWrap; Layout.fillWidth: true }
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
                Label { Layout.fillWidth: true; text: backend.available ? t(errorText) : t("O serviço da biblioteca está desconectado. Nada foi apagado; reconecte para continuar."); textFormat: Text.PlainText; color: ink; wrapMode: Text.WordWrap }
                FtButton { text: backend.available ? t("Tentar novamente") : t("Reconectar"); compact: true; onClicked: { if (backend.available) { loading = true; send("list", "") } else backend.reconnect() } }
            }
        }
        RowLayout {
            visible: loading && backend.available
            spacing: 10
            BusyIndicator { running: parent.visible; implicitWidth: 28; implicitHeight: 28 }
            Label { text: t("Carregando a biblioteca…"); color: muted }
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
                Label { text: t("Nenhuma gravação ainda"); color: ink; font.pixelSize: 18; font.weight: Font.DemiBold; Layout.alignment: Qt.AlignHCenter }
                Label { text: t("As gravações aparecem aqui depois de uma captura manual ou de uma regra de gravação automática que você ativar. Nada é gravado sem a sua configuração ou confirmação."); color: muted; wrapMode: Text.WordWrap; horizontalAlignment: Text.AlignHCenter; Layout.fillWidth: true }
                RowLayout {
                    Layout.alignment: Qt.AlignHCenter
                    spacing: 10
                    FtButton { text: t("Gravação e tarefas…"); iconName: "tools"; onClicked: recordingTools.open() }
                    FtButton { text: t("Configurações…"); iconName: "settings"; variant: "outline"; enabled: backend.available; onClicked: settingsDialog.open() }
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
                    {label: t("Gravações"), value: libraryStats.total, kind: "neutral"},
                    {label: t("Com transcrição"), value: libraryStats.transcripts, kind: "accent"},
                    {label: t("Em processamento"), value: libraryStats.active, kind: "warning"},
                    {label: t("Precisam de atenção"), value: libraryStats.attention, kind: "danger"}
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
        Label { visible: items.length > 0; text: t("Recentes"); color: ink; font.pixelSize: 16; font.weight: Font.DemiBold; Layout.topMargin: 4 }
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
                    Accessible.name: recordingTitle(modelData) + ", " + origin(modelData.location) + ", " + statusText(modelData.status)
                    background: Rectangle {
                        radius: 12
                        color: recentCard.hovered ? hoverSurface : surface
                        border.width: recentCard.visualFocus ? 2 : 1
                        border.color: recentCard.visualFocus ? accent : divider
                    }
                    contentItem: ColumnLayout {
                        spacing: 8
                        Label { text: recordingTitle(modelData); textFormat: Text.PlainText; color: ink; font.pixelSize: 15; font.weight: Font.DemiBold; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight; Layout.fillWidth: true }
                        Label { text: longDate(modelData.modifiedAt) + " · " + origin(modelData.location); textFormat: Text.PlainText; color: modelData.location === "missing" ? warningColor : muted; font.pixelSize: 12; elide: Text.ElideRight; Layout.fillWidth: true }
                        Flow {
                            Layout.fillWidth: true
                            spacing: 6
                            FtChip { kind: statusKind(modelData.status); text: statusText(modelData.status) }
                            Repeater {
                                model: artifactChips(modelData.artifactStatus)
                                FtChip { required property var modelData; kind: modelData.ready ? "accent" : "neutral"; iconName: modelData.ready ? "check" : ""; text: modelData.text }
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
                    Label { text: t("Antes de gravar"); color: ink; font.pixelSize: 15; font.weight: Font.DemiBold }
                }
                Label { text: t("Confira as regras de detecção, as fontes de áudio e para onde o processamento vai. Confirme a permissão das pessoas envolvidas; pausar a automação não encerra uma captura em andamento."); color: muted; wrapMode: Text.WordWrap; Layout.fillWidth: true }
                Flow {
                    Layout.fillWidth: true
                    spacing: 8
                    FtButton { text: t("Gravação e tarefas…"); iconName: "tools"; onClicked: recordingTools.open() }
                    FtButton { text: t("Configurações…"); iconName: "settings"; variant: "outline"; onClicked: settingsDialog.open() }
                }
            }
        }
    }
}
