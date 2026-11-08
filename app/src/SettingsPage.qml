import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts
import "Format.js" as Fmt

ScrollView {
    id: page
    contentWidth: availableWidth
    Material.roundedScale: theme.radius
    property var settings: ({})
    property var robotSchedule: null
    property string busyKey: ""
    property string loadError: ""

    function load() {
        daemon.get("/api/settings", (ok, data) => {
            if (!ok) { page.loadError = data.error; return; }
            page.loadError = "";
            page.settings = data.settings;
            page.robotSchedule = data.robotSchedule;
        });
    }
    function apply(key, value) {
        page.busyKey = key;
        const body = {};
        body[key] = value;
        daemon.send("PUT", "/api/settings", body, (ok, data) => {
            page.busyKey = "";
            if (ok) {
                page.settings = data.settings;
                window.toast(data.confirmed ? qsTr("Saved on the robot") : qsTr("Sent, but the robot hasn't confirmed yet"), !data.confirmed);
            } else {
                window.toast(qsTr("Couldn't change setting: %1").arg(data.error), true);
                page.load();
            }
        });
    }

    onVisibleChanged: if (visible) load()
    Component.onCompleted: load()

    readonly property var descriptions: ({
        passes: qsTr("Auto lets the robot decide; two passes cleans everything twice."),
        suction: qsTr("Auto boosts on carpet; performance always runs at full power; eco is quietest."),
        edgeClean: qsTr("Follow walls and edges during cleaning."),
        alwaysFinish: qsTr("When the bin fills mid-clean, keep going instead of pausing for you to empty it."),
        childLock: qsTr("Disables the button on the robot."),
        ecoCharge: qsTr("Charge more slowly to extend battery life."),
        volume: qsTr("How loud the robot's voice and tones are.")
    })
    readonly property var choiceLabels: ({
        auto: qsTr("Auto"), one: qsTr("One"), two: qsTr("Two"),
        eco: qsTr("Eco"), performance: qsTr("Performance")
    })

    ColumnLayout {
        width: page.availableWidth
        spacing: 16

        Label {
            visible: page.loadError !== ""
            text: qsTr("Couldn't load settings: %1").arg(page.loadError)
            color: Ui.bad
        }

        Panel {
            title: qsTr("Cleaning")
            Layout.fillWidth: true
            Repeater {
                model: ["passes", "suction", "edgeClean", "alwaysFinish"]
                delegate: settingRow
            }
        }
        Panel {
            title: qsTr("Robot")
            Layout.fillWidth: true
            Repeater {
                model: ["childLock", "ecoCharge", "volume"]
                delegate: settingRow
            }
        }
        Panel {
            title: qsTr("Robot's own schedule")
            Layout.fillWidth: true
            Label {
                Layout.fillWidth: true
                wrapMode: Text.Wrap
                color: Ui.muted
                text: page.robotSchedule && page.robotSchedule.length
                      ? qsTr("The robot has %n schedule(s) set in the iRobot app. They run independently of Sweep's automations.", "", page.robotSchedule.length)
                      : qsTr("No schedules are stored on the robot. Use the Automations page for smarter schedules that Sweep runs.")
            }
        }
    }

    Component {
        id: settingRow
        ColumnLayout {
            id: row
            required property string modelData
            readonly property var def: page.settings[modelData] || null
            readonly property bool supported: !!def && def.supported
            Layout.fillWidth: true
            Layout.bottomMargin: 8
            spacing: 4
            visible: !!def

            RowLayout {
                Layout.fillWidth: true
                spacing: 12
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2
                    Label { text: row.def ? row.def.label : ""; color: row.supported ? Ui.text : Ui.faint; font.pixelSize: 15 }
                    Label {
                        Layout.fillWidth: true
                        wrapMode: Text.Wrap
                        color: Ui.muted
                        font.pixelSize: 12
                        text: row.supported ? (page.descriptions[row.modelData] || "") : qsTr("This robot doesn't report this setting, so it can't be changed here.")
                    }
                }
                BusyIndicator { running: page.busyKey === row.modelData; visible: running; implicitWidth: 28; implicitHeight: 28 }

                // Choice: segmented buttons
                Row {
                    visible: row.def && row.def.type === "choice"
                    spacing: 4
                    enabled: row.supported && page.busyKey === ""
                    Repeater {
                        model: row.def && row.def.choices ? row.def.choices : []
                        ActionButton {
                            required property string modelData
                            text: page.choiceLabels[modelData] || modelData
                            checkable: true
                            checked: row.def.value === modelData
                            highlighted: checked
                            flat: !checked
                            onClicked: if (row.def.value !== modelData) page.apply(row.modelData, modelData); else checked = true
                        }
                    }
                }
                Switch {
                    visible: row.def && row.def.type === "bool"
                    enabled: row.supported && page.busyKey === ""
                    checked: !!(row.def && row.def.value)
                    onToggled: page.apply(row.modelData, checked)
                }
                RowLayout {
                    visible: row.def && row.def.type === "int"
                    enabled: row.supported && page.busyKey === ""
                    Slider {
                        id: slider
                        from: row.def && row.def.min != null ? row.def.min : 0
                        to: row.def && row.def.max != null ? row.def.max : 100
                        stepSize: 5
                        value: row.def && row.def.value != null ? row.def.value : 0
                        implicitWidth: 200
                        onPressedChanged: if (!pressed && value !== row.def.value) page.apply(row.modelData, Math.round(value))
                    }
                    Label { text: Math.round(slider.value); color: Ui.text; Layout.preferredWidth: 32 }
                }
            }
        }
    }
}
