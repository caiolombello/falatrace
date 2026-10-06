import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

CheckBox {
    id:checkControl; Layout.fillWidth:true
    spacing: 10
    indicator: Rectangle {
        implicitWidth: 22; implicitHeight: 22
        x: checkControl.leftPadding; y: checkControl.topPadding + (checkControl.availableHeight - height) / 2
        radius: 6
        color: checkControl.checked ? accent : fieldSurface
        border.width: checkControl.visualFocus ? 3 : 2
        border.color: checkControl.visualFocus || checkControl.checked ? accent : muted
        opacity: checkControl.enabled ? 1 : 0.5
        FtIcon { anchors.centerIn: parent; name: "check"; size: 16; tint: onAccent; visible: checkControl.checked }
    }
    background:Rectangle { color:"transparent"; radius:6; border.width:checkControl.visualFocus?2:0; border.color:accent }
    contentItem:Text { text:checkControl.text; font:checkControl.font; color:checkControl.enabled?ink:muted; wrapMode:Text.WordWrap; leftPadding:checkControl.indicator.width+checkControl.spacing; verticalAlignment:Text.AlignVCenter }
}
