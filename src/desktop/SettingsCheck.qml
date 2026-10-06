import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

WrappedCheck {
    property string field: ""
    checked: settingsDraft[field] === true
    enabled: settingsEditable
    onToggled: setSettingsField(field, checked)
    Accessible.name: text
}
