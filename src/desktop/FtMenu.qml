import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// A styled menu. Entries are `Action { text; onTriggered }` children (MenuSeparator works too);
// a disabled Action stays visible so the reason in its text can be read.
Menu {
    id: menu
    padding: 6
    implicitWidth: 300
    palette.window: surface
    palette.windowText: ink
    palette.text: ink
    palette.base: surface
    palette.highlight: selectedSurface
    palette.highlightedText: ink
    background: Rectangle { implicitWidth: menu.implicitWidth; radius: 10; color: surface; border.width: 1; border.color: dividerStrong }
    delegate: MenuItem {
        id: entry
        implicitHeight: 34
        leftPadding: 12; rightPadding: 12
        contentItem: Label { text: entry.text; textFormat: Text.PlainText; color: entry.enabled ? ink : muted; font.pixelSize: 13; elide: Text.ElideRight; verticalAlignment: Text.AlignVCenter }
        background: Rectangle { radius: 7; color: entry.highlighted ? selectedSurface : "transparent"; border.width: entry.visualFocus ? 2 : 0; border.color: accent }
    }
}
