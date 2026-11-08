import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts
import "Format.js" as Fmt

// Care items tracked by real use (cleaning hours, bin emptyings), with a
// progress bar each, a Done button that restarts the count, and an
// adjustable interval.
Panel {
    id: panel
    title: qsTr("Maintenance")
    property var items: []

    function load() { daemon.get("/api/maintenance", (ok, d) => { if (ok) panel.items = d; }); }
    function done(item) {
        daemon.send("POST", "/api/maintenance/" + item.key + "/done", {}, (ok, d) => {
            if (ok) { panel.items = d; window.toast(qsTr("Marked done: %1").arg(item.label), false); }
            else window.toast(qsTr("Couldn't update: %1").arg(d.error), true);
        });
    }
    function setInterval(item, value) {
        daemon.send("PUT", "/api/maintenance/" + item.key, { interval: value }, (ok, d) => {
            if (ok) panel.items = d; else window.toast(qsTr("Couldn't update: %1").arg(d.error), true);
        });
    }
    function usage(item) {
        if (item.used == null) return qsTr("Waiting for the robot's counters");
        return item.meter === "hours"
            ? qsTr("%1 of %2 cleaning hours").arg(item.used.toLocaleString(Qt.locale(), 'f', 1)).arg(item.interval)
            : qsTr("%1 of %2 bin emptyings").arg(Math.round(item.used)).arg(item.interval);
    }

    Component.onCompleted: load()
    onVisibleChanged: if (visible) load()
    Connections {
        target: daemon
        function onLogAdded(entry) { if (entry.kind === "maintenance") panel.load(); }
    }

    Label {
        Layout.fillWidth: true
        wrapMode: Text.Wrap
        color: Ui.muted
        text: qsTr("Counted from actual cleaning time and how often the dock emptied the bin. Press Done after each job to restart its count.")
    }

    Repeater {
        model: panel.items
        ColumnLayout {
            required property var modelData
            Layout.fillWidth: true
            spacing: 2

            RowLayout {
                Layout.fillWidth: true
                spacing: 12
                Label {
                    text: modelData.label
                    color: modelData.due ? Ui.warn : Ui.text
                    font.weight: modelData.due ? Font.DemiBold : Font.Normal
                    Layout.fillWidth: true
                    ToolTip.visible: tipHover.hovered
                    ToolTip.text: modelData.tip
                    HoverHandler { id: tipHover }
                }
                Label {
                    text: qsTr("%1 · done %2").arg(panel.usage(modelData)).arg(Fmt.ago(modelData.doneAt))
                    color: Ui.muted
                    font.pixelSize: 12
                }
                // Compact interval control: Material's SpinBox is too tall for a list row.
                Row {
                    readonly property int step: 5
                    readonly property int maxValue: modelData.meter === "hours" ? 500 : 200
                    Label { text: qsTr("every"); color: Ui.faint; font.pixelSize: 12; anchors.verticalCenter: parent.verticalCenter; rightPadding: 4 }
                    ToolButton {
                        text: "−"
                        enabled: modelData.interval > parent.step
                        onClicked: panel.setInterval(modelData, Math.max(parent.step, modelData.interval - parent.step))
                    }
                    Label {
                        text: modelData.meter === "hours" ? qsTr("%1 h").arg(modelData.interval) : qsTr("%1 empties").arg(modelData.interval)
                        color: Ui.text
                        width: 74
                        horizontalAlignment: Text.AlignHCenter
                        anchors.verticalCenter: parent.verticalCenter
                        font.features: { "tnum": 1 }
                    }
                    ToolButton {
                        text: "+"
                        enabled: modelData.interval < parent.maxValue
                        onClicked: panel.setInterval(modelData, Math.min(parent.maxValue, modelData.interval + parent.step))
                    }
                }
                ActionButton { text: qsTr("Done"); highlighted: modelData.due; flat: !modelData.due; onClicked: panel.done(modelData) }
            }
            Rectangle {
                Layout.fillWidth: true
                height: 4
                radius: 2
                color: Ui.panelRaised
                Rectangle {
                    width: parent.width * (modelData.fraction || 0)
                    height: parent.height
                    radius: 2
                    color: modelData.due ? Ui.warn : modelData.fraction > 0.8 ? Qt.lighter(Ui.warn, 1.3) : theme.accent
                }
            }
        }
    }
}
