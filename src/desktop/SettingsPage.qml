import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// A settings section that lives in its own file (SettingsDialog's SectionPage is private to that
// file): a column as wide as the page that scrolls. The section's rows go inside.
ScrollView {
    id: page
    default property alias content: pageColumn.data
    clip: true
    contentWidth: availableWidth
    ColumnLayout { id: pageColumn; width: page.availableWidth; spacing: 10 }
}
