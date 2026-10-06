import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Dialog {
    id: dialogControl
    padding: 20
    topPadding: 6
    palette.window: surface
    palette.base: fieldSurface
    palette.button: buttonSurface
    background: Rectangle { radius: 14; color: surface; border.width: 1; border.color: divider }
    header: Label {
        text: dialogControl.title
        visible: text !== ""
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        color: ink
        font.pixelSize: 18
        font.weight: Font.DemiBold
        leftPadding: 20
        rightPadding: 20
        topPadding: 18
        bottomPadding: 10
        background: Item {}
    }
    Overlay.modal: Rectangle { color: lightTheme ? "#80102B2A" : "#B3030808" }
}
