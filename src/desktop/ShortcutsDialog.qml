import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// The keyboard shortcuts, by where they work (the ? button in the top bar, F1 or Ctrl+/).
// Closing returns the focus to where it was.
FtDialog {
    id: shortcutsDialog
    objectName: "shortcutsDialog"
    property Item opener: null
    title: t("Atalhos de teclado")
    anchors.centerIn: parent
    width: Math.min(640, window.width - 48)
    height: Math.min(window.height - 48, 640)
    modal: true
    closePolicy: Popup.CloseOnEscape
    readonly property var groups: [
        {title: t("Em qualquer lugar"), keys: [
            {keys: "Ctrl+K", text: t("Buscar reuniões")},
            {keys: "Ctrl+1 … 4", text: t("Início, Ações, Pessoas, Clientes")},
            {keys: "Ctrl+Shift+R", text: t("Gravar (pede confirmação); durante a gravação, abre as notas")},
            {keys: "Ctrl+J", text: t("Perguntar sobre o que está na tela")},
            {keys: "F5", text: t("Atualizar a lista de reuniões")},
            {keys: "F1 · Ctrl+/", text: t("Esta lista de atalhos")},
            {keys: "Esc", text: t("Fecha o que estiver aberto, depois volta ao início")}
        ]},
        {title: t("Numa reunião"), keys: [
            {keys: "Alt+1 … 4", text: t("Notas, Transcrição, Falantes, Agentes")},
            {keys: t("Espaço"), text: t("Reproduzir ou pausar")},
            {keys: "← →", text: t("Voltar ou avançar 5 segundos")},
            {keys: "V", text: t("Mostrar ou recolher o vídeo")},
            {keys: "F", text: t("Vídeo em tela cheia (Esc sai)")},
            {keys: "Ctrl+Shift+E", text: t("Enviar as notas")}
        ]},
        {title: t("No bloco de notas"), keys: [
            {keys: "Enter", text: t("Nova linha, com o horário")},
            {keys: "Ctrl+S", text: t("Salvar agora")},
            {keys: "Ctrl+Alt+1 · L · A", text: t("Título, lista, ação")}
        ]}
    ]
    function show(from) { opener = from || null; open() }
    onOpened: shortcutsClose.forceActiveFocus(Qt.TabFocusReason)
    onClosed: { if (opener && opener.visible) opener.forceActiveFocus(Qt.TabFocusReason); opener = null }

    contentItem: ScrollView {
        id: shortcutsScroll
        clip: true
        contentWidth: availableWidth
        ColumnLayout {
            width: shortcutsScroll.availableWidth
            spacing: 6
            Repeater {
                model: shortcutsDialog.groups
                ColumnLayout {
                    id: shortcutGroup
                    required property var modelData
                    required property int index
                    Layout.fillWidth: true
                    spacing: 4
                    FtOverline { text: shortcutGroup.modelData.title; Layout.topMargin: shortcutGroup.index === 0 ? 0 : 10 }
                    Repeater {
                        model: shortcutGroup.modelData.keys
                        RowLayout {
                            required property var modelData
                            Layout.fillWidth: true
                            spacing: 12
                            Accessible.role: Accessible.StaticText
                            Accessible.name: modelData.keys + ": " + modelData.text
                            Rectangle {
                                Layout.preferredWidth: compactLayout ? 130 : 160
                                implicitHeight: keyLabel.implicitHeight + 8
                                radius: 6; color: surfaceAlt; border.width: 1; border.color: divider
                                Label { id: keyLabel; anchors.centerIn: parent; width: parent.width - 12; horizontalAlignment: Text.AlignHCenter; text: parent.parent.modelData.keys; textFormat: Text.PlainText; color: ink; font.family: "monospace"; font.pixelSize: 12; elide: Text.ElideRight }
                            }
                            Label { Layout.fillWidth: true; text: parent.modelData.text; textFormat: Text.PlainText; color: ink; font.pixelSize: 13; wrapMode: Text.WordWrap }
                        }
                    }
                }
            }
        }
    }
    footer: Item {
        implicitHeight: 64
        RowLayout {
            anchors.fill: parent; anchors.leftMargin: 20; anchors.rightMargin: 20
            Item { Layout.fillWidth: true }
            FtButton { id: shortcutsClose; objectName: "shortcutsClose"; variant: "outline"; text: t("Fechar"); onClicked: shortcutsDialog.close() }
        }
    }
}
