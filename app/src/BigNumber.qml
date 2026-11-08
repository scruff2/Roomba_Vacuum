import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

// A headline figure with a caption, for stat tiles.
ColumnLayout {
    property string value
    property string caption
    property color valueColor: Ui.text
    spacing: 2
    Label {
        text: parent.value
        color: parent.valueColor
        font.pixelSize: 26
        font.weight: Font.DemiBold
        font.features: { "tnum": 1 }
    }
    Label {
        text: parent.caption
        color: Ui.muted
        font.pixelSize: 12
    }
}
