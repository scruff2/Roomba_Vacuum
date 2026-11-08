import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts
import "Format.js" as Fmt

// Add or edit one automation rule.
Dialog {
    id: dlg
    signal saved()
    property var rule: null
    property var days: [0, 1, 2, 3, 4, 5, 6]
    property var rooms: []          // room ids, in cleaning order; empty = whole house
    readonly property var knownRooms: daemon.status.rooms || []

    modal: true
    anchors.centerIn: Overlay.overlay
    width: Math.min(560, Overlay.overlay ? Overlay.overlay.width - 40 : 560)
    title: rule ? qsTr("Edit automation") : qsTr("New automation")
    Material.roundedScale: theme.radius

    function openFor(r) {
        rule = r;
        const c = r ? r.config || {} : {};
        nameField.text = r ? r.name : "";
        typeBox.currentIndex = r ? ["schedule", "away", "arrive"].indexOf(r.type) : 0;
        timeField.text = c.time || "10:00";
        days = c.days && c.days.length ? c.days.slice() : [0, 1, 2, 3, 4, 5, 6];
        minBattery.value = c.minBattery || 0;
        skipHours.value = c.skipIfCleanedWithinH || 0;
        onlyAway.checked = !!c.onlyWhenAway;
        delay.value = c.delayMin != null ? c.delayMin : 10;
        arriveAction.currentIndex = c.action === "pause" ? 1 : 0;
        rooms = c.rooms ? c.rooms.slice() : [];
        error.text = "";
        open();
        nameField.forceActiveFocus();
    }

    function save() {
        const type = ["schedule", "away", "arrive"][typeBox.currentIndex];
        const config = {};
        if (type === "schedule") { config.time = timeField.text; config.days = days.slice().sort(); }
        if (type === "away") config.delayMin = delay.value;
        if (type === "arrive") config.action = arriveAction.currentIndex === 1 ? "pause" : "dock";
        if (type !== "arrive") {
            if (rooms.length) config.rooms = rooms.slice();
            if (minBattery.value) config.minBattery = minBattery.value;
            if (skipHours.value) config.skipIfCleanedWithinH = skipHours.value;
            if (onlyAway.checked && type === "schedule") config.onlyWhenAway = true;
        }
        const body = { name: nameField.text.trim(), type, enabled: rule ? rule.enabled : true, config };
        const done = (ok, d) => {
            if (!ok) { error.text = d.error; return; }
            dlg.saved();
            dlg.close();
        };
        if (rule) daemon.send("PUT", "/api/automations/" + rule.id, body, done);
        else daemon.send("POST", "/api/automations", body, done);
    }

    function remove() {
        daemon.send("DELETE", "/api/automations/" + rule.id, undefined, (ok, d) => {
            if (!ok) { error.text = d.error; return; }
            dlg.saved();
            dlg.close();
        });
    }

    footer: DialogButtonBox {
        ActionButton { text: qsTr("Delete"); flat: true; visible: !!dlg.rule; DialogButtonBox.buttonRole: DialogButtonBox.ActionRole; onClicked: dlg.remove() }
        ActionButton { text: qsTr("Cancel"); flat: true; DialogButtonBox.buttonRole: DialogButtonBox.RejectRole }
        ActionButton { text: qsTr("Save"); highlighted: true; enabled: nameField.text.trim() !== ""; DialogButtonBox.buttonRole: DialogButtonBox.ActionRole; onClicked: dlg.save() }
        onRejected: dlg.close()
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 10

        TextField { id: nameField; placeholderText: qsTr("Name, e.g. Weekday morning"); Layout.fillWidth: true; onAccepted: if (text.trim()) dlg.save() }
        ComboBox {
            id: typeBox
            Layout.fillWidth: true
            model: [qsTr("At a set time"), qsTr("When everyone leaves"), qsTr("When someone comes home")]
        }

        // Schedule
        ColumnLayout {
            visible: typeBox.currentIndex === 0
            Layout.fillWidth: true
            RowLayout {
                Label { text: qsTr("Time"); color: Ui.muted; Layout.preferredWidth: 110 }
                TextField { id: timeField; inputMask: "99:99"; implicitWidth: 80 }
            }
            RowLayout {
                Label { text: qsTr("Days"); color: Ui.muted; Layout.preferredWidth: 110 }
                Repeater {
                    // Start the week on the locale's first day.
                    model: [0, 1, 2, 3, 4, 5, 6].map((i) => (i + Qt.locale().firstDayOfWeek) % 7)
                    ActionButton {
                        required property int modelData
                        text: Fmt.dayNames()[modelData]
                        checkable: true
                        checked: dlg.days.indexOf(modelData) >= 0
                        highlighted: checked
                        flat: !checked
                        implicitWidth: 52
                        onToggled: dlg.days = checked ? dlg.days.concat([modelData]) : dlg.days.filter((d) => d !== modelData)
                    }
                }
            }
        }
        // Away
        RowLayout {
            visible: typeBox.currentIndex === 1
            Label { text: qsTr("Wait"); color: Ui.muted; Layout.preferredWidth: 110 }
            SpinBox { id: delay; from: 0; to: 240; stepSize: 5 }
            Label { text: qsTr("minutes after the last person leaves"); color: Ui.muted }
        }
        // Arrive
        RowLayout {
            visible: typeBox.currentIndex === 2
            Label { text: qsTr("Then"); color: Ui.muted; Layout.preferredWidth: 110 }
            ComboBox { id: arriveAction; model: [qsTr("Send it to the dock"), qsTr("Pause it")]; Layout.fillWidth: true }
        }

        // What to clean
        ColumnLayout {
            visible: typeBox.currentIndex !== 2 && dlg.knownRooms.length > 0
            Layout.fillWidth: true
            Label { text: qsTr("Clean (pick rooms in order, or none for the whole house)"); color: Ui.muted; Layout.topMargin: 6 }
            Flow {
                Layout.fillWidth: true
                spacing: 6
                Repeater {
                    model: dlg.knownRooms
                    ActionButton {
                        required property var modelData
                        readonly property int order: dlg.rooms.indexOf(modelData.id)
                        text: (order >= 0 ? (order + 1) + " · " : "") + (modelData.name || qsTr("Room %1").arg(modelData.id))
                        checkable: true
                        checked: order >= 0
                        highlighted: checked
                        flat: !checked
                        onClicked: dlg.rooms = order >= 0 ? dlg.rooms.filter((x) => x !== modelData.id) : dlg.rooms.concat([modelData.id])
                    }
                }
            }
        }

        // Conditions for starting a clean
        Label { visible: typeBox.currentIndex !== 2; text: qsTr("Only if…"); color: Ui.muted; Layout.topMargin: 6 }
        RowLayout {
            visible: typeBox.currentIndex !== 2
            Label { text: qsTr("Battery at least"); color: Ui.text; Layout.preferredWidth: 200 }
            SpinBox { id: minBattery; from: 0; to: 100; stepSize: 10 }
            Label { text: "%"; color: Ui.muted }
        }
        RowLayout {
            visible: typeBox.currentIndex !== 2
            Label { text: qsTr("Skip if it cleaned within"); color: Ui.text; Layout.preferredWidth: 200 }
            SpinBox { id: skipHours; from: 0; to: 168; stepSize: 6 }
            Label { text: qsTr("hours (0 = never skip)"); color: Ui.muted }
        }
        CheckBox { id: onlyAway; visible: typeBox.currentIndex === 0; text: qsTr("Only when nobody's home") }
        Label { visible: typeBox.currentIndex !== 2; text: qsTr("Quiet hours always block automatic starts."); color: Ui.faint; font.pixelSize: 12 }
        Label { id: error; color: Ui.bad; visible: text !== ""; Layout.fillWidth: true; wrapMode: Text.Wrap }
    }
}
