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
    // The bar shows whenever the page is longer than the window (Basic style hides it until used), in a
    // fixed gutter of its own so it never sits on a field (a gutter that follows the overflow would loop).
    rightPadding: 14
    ScrollBar.vertical.policy: contentHeight > availableHeight ? ScrollBar.AlwaysOn : ScrollBar.AsNeeded
    ColumnLayout { id: pageColumn; width: page.availableWidth; spacing: 10 }
}
