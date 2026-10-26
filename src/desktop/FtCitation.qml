import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// One moment of the meeting, as a chip: "▶ 12:03". Click or Enter seeks there (opening the media first
// when needed); Shift+click or Shift+Enter shows the transcript at that segment, which is also what
// happens when the recording has no audio. Labels are plain text; the chip is its own button.
AbstractButton {
    id: citation
    property string segmentId: ""
    property real start: 0
    property string label: clock(start)
    readonly property bool playable: mediaPlayable()
    objectName: "citation-" + segmentId
    focusPolicy: Qt.StrongFocus
    hoverEnabled: true
    padding: 0
    implicitHeight: 22
    implicitWidth: citationRow.implicitWidth + 14
    Accessible.role: Accessible.Button
    Accessible.name: playable ? tf("Ir para %1", label) : tf("Ver na transcrição: %1", label)
    ToolTip.visible: hovered
    ToolTip.delay: 600
    ToolTip.text: playable ? t("Ouvir este momento · Shift: ver na transcrição") : t("Ver este momento na transcrição")
    function activate(toTranscript) { openCitation(segmentId, start, toTranscript) }
    onClicked: activate(false)
    Keys.onReturnPressed: event => { activate((event.modifiers & Qt.ShiftModifier) !== 0); event.accepted = true }
    Keys.onEnterPressed: event => { activate((event.modifiers & Qt.ShiftModifier) !== 0); event.accepted = true }
    contentItem: Item {}
    background: Rectangle {
        radius: 11
        color: citationMouse.pressed ? shade(citationSurface, 0.12) : citation.hovered ? shade(citationSurface, 0.05) : citationSurface
        Row {
            id: citationRow
            anchors.centerIn: parent
            spacing: 4
            FtIcon { name: citation.playable ? "play" : "transcript"; tint: citationInk; size: 11; anchors.verticalCenter: parent.verticalCenter }
            Label { text: citation.label; textFormat: Text.PlainText; color: citationInk; font.pixelSize: 11; font.family: "monospace"; font.weight: Font.DemiBold; anchors.verticalCenter: parent.verticalCenter }
        }
        Rectangle { anchors.fill: parent; anchors.margins: -3; radius: 14; color: "transparent"; border.width: 2; border.color: accent; visible: citation.visualFocus }
    }
    MouseArea {
        id: citationMouse
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        onClicked: mouse => citation.activate((mouse.modifiers & (Qt.ShiftModifier | Qt.AltModifier)) !== 0)
    }
}
