import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// Initials in a circle; the tint comes from a hash of the name (six muted tints per theme).
Rectangle {
    id: avatar
    property string name: ""
    property int size: 24
    readonly property var lightTints: ["#D9E8E1", "#E6DFF0", "#F3E2D2", "#DCE6F2", "#EDE3CF", "#E7D9DD"]
    readonly property var darkTints: ["#24443D", "#352F45", "#46362A", "#2A3A4D", "#403A28", "#432F36"]
    function hash(text) {
        let value = 0
        for (let index = 0; index < text.length; index++) value = (value * 31 + text.charCodeAt(index)) % 9973
        return value
    }
    function initials(text) {
        const words = String(text || "").trim().split(/\s+/).filter(function(word){ return word.length > 0 })
        if (!words.length) return "?"
        return (words[0].charAt(0) + (words.length > 1 ? words[words.length - 1].charAt(0) : "")).toUpperCase()
    }
    width: size; height: size
    implicitWidth: size; implicitHeight: size
    radius: size / 2
    color: (lightTheme ? lightTints : darkTints)[hash(name) % 6]
    border.width: 1
    border.color: surface
    Accessible.role: Accessible.StaticText
    Accessible.name: name
    Label {
        anchors.centerIn: parent
        text: avatar.initials(avatar.name)
        textFormat: Text.PlainText
        color: ink
        font.pixelSize: Math.max(9, Math.round(avatar.size * 0.42))
        font.weight: Font.DemiBold
    }
}
