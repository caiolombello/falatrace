import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// One action (a to-do from the meeting): checkbox, text in the author's ink, "owner · due" exactly as
// written, and the moments it was said. Checking it asks the owner (toggleRequested) to save it.
RowLayout {
    id: actionRow
    property var action: ({})
    property string text: ""
    property string origin: "ai"
    property bool uncertain: false
    property var citations: []
    property string at: ""
    property string status: action && action.status ? action.status : "open"
    property bool editable: false
    readonly property bool done: status === "done"
    readonly property bool mine: origin === "user"
    signal toggleRequested(bool done)
    objectName: "actionRow-" + (action && action.actionId ? action.actionId : "")
    spacing: 8
    Accessible.role: Accessible.ListItem
    Accessible.name: (mine ? t("Sua nota: ") : t("Completado pela IA: ")) + text + (done ? t(", concluída") : "")

    FtCheck {
        id: check
        objectName: "actionCheck-" + (actionRow.action && actionRow.action.actionId ? actionRow.action.actionId : "")
        Layout.alignment: Qt.AlignTop
        Layout.topMargin: -2
        checked: actionRow.done
        enabled: actionRow.editable
        text: (actionRow.done ? t("Reabrir a ação: ") : t("Concluir a ação: ")) + actionRow.text
        onToggled: actionRow.toggleRequested(checked)
        ToolTip.visible: hovered && !enabled
        ToolTip.text: t("As ações ficam marcáveis quando o FalaTrace estiver conectado.")
    }
    ColumnLayout {
        Layout.fillWidth: true
        spacing: 2
        Label {
            Layout.fillWidth: true
            text: actionRow.text
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            font.pixelSize: 15
            lineHeight: 1.3
            font.weight: actionRow.mine ? Font.Medium : Font.Normal
            font.strikeout: actionRow.done
            color: actionRow.done ? muted : actionRow.mine ? noteInk : aiInk
        }
        Label {
            visible: text !== ""
            text: [actionRow.action && actionRow.action.owner || "", actionRow.action && actionRow.action.dueDate ? tf("até %1", actionRow.action.dueDate) : ""].filter(function(part){ return !!part }).join(" · ")
            textFormat: Text.PlainText
            color: muted
            font.pixelSize: 12
            Layout.fillWidth: true
            elide: Text.ElideRight
        }
    }
    Rectangle {
        visible: actionRow.uncertain
        Layout.alignment: Qt.AlignTop
        implicitWidth: 20; implicitHeight: 20; radius: 10
        color: warningSoft
        Label { anchors.centerIn: parent; text: "?"; color: warningColor; font.pixelSize: 12; font.weight: Font.DemiBold }
        HoverHandler { id: uncertainHover }
        ToolTip.visible: uncertainHover.hovered
        ToolTip.text: t("Pouco claro na gravação")
        Accessible.name: t("Pouco claro na gravação")
    }
    Label { visible: actionRow.mine && actionRow.at !== ""; Layout.alignment: Qt.AlignTop; text: actionRow.at; textFormat: Text.PlainText; color: muted; font.pixelSize: 11; font.family: "monospace"; topPadding: 3 }
    Repeater {
        model: actionRow.mine ? [] : asList(actionRow.citations).slice(0, 3)
        FtCitation { required property var modelData; Layout.alignment: Qt.AlignTop; segmentId: modelData.segmentId || ""; start: Number(modelData.start) || 0 }
    }
    Label { visible: !actionRow.mine && asList(actionRow.citations).length > 3; Layout.alignment: Qt.AlignTop; text: "+" + (asList(actionRow.citations).length - 3); color: citationInk; font.pixelSize: 11; topPadding: 3 }
}
