import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// One "label ........ value" row.
RowLayout {
    property string label
    property string value
    property color valueColor: Ui.text
    property string hint: ""

    Layout.fillWidth: true
    spacing: 12

    Label {
        text: parent.label
        color: Ui.muted
        Layout.fillWidth: true
        elide: Text.ElideRight
        ToolTip.visible: parent.hint !== "" && hover.hovered
        ToolTip.text: parent.hint
        HoverHandler { id: hover }
    }
    Label {
        text: parent.value
        color: parent.valueColor
        font.features: { "tnum": 1 }
        horizontalAlignment: Text.AlignRight
    }
}
