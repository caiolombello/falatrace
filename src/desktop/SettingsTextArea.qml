import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Multi-line settings text, such as the transcription vocabulary hint.
ColumnLayout {
    id:areaControl
    property string field: ""
    property string label: ""
    property string placeholder: ""
    property string hint: ""
    property int maximumLength: 8000
    Layout.fillWidth:true; spacing:4
    Label { text:areaControl.label; color:ink; font.pixelSize:13; wrapMode:Text.WordWrap; Layout.fillWidth:true }
    ScrollView {
        Layout.fillWidth:true; Layout.preferredHeight:96
        clip:true
        TextArea {
            id:areaInput
            text:settingsDraft[areaControl.field] === undefined || settingsDraft[areaControl.field] === null ? "" : String(settingsDraft[areaControl.field])
            placeholderText:areaControl.placeholder
            placeholderTextColor:muted
            color:ink; wrapMode:TextEdit.Wrap; textFormat:TextEdit.PlainText
            selectionColor:accent; selectedTextColor:onAccent
            enabled:settingsEditable
            background:Rectangle { radius:8; color:fieldSurface; border.width:areaInput.activeFocus?2:1; border.color:areaInput.activeFocus?accent:divider }
            onTextChanged:if (activeFocus) setSettingsField(areaControl.field, text.length > areaControl.maximumLength ? text.slice(0, areaControl.maximumLength) : text)
            Accessible.name:areaControl.label
        }
    }
    SettingsHint { text:(areaControl.hint ? areaControl.hint + " " : "") + areaInput.text.length + " / " + areaControl.maximumLength }
}
