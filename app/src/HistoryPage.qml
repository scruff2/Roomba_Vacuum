import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts
import "Format.js" as Fmt

ScrollView {
    id: page
    contentWidth: availableWidth
    Material.roundedScale: theme.radius
    property int days: 30
    property var stats: null
    property var missions: []
    property var selected: null
    property string selectedId: ""

    function load() {
        daemon.get("/api/stats?days=" + page.days, (ok, data) => { if (ok) page.stats = data; });
        daemon.get("/api/missions?limit=200", (ok, data) => {
            if (!ok) return;
            page.missions = data;
            if (!page.selectedId && data.length) page.select(data[0].id);
        });
    }
    function select(id) {
        page.selectedId = id;
        daemon.get("/api/missions/" + id, (ok, data) => { if (ok && page.selectedId === id) page.selected = data; });
    }
    onVisibleChanged: if (visible) load()
    onDaysChanged: load()
    Component.onCompleted: load()
    Connections {
        target: daemon
        function onMissionUpdated(m) { if (page.visible) page.load(); if (m.id === page.selectedId) page.select(m.id); }
    }

    // Minutes cleaned per day (short ranges) or per week (long ranges).
    readonly property var perPeriod: {
        if (!stats) return [];
        const weekly = days > 45;
        const bucket = weekly ? 7 * 86400000 : 86400000;
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const n = Math.ceil(days / (weekly ? 7 : 1));
        const out = [];
        for (let i = n - 1; i >= 0; i--) {
            const from = today.getTime() - i * bucket + (weekly ? -6 * 86400000 : 0);
            out.push({ from, to: from + bucket, value: 0, label: weekly ? Fmt.date(from).replace(/\/\d{2,4}$/, "") : Qt.locale().dayName(new Date(from).getDay(), Locale.NarrowFormat) + new Date(from).getDate() });
        }
        for (const m of stats.missions) {
            const b = out.find((o) => m.start >= o.from && m.start < o.to);
            if (b) b.value += m.minutes || 0;
        }
        return out;
    }

    ColumnLayout {
        width: page.availableWidth
        spacing: 16

        RowLayout {
            Layout.fillWidth: true
            Label { text: qsTr("Showing the last"); color: Ui.muted }
            Repeater {
                model: [7, 30, 90, 365]
                ActionButton {
                    required property int modelData
                    text: qsTr("%1 days").arg(modelData)
                    flat: page.days !== modelData
                    highlighted: page.days === modelData
                    onClicked: page.days = modelData
                }
            }
            Item { Layout.fillWidth: true }
        }

        Panel {
            Layout.fillWidth: true
            RowLayout {
                Layout.fillWidth: true
                spacing: 32
                BigNumber { value: page.stats ? Fmt.number(page.stats.count) : "—"; caption: qsTr("missions") }
                BigNumber { value: page.stats ? Fmt.minutes(page.stats.minutes) : "—"; caption: qsTr("cleaning time") }
                BigNumber { value: page.stats ? Fmt.number(page.stats.sqft) : "—"; caption: qsTr("sq ft cleaned") }
                BigNumber { value: page.stats ? Fmt.number(page.stats.bumps) : "—"; caption: qsTr("bumps") }
                BigNumber { value: page.stats ? Fmt.number(page.stats.stuck) : "—"; caption: qsTr("times stuck"); valueColor: page.stats && page.stats.stuck ? Ui.warn : Ui.text }
                Item { Layout.fillWidth: true }
            }
            Label {
                visible: page.stats && page.stats.count === 0
                text: qsTr("Sweep records every mission from now on. Start a clean and it will show up here.")
                color: Ui.muted
                wrapMode: Text.Wrap
                Layout.fillWidth: true
            }
            BarChart {
                Layout.fillWidth: true
                Layout.preferredHeight: 150
                visible: page.stats && page.stats.count > 0
                bars: page.perPeriod
                emptyText: qsTr("No cleaning in this period")
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 16

            Panel {
                title: qsTr("Missions")
                Layout.preferredWidth: 320
                Layout.fillHeight: true
                Layout.alignment: Qt.AlignTop

                Label { visible: page.missions.length === 0; text: qsTr("No missions recorded yet"); color: Ui.faint }
                Repeater {
                    model: page.missions
                    ItemDelegate {
                        required property var modelData
                        Layout.fillWidth: true
                        highlighted: modelData.id === page.selectedId
                        onClicked: page.select(modelData.id)
                        contentItem: RowLayout {
                            spacing: 10
                            Rectangle {
                                width: 8; height: 8; radius: 4
                                color: modelData.result === "completed" ? Ui.good : modelData.result === "error" ? Ui.bad : !modelData.end ? theme.accent : Ui.warn
                            }
                            ColumnLayout {
                                spacing: 0
                                Layout.fillWidth: true
                                Label { text: Fmt.dateTime(modelData.start); color: Ui.text }
                                Label {
                                    text: qsTr("%1 · %2").arg(Fmt.result(modelData.result)).arg(Fmt.minutes(modelData.missionMinutes || (modelData.end ? (modelData.end - modelData.start) / 60000 : null)))
                                    color: Ui.muted
                                    font.pixelSize: 12
                                }
                            }
                        }
                    }
                }
            }

            Panel {
                title: page.selected ? qsTr("Mission · %1").arg(Fmt.dateTime(page.selected.start)) : qsTr("Mission")
                Layout.fillWidth: true
                Layout.alignment: Qt.AlignTop
                visible: !!page.selected

                PhaseTimeline {
                    Layout.fillWidth: true
                    phases: page.selected && page.selected.phases ? page.selected.phases : []
                    start: page.selected ? page.selected.start : 0
                    end: page.selected && page.selected.end ? page.selected.end : Date.now()
                }

                GridLayout {
                    Layout.fillWidth: true
                    columns: 2
                    columnSpacing: 32
                    StatLine { label: qsTr("Result"); value: Fmt.result(page.selected ? page.selected.result : null) }
                    StatLine { label: qsTr("Started by"); value: page.selected && page.selected.initiator ? page.selected.initiator : "—" }
                    StatLine {
                        Layout.columnSpan: 2
                        label: qsTr("Rooms")
                        value: page.selected && page.selected.rooms && page.selected.rooms.length ? page.selected.rooms.map((r) => r.name).join(" → ") : qsTr("Whole house")
                    }
                    StatLine { label: qsTr("Duration"); value: page.selected && page.selected.end ? Fmt.minutes((page.selected.end - page.selected.start) / 60000) : "—" }
                    StatLine { label: qsTr("Cleaning time (robot)"); value: Fmt.minutes(page.selected ? page.selected.missionMinutes : null) }
                    StatLine { label: qsTr("Area"); value: page.selected && page.selected.sqft ? qsTr("%1 sq ft").arg(page.selected.sqft) : "—" }
                    StatLine {
                        label: qsTr("Battery")
                        value: page.selected && page.selected.batteryStart != null ? qsTr("%1% → %2%").arg(page.selected.batteryStart).arg(page.selected.batteryMin) : "—"
                    }
                    StatLine { label: qsTr("Bumps"); value: Fmt.number(page.selected && page.selected.stats ? page.selected.stats.bumps : null) }
                    StatLine { label: qsTr("Cliffs avoided"); value: Fmt.number(page.selected && page.selected.stats ? page.selected.stats.cliffs : null) }
                    StatLine { label: qsTr("Got stuck"); value: Fmt.number(page.selected && page.selected.stats ? page.selected.stats.stuck : null) }
                    StatLine { label: qsTr("Wheel drops"); value: Fmt.number(page.selected && page.selected.stats ? page.selected.stats.wheelDrops : null) }
                    StatLine { label: qsTr("Brush stalls"); value: Fmt.number(page.selected && page.selected.stats ? page.selected.stats.brushStalls : null) }
                    StatLine { label: qsTr("Bin emptied"); value: Fmt.number(page.selected && page.selected.stats ? page.selected.stats.evacs : null) }
                }
                Label {
                    visible: page.selected && page.selected.end && !page.selected.countersEnd
                    text: qsTr("Counters for this mission are still being collected.")
                    color: Ui.faint
                    font.pixelSize: 12
                }
                Repeater {
                    model: page.selected && page.selected.errors ? page.selected.errors : []
                    Label {
                        required property var modelData
                        color: Ui.bad
                        text: qsTr("%1 · error %2").arg(Fmt.time(modelData[0])).arg(modelData[1])
                    }
                }
                Label { text: qsTr("Wi-Fi signal during the mission"); color: Ui.muted; font.pixelSize: 12; Layout.topMargin: 8 }
                LineChart {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 140
                    ySuffix: " dBm"
                    emptyText: qsTr("No signal samples for this mission")
                    series: [{ color: theme.accent, points: page.selected && page.selected.samples ? page.selected.samples.map((x) => [x.t, x.rssi]) : [] }]
                }
            }
        }
    }
}
