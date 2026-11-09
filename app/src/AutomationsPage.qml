import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts
import "Format.js" as Fmt

ScrollView {
    id: page
    contentWidth: availableWidth
    Material.roundedScale: theme.radius
    property var rules: []
    property var alertCfg: ({})
    property var presence: ({ devices: [], awayAfterMin: 15 })
    property var quiet: ({ enabled: false, start: "22:00", end: "08:00" })
    property var log: []

    function load() {
        daemon.get("/api/automations", (ok, d) => { if (ok) page.rules = d.automations; });
        daemon.get("/api/alerts", (ok, d) => { if (ok) page.alertCfg = d; });
        daemon.get("/api/presence", (ok, d) => { if (ok) page.presence = d; });
        daemon.get("/api/quiet", (ok, d) => { if (ok) page.quiet = d; });
        daemon.get("/api/log?limit=40", (ok, d) => { if (ok) page.log = d; });
        daemon.get("/api/insights", (ok, d) => { if (ok) page.review = d.review; });
    }
    property var review: ({ autoRetry: false })
    function saved(ok, d, what) {
        if (!ok) window.toast(qsTr("Couldn't save %1: %2").arg(what).arg(d.error), true);
        page.load();
    }
    function toggleRule(rule, enabled) {
        const r = Object.assign({}, rule, { enabled });
        daemon.send("PUT", "/api/automations/" + rule.id, r, (ok, d) => page.saved(ok, d, rule.name));
    }
    function describe(rule) {
        const c = rule.config || {};
        const conds = [];
        if (c.minBattery) conds.push(qsTr("battery ≥ %1%").arg(c.minBattery));
        if (c.skipIfCleanedWithinH) conds.push(qsTr("skip if cleaned in last %1 h").arg(c.skipIfCleanedWithinH));
        if (c.onlyWhenAway) conds.push(qsTr("only when nobody's home"));
        if (c.onRobot && rule.type === "schedule") conds.push(qsTr("runs on the robot"));
        let what;
        const roomNames = (c.rooms || []).map((id) => {
            const r = (daemon.status.rooms || []).find((x) => x.id === id);
            return r && r.name ? r.name : qsTr("Room %1").arg(id);
        });
        if (roomNames.length) conds.unshift(qsTr("only %1").arg(roomNames.join(" → ")));
        if (c.routineId) {
            const rt = (daemon.status.routines || []).find((x) => x.id === c.routineId);
            conds.unshift(rt ? qsTr("routine “%1”").arg(rt.name) : qsTr("missing routine"));
        }
        if (rule.type === "schedule") {
            const names = Fmt.dayNames();
            const days = c.days && c.days.length && c.days.length < 7 ? c.days.map((d) => names[d]).join(", ") : qsTr("every day");
            what = qsTr("Clean at %1, %2").arg(c.time).arg(days);
        } else if (rule.type === "away") {
            what = qsTr("Clean %1 min after everyone leaves").arg(c.delayMin || 0);
        } else {
            what = c.action === "pause" ? qsTr("Pause when someone comes home") : qsTr("Send to dock when someone comes home");
        }
        return conds.length ? what + " · " + conds.join(" · ") : what;
    }

    onVisibleChanged: if (visible) load()
    Component.onCompleted: load()
    Connections {
        target: daemon
        function onLogAdded(entry) { page.log = [entry].concat(page.log).slice(0, 40); }
    }

    ColumnLayout {
        width: page.availableWidth
        spacing: 16

        Panel {
            title: qsTr("Automations")
            Layout.fillWidth: true
            headerItems: [
                ActionButton { text: qsTr("Add  (N)"); highlighted: true; onClicked: editor.openFor(null) }
            ]

            Label {
                visible: page.rules.length === 0
                Layout.fillWidth: true
                wrapMode: Text.Wrap
                color: Ui.muted
                text: qsTr("No automations yet. Add a schedule (like weekdays at 10:00, skipped if it already cleaned today), or have Sweep clean when everyone leaves the house.")
            }
            Repeater {
                model: page.rules
                RowLayout {
                    required property var modelData
                    Layout.fillWidth: true
                    spacing: 12
                    Switch { checked: modelData.enabled; onToggled: page.toggleRule(modelData, checked) }
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 2
                        Label { text: modelData.name; color: modelData.enabled ? Ui.text : Ui.faint; font.pixelSize: 15 }
                        Label { text: page.describe(modelData); color: Ui.muted; font.pixelSize: 12; Layout.fillWidth: true; wrapMode: Text.Wrap }
                        Label { text: qsTr("Last ran %1").arg(Fmt.ago(modelData.lastRun)); color: Ui.faint; font.pixelSize: 11 }
                    }
                    ActionButton { text: qsTr("Edit"); flat: true; onClicked: editor.openFor(modelData) }
                }
            }
        }

        GridLayout {
            Layout.fillWidth: true
            columns: page.width > 900 ? 2 : 1
            columnSpacing: 16
            rowSpacing: 16

            Panel {
                title: qsTr("Who's home")
                Layout.fillWidth: true
                Layout.preferredWidth: 1
                Layout.fillHeight: true
                Label {
                    Layout.fillWidth: true
                    wrapMode: Text.Wrap
                    color: Ui.muted
                    text: qsTr("Add your phones' IP addresses (give them fixed addresses in your router). Sweep counts someone as gone when their phone hasn't answered for a while.")
                }
                Repeater {
                    model: page.presence.devices || []
                    RowLayout {
                        required property var modelData
                        required property int index
                        Layout.fillWidth: true
                        Rectangle {
                            width: 8; height: 8; radius: 4
                            color: modelData.lastSeen && Date.now() - modelData.lastSeen < (page.presence.awayAfterMin || 15) * 60000 ? Ui.good : Ui.faint
                        }
                        Label { text: modelData.name; color: Ui.text; Layout.fillWidth: true }
                        Label { text: modelData.ip; color: Ui.muted }
                        Label { text: qsTr("seen %1").arg(Fmt.ago(modelData.lastSeen)); color: Ui.faint; font.pixelSize: 12 }
                        ToolButton {
                            text: "✕"
                            onClicked: {
                                const devices = page.presence.devices.filter((d, i) => i !== index);
                                daemon.send("PUT", "/api/presence", { devices, awayAfterMin: page.presence.awayAfterMin }, (ok, d) => page.saved(ok, d, qsTr("devices")));
                            }
                        }
                    }
                }
                RowLayout {
                    Layout.fillWidth: true
                    TextField { id: devName; placeholderText: qsTr("Name"); Layout.preferredWidth: 140 }
                    TextField { id: devIp; placeholderText: qsTr("Phone IP, e.g. 10.0.0.23"); Layout.fillWidth: true; validator: RegularExpressionValidator { regularExpression: /^\d{1,3}(\.\d{1,3}){3}$/ } }
                    ActionButton {
                        text: qsTr("Add")
                        enabled: devIp.acceptableInput
                        onClicked: {
                            const devices = (page.presence.devices || []).map((d) => ({ name: d.name, ip: d.ip }));
                            devices.push({ name: devName.text || devIp.text, ip: devIp.text });
                            daemon.send("PUT", "/api/presence", { devices, awayAfterMin: page.presence.awayAfterMin }, (ok, d) => page.saved(ok, d, qsTr("devices")));
                            devName.text = ""; devIp.text = "";
                        }
                    }
                }
                RowLayout {
                    Label { text: qsTr("Count as away after"); color: Ui.muted }
                    SpinBox {
                        from: 5; to: 120; stepSize: 5
                        value: page.presence.awayAfterMin || 15
                        onValueModified: daemon.send("PUT", "/api/presence", { devices: page.presence.devices.map((d) => ({ name: d.name, ip: d.ip })), awayAfterMin: value }, (ok, d) => page.saved(ok, d, qsTr("presence")))
                    }
                    Label { text: qsTr("minutes"); color: Ui.muted }
                }
            }

            Panel {
                title: qsTr("Quiet hours & alerts")
                Layout.fillWidth: true
                Layout.preferredWidth: 1
                Layout.fillHeight: true
                Switch {
                    text: qsTr("Quiet hours: no automatic cleaning")
                    checked: !!page.quiet.enabled
                    onToggled: daemon.send("PUT", "/api/quiet", { enabled: checked }, (ok, d) => page.saved(ok, d, qsTr("quiet hours")))
                }
                RowLayout {
                    enabled: !!page.quiet.enabled
                    Label { text: qsTr("From"); color: Ui.muted; Layout.leftMargin: 12 }
                    TextField {
                        text: page.quiet.start || "22:00"
                        implicitWidth: 80
                        inputMask: "99:99"
                        onEditingFinished: if (text !== page.quiet.start) daemon.send("PUT", "/api/quiet", { start: text }, (ok, d) => page.saved(ok, d, qsTr("quiet hours")))
                    }
                    Label { text: qsTr("to"); color: Ui.muted }
                    TextField {
                        text: page.quiet.end || "08:00"
                        implicitWidth: 80
                        inputMask: "99:99"
                        onEditingFinished: if (text !== page.quiet.end) daemon.send("PUT", "/api/quiet", { end: text }, (ok, d) => page.saved(ok, d, qsTr("quiet hours")))
                    }
                }
                Switch {
                    text: qsTr("Retry poor room cleans once, with two passes")
                    checked: !!page.review.autoRetry
                    onToggled: daemon.send("PUT", "/api/review", { autoRetry: checked }, (ok, d) => { if (ok) page.review = d; else page.saved(ok, d, qsTr("retry setting")); })
                }
                Label { text: qsTr("Desktop notifications"); color: Ui.muted; Layout.topMargin: 8 }
                Repeater {
                    model: [
                        { key: "stuck", label: qsTr("Robot is stuck or has an error") },
                        { key: "binFull", label: qsTr("Bin is full") },
                        { key: "finished", label: qsTr("Cleaning finished, with a summary") },
                        { key: "lowBattery", label: qsTr("Battery low away from the dock") },
                        { key: "offline", label: qsTr("Robot unreachable for 10 minutes") },
                        { key: "automation", label: qsTr("An automation started or docked the robot") },
                        { key: "maintenance", label: qsTr("Maintenance is due") },
                        { key: "review", label: qsTr("A clean looked poor (with what went wrong)") },
                        { key: "health", label: qsTr("Early warning about wear or faults") }
                    ]
                    CheckBox {
                        required property var modelData
                        Layout.fillWidth: true
                        text: modelData.label
                        checked: page.alertCfg[modelData.key] !== false
                        onToggled: {
                            const body = {};
                            body[modelData.key] = checked;
                            daemon.send("PUT", "/api/alerts", body, (ok, d) => page.saved(ok, d, qsTr("alerts")));
                        }
                    }
                }
            }
        }

        Panel {
            title: qsTr("Activity log")
            Layout.fillWidth: true
            Label { visible: page.log.length === 0; text: qsTr("Nothing logged yet"); color: Ui.faint }
            Repeater {
                model: page.log
                RowLayout {
                    required property var modelData
                    Layout.fillWidth: true
                    spacing: 12
                    Label { text: Fmt.dateTime(modelData.t); color: Ui.faint; font.pixelSize: 12; Layout.preferredWidth: 150 }
                    Label { text: modelData.kind; color: Ui.muted; font.pixelSize: 12; Layout.preferredWidth: 80 }
                    Label { text: modelData.message; color: modelData.kind === "error" ? Ui.bad : Ui.text; Layout.fillWidth: true; elide: Text.ElideRight }
                }
            }
        }
    }

    AutomationEditor {
        id: editor
        onSaved: page.load()
    }
    Shortcut { sequence: "N"; enabled: page.visible && !editor.visible; onActivated: editor.openFor(null) }
}
