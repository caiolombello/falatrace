import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Item {
    id: iconItem
    property string name: ""
    property color tint: ink
    property int size: 18
    width: size; height: size
    implicitWidth: size; implicitHeight: size
    visible: name !== ""
    Accessible.ignored: true
    Image {
        anchors.fill: parent
        sourceSize.width: iconItem.size * 2; sourceSize.height: iconItem.size * 2
        fillMode: Image.PreserveAspectFit
        smooth: true
        source: iconItem.name !== "" ? iconUri(iconItem.name, iconItem.tint) : ""
    }
}
