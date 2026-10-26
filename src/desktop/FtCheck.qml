import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// 18 px checkbox drawn in QML (accent box, onAccent tick). Space toggles; the ring shows keyboard focus.
// `text` is the accessible name only; put the visible label next to it.
AbstractButton {
    id: check
    property int boxSize: 18
    checkable: true
    focusPolicy: Qt.StrongFocus
    hoverEnabled: true
    implicitWidth: boxSize + 8
    implicitHeight: boxSize + 8
    padding: 0
    Accessible.role: Accessible.CheckBox
    Accessible.name: text
    Accessible.checkable: true
    Accessible.checked: checked
    opacity: enabled ? 1 : 0.5
    contentItem: Item {}
    background: Item {
        Rectangle {
            id: box
            anchors.centerIn: parent
            width: check.boxSize; height: check.boxSize
            radius: 4
            color: check.checked ? accent : check.hovered ? hoverSurface : fieldSurface
            border.width: check.checked ? 0 : 1.5
            border.color: check.hovered ? accent : dividerStrong
            FtIcon { anchors.centerIn: parent; visible: check.checked; name: "check"; tint: onAccent; size: check.boxSize - 4 }
        }
        Rectangle {
            anchors.centerIn: parent
            width: check.boxSize + 7; height: check.boxSize + 7
            radius: 7
            color: "transparent"
            border.width: 2
            border.color: accent
            visible: check.visualFocus
        }
    }
}
