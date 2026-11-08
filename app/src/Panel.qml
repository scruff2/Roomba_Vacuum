import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// A titled card. Children go into a column under the title.
Rectangle {
    id: root
    property string title: ""
    property alias headerItems: headerRow.data
    default property alias content: body.data
    property int padding: 16

    color: Ui.panel
    border.color: Ui.border
    radius: theme.radius
    implicitHeight: column.implicitHeight + padding * 2
    implicitWidth: column.implicitWidth + padding * 2

    ColumnLayout {
        id: column
        // Pinned to the top so a panel stretched to match its neighbour keeps
        // its content at the top instead of spreading it out.
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: root.padding
        spacing: 12

        RowLayout {
            visible: root.title !== "" || headerRow.children.length > 0
            Layout.fillWidth: true
            Label {
                text: root.title
                color: Ui.muted
                font.pixelSize: 12
                font.capitalization: Font.AllUppercase
                font.letterSpacing: 0.8
                font.weight: Font.DemiBold
                Layout.fillWidth: true
            }
            RowLayout { id: headerRow; spacing: 8 }
        }

        ColumnLayout {
            id: body
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: 8
        }
    }
}
