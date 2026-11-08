import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts
import "Format.js" as Fmt

ScrollView {
    id: page
    contentWidth: availableWidth
    Material.roundedScale: theme.radius
    property var s: daemon.status
    property real now: Date.now()
    property var activity: []

    Timer { interval: 15000; running: page.visible; repeat: true; onTriggered: page.now = Date.now() }

    function loadActivity() {
        daemon.get("/api/log?limit=8", (ok, data) => { if (ok) page.activity = data; });
    }
    Component.onCompleted: loadActivity()
    Connections {
        target: daemon
        function onLogAdded(entry) { page.activity = [entry].concat(page.activity).slice(0, 8); }
        function onOnlineChanged() { if (daemon.online) page.loadActivity(); }
    }

    readonly property string phase: s.phase || ""
    readonly property bool running: phase === "run"
    readonly property bool canResume: phase === "pause" || phase === "stop"
    readonly property color phaseColor: s.error ? Ui.bad : running ? theme.accent : phase === "charge" ? Ui.good : phase.startsWith("hm") ? "#7e8cff" : Ui.warn

    ColumnLayout {
        width: page.availableWidth
        spacing: 16

        GridLayout {
            Layout.fillWidth: true
            columns: page.width > 900 ? 2 : 1
            columnSpacing: 16
            rowSpacing: 16

            Panel {
                title: page.s.name || qsTr("Robot")
                Layout.fillWidth: true
                Layout.preferredWidth: 3
                Layout.alignment: Qt.AlignTop

                RowLayout {
                    spacing: 12
                    Rectangle { width: 12; height: 12; radius: 6; color: page.phaseColor }
                    Label {
                        text: !page.s.connected ? qsTr("Robot offline") : Fmt.phase(page.s.phase)
                        font.pixelSize: 30
                        font.weight: Font.DemiBold
                        color: Ui.text
                    }
                }
                Label {
                    Layout.fillWidth: true
                    color: Ui.muted
                    wrapMode: Text.Wrap
                    text: {
                        if (!page.s.connected) return qsTr("sweepd can't reach the robot. Check that it's powered on and on Wi-Fi.");
                        if (page.s.active && page.s.mission)
                            return qsTr("Mission started %1 by %2").arg(Fmt.ago(page.s.mission.start, page.now)).arg(page.s.initiator || qsTr("unknown"));
                        if (page.s.lastCommand) return qsTr("Last command: %1, %2").arg(page.s.lastCommand.command).arg(Fmt.ago(page.s.lastCommand.time * 1000, page.now));
                        return "";
                    }
                }

                Rectangle {
                    visible: !!page.s.error
                    Layout.fillWidth: true
                    implicitHeight: errLabel.implicitHeight + 20
                    radius: Math.min(6, theme.radius)
                    color: Qt.rgba(1, 0.42, 0.42, 0.12)
                    border.color: Ui.bad
                    Label {
                        id: errLabel
                        anchors.fill: parent
                        anchors.margins: 10
                        wrapMode: Text.Wrap
                        color: Ui.bad
                        text: qsTr("Error %1: %2").arg(page.s.error).arg(page.s.errorText || "")
                    }
                }

                // Battery
                RowLayout {
                    Layout.fillWidth: true
                    Layout.topMargin: 6
                    spacing: 12
                    Label { text: qsTr("Battery"); color: Ui.muted; Layout.preferredWidth: 70 }
                    Rectangle {
                        Layout.fillWidth: true
                        height: 8
                        radius: 4
                        color: Ui.panelRaised
                        Rectangle {
                            width: parent.width * Math.max(0, Math.min(100, page.s.battery || 0)) / 100
                            height: parent.height
                            radius: 4
                            color: (page.s.battery || 0) <= 20 ? Ui.bad : (page.s.battery || 0) <= 40 ? Ui.warn : Ui.good
                            Behavior on width { NumberAnimation { duration: 300 } }
                        }
                    }
                    Label { text: page.s.battery != null ? page.s.battery + "%" : "—"; color: Ui.text; Layout.preferredWidth: 44; horizontalAlignment: Text.AlignRight }
                }
                StatLine {
                    label: qsTr("Bin")
                    value: !page.s.bin ? "—" : !page.s.bin.present ? qsTr("Missing") : page.s.bin.full ? qsTr("Full") : qsTr("OK")
                    valueColor: page.s.bin && (page.s.bin.full || !page.s.bin.present) ? Ui.warn : Ui.text
                }
                StatLine { label: qsTr("Wi-Fi"); value: Fmt.signal(page.s.rssi) }

                // Controls
                GridLayout {
                    Layout.fillWidth: true
                    Layout.topMargin: 8
                    columns: 3
                    columnSpacing: 8
                    rowSpacing: 8
                    enabled: !!page.s.connected

                    ActionButton {
                        Layout.fillWidth: true
                        highlighted: true
                        text: page.running ? qsTr("Pause  (Space)") : qsTr("Clean  (Space)")
                        onClicked: daemon.command(page.running ? "pause" : "start")
                    }
                    ActionButton { Layout.fillWidth: true; text: qsTr("Resume  (R)"); enabled: page.canResume; onClicked: daemon.command("resume") }
                    ActionButton { Layout.fillWidth: true; text: qsTr("Dock  (D)"); enabled: page.phase !== "charge" && !page.phase.startsWith("hm"); onClicked: daemon.command("dock") }
                    ActionButton { Layout.fillWidth: true; text: qsTr("Stop"); enabled: !!page.s.active; onClicked: daemon.command("stop") }
                    ActionButton { Layout.fillWidth: true; text: qsTr("Find  (F)"); onClicked: daemon.command("find") }
                    ActionButton { Layout.fillWidth: true; text: qsTr("Empty bin  (E)"); enabled: page.phase === "charge"; onClicked: daemon.command("evac") }
                }
            }

            ColumnLayout {
                Layout.fillWidth: true
                Layout.preferredWidth: 2
                Layout.alignment: Qt.AlignTop
                spacing: 16

                Panel {
                    title: qsTr("Routines")
                    Layout.fillWidth: true
                    visible: (daemon.status.routines || []).length > 0
                    Flow {
                        Layout.fillWidth: true
                        spacing: 8
                        Repeater {
                            model: daemon.status.routines || []
                            ActionButton {
                                required property var modelData
                                text: modelData.name
                                enabled: !!page.s.connected && !page.s.active
                                ToolTip.visible: hovered
                                ToolTip.text: modelData.rooms.map((id) => {
                                    const r = (page.s.rooms || []).find((x) => x.id === id);
                                    return r && r.name ? r.name : qsTr("Room %1").arg(id);
                                }).join(" → ")
                                onClicked: daemon.send("POST", "/api/routines/" + modelData.id + "/clean", {}, (ok, d) => {
                                    window.toast(ok ? qsTr("Started “%1”").arg(modelData.name) : qsTr("Couldn't start: %1").arg(d.error), !ok);
                                })
                            }
                        }
                    }
                }

                Panel {
                    id: attentionPanel
                    title: qsTr("Needs attention")
                    Layout.fillWidth: true
                    readonly property var warnings: (page.s.warnings || []).filter((w) => w.level === "warn")
                    visible: (page.s.maintenanceDue || []).length > 0 || warnings.length > 0
                    Repeater {
                        model: attentionPanel.warnings
                        Label { required property var modelData; text: "• " + modelData.title; color: Ui.warn; wrapMode: Text.Wrap; Layout.fillWidth: true }
                    }
                    Repeater {
                        model: page.s.maintenanceDue || []
                        Label { required property var modelData; text: "• " + modelData.label; color: Ui.warn }
                    }
                    ActionButton { text: qsTr("Open Health"); flat: true; onClicked: window.pageIndex = 5 }
                }

                Panel {
                    title: qsTr("This mission")
                    Layout.fillWidth: true
                    visible: !!page.s.active
                    StatLine { label: qsTr("Running for"); value: page.s.mission ? Fmt.minutes((page.now - page.s.mission.start) / 60000) : "—" }
                    StatLine { label: qsTr("Cleaning time (robot)"); value: Fmt.minutes(page.s.missionMinutes) }
                    StatLine { label: qsTr("Area"); value: page.s.sqft != null ? qsTr("%1 sq ft").arg(page.s.sqft) : "—" }
                    StatLine {
                        label: qsTr("Battery used")
                        value: page.s.mission && page.s.mission.batteryStart != null && page.s.battery != null ? (page.s.mission.batteryStart - page.s.battery) + "%" : "—"
                    }
                    PhaseTimeline {
                        Layout.fillWidth: true
                        visible: !!page.s.mission
                        phases: page.s.mission ? page.s.mission.phases : []
                        start: page.s.mission ? page.s.mission.start : 0
                        end: page.now
                    }
                }

                Panel {
                    title: qsTr("Automations")
                    Layout.fillWidth: true
                    StatLine {
                        label: qsTr("Next scheduled")
                        value: page.s.next ? qsTr("%1 · %2").arg(page.s.next.name).arg(Fmt.dateTime(page.s.next.t)) : qsTr("None")
                    }
                    StatLine {
                        label: qsTr("Presence")
                        value: !page.s.presence || !page.s.presence.configured ? qsTr("Not set up")
                             : page.s.presence.home ? qsTr("Someone home") : qsTr("Everyone away · %1").arg(Fmt.ago(page.s.presence.since, page.now))
                    }
                    StatLine {
                        label: qsTr("Quiet hours")
                        value: !page.s.quiet || !page.s.quiet.enabled ? qsTr("Off")
                             : (page.s.quietNow ? qsTr("Active now (%1–%2)") : qsTr("%1–%2")).arg(page.s.quiet.start).arg(page.s.quiet.end)
                    }
                }

                Panel {
                    title: qsTr("Recent activity")
                    Layout.fillWidth: true
                    Label { visible: page.activity.length === 0; text: qsTr("Nothing yet"); color: Ui.faint }
                    Repeater {
                        model: page.activity
                        RowLayout {
                            required property var modelData
                            Layout.fillWidth: true
                            spacing: 10
                            Label { text: Fmt.ago(modelData.t, page.now); color: Ui.faint; font.pixelSize: 12; Layout.preferredWidth: 80 }
                            Label { text: modelData.message; color: modelData.kind === "error" ? Ui.bad : Ui.text; Layout.fillWidth: true; elide: Text.ElideRight }
                        }
                    }
                }
            }
        }
    }
}
