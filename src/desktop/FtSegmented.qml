import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Segmented control (tab list). `model` is [{value, label, icon?, shortLabel?}] in visual order and
// `currentIndex` holds the selected value, so the visual order can differ from the values other code
// relies on (the meeting tabs show 1, 0, 2, 3). One Tab stop; Left/Right/Home/End move in visual order.
Control {
    id: segmented
    property var model: []
    property int currentIndex: model.length ? model[0].value : 0
    property bool compact: false
    property bool showIcons: true
    property bool useShortLabels: false
    property string accessibleName: ""
    signal activated(int value)
    focusPolicy: Qt.StrongFocus
    padding: 3
    implicitHeight: compact ? 32 : 36
    implicitWidth: segmentRow.implicitWidth + leftPadding + rightPadding
    Accessible.role: Accessible.PageTabList
    Accessible.name: accessibleName

    function visualIndex() {
        for (let index = 0; index < model.length; index++) if (model[index].value === currentIndex) return index
        return -1
    }
    function select(value) {
        if (currentIndex === value) return
        currentIndex = value
        activated(value)
    }
    function move(step) {
        const count = model.length
        if (!count) return
        const index = Math.max(0, visualIndex())
        select(model[(index + step + count) % count].value)
    }
    Keys.onLeftPressed: move(-1)
    Keys.onRightPressed: move(1)
    Keys.onPressed: event => {
        if (!model.length) return
        if (event.key === Qt.Key_Home) { select(model[0].value); event.accepted = true }
        else if (event.key === Qt.Key_End) { select(model[model.length - 1].value); event.accepted = true }
    }

    background: Rectangle { radius: 10; color: surfaceAlt; border.width: 1; border.color: divider }
    contentItem: Row {
        id: segmentRow
        spacing: 2
        Repeater {
            model: segmented.model
            delegate: Rectangle {
                id: segment
                required property var modelData
                required property int index
                readonly property bool selected: segmented.currentIndex === modelData.value
                readonly property string label: segmented.useShortLabels && modelData.shortLabel ? modelData.shortLabel : modelData.label
                objectName: "segment-" + modelData.value
                height: segmentRow.height
                implicitHeight: segmented.availableHeight
                width: segmentContent.implicitWidth + (segmented.compact ? 18 : 24)
                radius: 8
                color: selected ? surface : segmentMouse.containsMouse ? hoverSurface : "transparent"
                border.width: selected ? 1 : 0
                border.color: divider
                Accessible.role: Accessible.PageTab
                Accessible.name: label
                Accessible.selected: selected
                Row {
                    id: segmentContent
                    anchors.centerIn: parent
                    spacing: 6
                    FtIcon { visible: segmented.showIcons && !!segment.modelData.icon; name: segment.modelData.icon || ""; tint: segment.selected ? accent : muted; size: 15; anchors.verticalCenter: parent.verticalCenter }
                    Label { text: segment.label; textFormat: Text.PlainText; font.pixelSize: segmented.compact ? 12 : 13; font.weight: segment.selected ? Font.DemiBold : Font.Normal; color: segment.selected ? ink : muted; anchors.verticalCenter: parent.verticalCenter }
                }
                Rectangle { visible: segment.selected; anchors.bottom: parent.bottom; anchors.horizontalCenter: parent.horizontalCenter; anchors.bottomMargin: 3; width: Math.min(parent.width - 16, 28); height: 2; radius: 1; color: accent }
                // Keyboard focus ring on the selected segment.
                Rectangle { anchors.fill: parent; anchors.margins: -2; radius: 10; color: "transparent"; border.width: 2; border.color: accent; visible: segment.selected && segmented.visualFocus }
                MouseArea {
                    id: segmentMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: { segmented.forceActiveFocus(Qt.MouseFocusReason); segmented.select(segment.modelData.value) }
                }
            }
        }
    }
}
