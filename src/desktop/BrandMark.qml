import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Item {
    id: brandMark
    property int size: 28
    property color markColor: ink
    property color dotColor: accent
    width: size; height: size
    implicitWidth: size; implicitHeight: size
    Accessible.ignored: true
    Rectangle { x: brandMark.size * 11 / 64; y: brandMark.size * 7 / 64; width: brandMark.size * 22 / 64; height: brandMark.size * 6 / 64; color: brandMark.markColor }
    Rectangle { x: brandMark.size * 11 / 64; y: brandMark.size * 7 / 64; width: brandMark.size * 6 / 64; height: brandMark.size * 50 / 64; color: brandMark.markColor }
    Rectangle { x: brandMark.size * 11 / 64; y: brandMark.size * 51 / 64; width: brandMark.size * 22 / 64; height: brandMark.size * 6 / 64; color: brandMark.markColor }
    Rectangle { x: brandMark.size * 38 / 64; y: brandMark.size * 26 / 64; width: brandMark.size * 12 / 64; height: width; radius: width / 2; color: brandMark.dotColor }
}
