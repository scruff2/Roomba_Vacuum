import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts
import "Format.js" as Fmt

ScrollView {
    id: page
    contentWidth: availableWidth
    Material.roundedScale: theme.radius

    property var info: ({ rooms: [] })
    property var selected: []          // room ids in the order they were picked
    readonly property var rooms: info.rooms || []
    readonly property bool canClean: daemon.online && !!daemon.status.connected && !daemon.status.active

    function load() {
        daemon.get("/api/rooms", (ok, d) => { if (ok) page.info = d; });
    }
    function toggle(id) {
        page.selected = page.selected.indexOf(id) >= 0 ? page.selected.filter((x) => x !== id) : page.selected.concat([id]);
    }
    function nameOf(r) { return r.name || qsTr("Room %1").arg(r.id); }
    function clean() {
        const ids = page.selected.slice();
        daemon.send("POST", "/api/rooms/clean", { rooms: ids, ordered: true }, (ok, d) => {
            if (ok) { window.toast(qsTr("Cleaning %n room(s)", "", ids.length), false); page.selected = []; }
            else window.toast(qsTr("Couldn't start: %1").arg(d.error), true);
        });
    }
    function rename(id, name) {
        daemon.send("PUT", "/api/rooms/" + id, { name }, (ok, d) => {
            if (ok) page.info = Object.assign({}, page.info, { rooms: d.rooms });
            else window.toast(qsTr("Couldn't rename: %1").arg(d.error), true);
        });
    }
    function forget(id) {
        daemon.send("DELETE", "/api/rooms/" + id, undefined, (ok, d) => {
            if (ok) { page.info = Object.assign({}, page.info, { rooms: d.rooms }); page.selected = page.selected.filter((x) => x !== id); }
        });
    }

    onVisibleChanged: if (visible) load()
    Component.onCompleted: load()
    Connections {
        target: daemon
        function onLogAdded(entry) { if (entry.kind === "rooms") page.load(); }
    }
    Shortcut { sequence: "C"; enabled: page.visible && page.selected.length > 0 && page.canClean; onActivated: page.clean() }

    ColumnLayout {
        width: page.availableWidth
        spacing: 16

        Panel {
            title: qsTr("Clean rooms")
            Layout.fillWidth: true

            Label {
                visible: page.rooms.length === 0
                Layout.fillWidth: true
                wrapMode: Text.Wrap
                color: Ui.muted
                text: qsTr("No rooms yet. The robot doesn't list its rooms locally, so Sweep learns them from room cleans started in the iRobot app: start a clean of one or more rooms there, and they appear here for you to name.")
            }
            Label {
                visible: page.rooms.length > 0
                color: Ui.muted
                text: qsTr("Pick rooms in the order they should be cleaned.")
            }
            Flow {
                Layout.fillWidth: true
                spacing: 8
                Repeater {
                    model: page.rooms
                    ActionButton {
                        required property var modelData
                        readonly property int order: page.selected.indexOf(modelData.id)
                        text: order >= 0 ? (order + 1) + " · " + page.nameOf(modelData) : page.nameOf(modelData)
                        checkable: true
                        checked: order >= 0
                        highlighted: checked
                        flat: !checked
                        onClicked: page.toggle(modelData.id)
                    }
                }
            }
            RowLayout {
                visible: page.rooms.length > 0
                Layout.fillWidth: true
                ActionButton {
                    text: qsTr("Clean %n room(s)  (C)", "", page.selected.length)
                    highlighted: true
                    enabled: page.selected.length > 0 && page.canClean
                    onClicked: page.clean()
                }
                ActionButton { text: qsTr("Clear"); flat: true; enabled: page.selected.length > 0; onClicked: page.selected = [] }
                ActionButton { text: qsTr("Select all"); flat: true; onClicked: page.selected = page.rooms.map((r) => r.id) }
                Label {
                    visible: !!daemon.status.active
                    text: qsTr("The robot is busy; dock it first.")
                    color: Ui.warn
                }
            }
        }

        Panel {
            title: qsTr("Names")
            Layout.fillWidth: true
            visible: page.rooms.length > 0
            Label {
                Layout.fillWidth: true
                wrapMode: Text.Wrap
                color: Ui.muted
                text: qsTr("The robot only knows rooms by number. Name each one the way it's named in the iRobot app.")
            }
            Repeater {
                model: page.rooms
                RowLayout {
                    required property var modelData
                    Layout.fillWidth: true
                    spacing: 12
                    Label { text: "#" + modelData.id; color: Ui.faint; Layout.preferredWidth: 40 }
                    TextField {
                        Layout.fillWidth: true
                        text: modelData.name || ""
                        placeholderText: qsTr("Name, e.g. Kitchen")
                        onEditingFinished: if (text !== (modelData.name || "")) page.rename(modelData.id, text)
                    }
                    Label { text: modelData.type === "zid" ? qsTr("zone") : qsTr("room"); color: Ui.muted }
                    ActionButton { text: qsTr("Forget"); flat: true; onClicked: page.forget(modelData.id) }
                }
            }
        }

        Panel {
            title: qsTr("Map")
            Layout.fillWidth: true
            StatLine { label: qsTr("Map in use"); value: page.info.pmapId || qsTr("None captured yet") }
            StatLine { label: qsTr("Map version"); value: page.info.currentVersion || page.info.version || "—" }
            StatLine { label: qsTr("Maps on the robot"); value: Fmt.number((page.info.maps || []).length) }
            Label {
                Layout.fillWidth: true
                wrapMode: Text.Wrap
                color: Ui.faint
                font.pixelSize: 12
                text: qsTr("Editing the map in the iRobot app keeps room numbers; creating a new map resets them, and Sweep will ask you to name rooms again.")
            }
            RowLayout {
                ActionButton {
                    text: qsTr("Start a mapping run")
                    enabled: page.canClean
                    onClicked: daemon.command("train")
                }
                Label { text: qsTr("Explores without vacuuming to improve the map."); color: Ui.muted }
            }
        }
    }
}
