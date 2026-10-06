import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

RowLayout {
    id:numberControl
    property string field: ""
    property string label: ""
    property int from: 1
    property int to: 300
    Layout.fillWidth:true; spacing:10
    Label { text:numberControl.label; color:ink; font.pixelSize:13; wrapMode:Text.WordWrap; Layout.fillWidth:true }
    SpinBox {
        from:numberControl.from; to:numberControl.to; editable:true
        value:Number(settingsDraft[numberControl.field]) || numberControl.from
        enabled:settingsEditable
        onValueModified:setSettingsField(numberControl.field, value)
        Accessible.name:numberControl.label
    }
}
