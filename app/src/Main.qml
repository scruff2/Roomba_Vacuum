import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts

ApplicationWindow {
    id: window
    width: 1180
    height: 780
    minimumWidth: 760
    minimumHeight: 520
    visible: true
    title: daemon.status.name ? qsTr("Sweep · %1").arg(daemon.status.name) : "Sweep"
    color: Ui.window

    Material.theme: Material.Dark
    Material.accent: theme.accent
    Material.roundedScale: theme.radius

    property bool helpVisible: false
    property int pageIndex: 0

    readonly property var pages: [
        { title: qsTr("Home"), key: "1" },
        { title: qsTr("Rooms"), key: "2" },
        { title: qsTr("History"), key: "3" },
        { title: qsTr("Automations"), key: "4" },
        { title: qsTr("Settings"), key: "5" },
        { title: qsTr("Health"), key: "6" }
    ]

    // Messages from pages and commands, shown briefly at the bottom.
    function toast(text, isError) {
        toastLabel.text = text;
        toastBox.isError = !!isError;
        toastBox.opacity = 1;
        toastTimer.restart();
    }
    Connections {
        target: daemon
        function onNotice(text, error) { window.toast(text, error) }
    }

    readonly property string phase: daemon.status.phase || ""
    readonly property bool canCommand: daemon.online && !!daemon.status.connected

    // Keyboard first: every action has a key.
    Shortcut { sequence: "?"; context: Qt.ApplicationShortcut; onActivated: window.helpVisible = !window.helpVisible }
    Shortcut { sequence: "Esc"; context: Qt.ApplicationShortcut; enabled: window.helpVisible; onActivated: window.helpVisible = false }
    Shortcut { sequence: "Q"; context: Qt.ApplicationShortcut; onActivated: Qt.quit() }
    Shortcut { sequence: "1"; context: Qt.ApplicationShortcut; onActivated: window.pageIndex = 0 }
    Shortcut { sequence: "2"; context: Qt.ApplicationShortcut; onActivated: window.pageIndex = 1 }
    Shortcut { sequence: "3"; context: Qt.ApplicationShortcut; onActivated: window.pageIndex = 2 }
    Shortcut { sequence: "4"; context: Qt.ApplicationShortcut; onActivated: window.pageIndex = 3 }
    Shortcut { sequence: "5"; context: Qt.ApplicationShortcut; onActivated: window.pageIndex = 4 }
    Shortcut { sequence: "6"; context: Qt.ApplicationShortcut; onActivated: window.pageIndex = 5 }
    Shortcut {
        sequence: "Space"; context: Qt.ApplicationShortcut; enabled: window.canCommand
        onActivated: daemon.command(window.phase === "run" ? "pause" : "start")
    }
    Shortcut { sequence: "R"; context: Qt.ApplicationShortcut; enabled: window.canCommand; onActivated: daemon.command("resume") }
    Shortcut { sequence: "D"; context: Qt.ApplicationShortcut; enabled: window.canCommand; onActivated: daemon.command("dock") }
    Shortcut { sequence: "F"; context: Qt.ApplicationShortcut; enabled: window.canCommand; onActivated: daemon.command("find") }
    Shortcut { sequence: "E"; context: Qt.ApplicationShortcut; enabled: window.canCommand && window.phase === "charge"; onActivated: daemon.command("evac") }

    // Right-to-left languages mirror the window; the Translator sets the
    // application's layout direction.
    Item {
        anchors.fill: parent
        LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
        LayoutMirroring.childrenInherit: true

        RowLayout {
            anchors.fill: parent
            spacing: 0

            // Sidebar
            Rectangle {
                Layout.fillHeight: true
                Layout.preferredWidth: 210
                color: Ui.sidebar
                Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: Ui.border }

                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: 14
                    spacing: 4

                    RowLayout {
                        Layout.bottomMargin: 18
                        Layout.topMargin: 6
                        spacing: 10
                        Rectangle {
                            width: 30; height: 30; radius: 15
                            color: theme.accent
                            Rectangle { anchors.centerIn: parent; width: 14; height: 14; radius: 7; color: "transparent"; border.color: theme.accentForeground; border.width: 2 }
                        }
                        ColumnLayout {
                            spacing: 0
                            Label { text: "Sweep"; font.pixelSize: 18; font.weight: Font.DemiBold; color: Ui.text }
                            Label { text: daemon.status.name || qsTr("Robot vacuum"); color: Ui.muted; font.pixelSize: 12; elide: Text.ElideRight; Layout.maximumWidth: 140 }
                        }
                    }

                    Repeater {
                        model: window.pages
                        ItemDelegate {
                            required property var modelData
                            required property int index
                            Layout.fillWidth: true
                            highlighted: window.pageIndex === index
                            onClicked: window.pageIndex = index
                            contentItem: RowLayout {
                                Label { text: modelData.title; color: highlighted ? Ui.text : Ui.muted; Layout.fillWidth: true; font.weight: highlighted ? Font.DemiBold : Font.Normal }
                                Label { text: modelData.key; color: Ui.faint; font.pixelSize: 11 }
                            }
                        }
                    }

                    Item { Layout.fillHeight: true }

                    // Connection status
                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 6
                        RowLayout {
                            spacing: 8
                            Rectangle { width: 8; height: 8; radius: 4; color: daemon.online ? Ui.good : Ui.bad }
                            Label { text: daemon.online ? qsTr("sweepd running") : qsTr("sweepd not running"); color: Ui.muted; font.pixelSize: 12 }
                        }
                        RowLayout {
                            spacing: 8
                            Rectangle { width: 8; height: 8; radius: 4; color: daemon.status.connected ? Ui.good : Ui.bad }
                            Label { text: daemon.status.connected ? qsTr("Robot connected") : qsTr("Robot not connected"); color: Ui.muted; font.pixelSize: 12 }
                        }
                        RowLayout {
                            visible: daemon.status.battery != null
                            spacing: 8
                            Rectangle { width: 8; height: 8; radius: 4; color: "transparent"; border.color: Ui.faint }
                            Label { text: qsTr("Battery %1%").arg(daemon.status.battery); color: Ui.muted; font.pixelSize: 12 }
                        }
                        Label { text: qsTr("? for shortcuts"); color: Ui.faint; font.pixelSize: 11; Layout.topMargin: 6 }
                    }
                }
            }

            // Content
            ColumnLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 0

                Rectangle {
                    visible: !daemon.online || !!daemon.status.configError
                    Layout.fillWidth: true
                    implicitHeight: banner.implicitHeight + 24
                    color: Qt.rgba(1, 0.42, 0.42, 0.12)
                    Label {
                        id: banner
                        anchors.fill: parent
                        anchors.margins: 12
                        wrapMode: Text.Wrap
                        color: Ui.bad
                        textFormat: Text.PlainText
                        text: !daemon.online
                              ? qsTr("Can't reach sweepd at %1. Start it with: systemctl --user start sweepd").arg(daemon.baseUrl)
                              : qsTr("sweepd can't read its configuration: %1").arg(daemon.status.configError)
                    }
                }

                Label {
                    text: window.pages[window.pageIndex].title
                    font.pixelSize: 24
                    font.weight: Font.DemiBold
                    color: Ui.text
                    Layout.leftMargin: 24
                    Layout.topMargin: 20
                    Layout.bottomMargin: 8
                }

                StackLayout {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    Layout.leftMargin: 24
                    Layout.rightMargin: 12
                    currentIndex: window.pageIndex
                    HomePage {}
                    RoomsPage {}
                    HistoryPage {}
                    AutomationsPage {}
                    SettingsPage {}
                    HealthPage {}
                }
            }
        }

        // Toast
        Rectangle {
            id: toastBox
            property bool isError: false
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.bottom: parent.bottom
            anchors.bottomMargin: 24
            width: toastLabel.implicitWidth + 32
            height: toastLabel.implicitHeight + 18
            radius: Math.min(8, theme.radius)
            color: Ui.panelRaised
            border.color: isError ? Ui.bad : Ui.border
            opacity: 0
            visible: opacity > 0
            Behavior on opacity { NumberAnimation { duration: 180 } }
            Label { id: toastLabel; anchors.centerIn: parent; color: toastBox.isError ? Ui.bad : Ui.text }
            Timer { id: toastTimer; interval: 3200; onTriggered: toastBox.opacity = 0 }
        }

        // Shortcut overlay
        Rectangle {
            anchors.fill: parent
            visible: window.helpVisible
            color: Qt.rgba(0, 0, 0, 0.6)
            MouseArea { anchors.fill: parent; onClicked: window.helpVisible = false }
            Rectangle {
                anchors.centerIn: parent
                width: 420
                height: helpCol.implicitHeight + 40
                radius: theme.radius
                color: Ui.panel
                border.color: Ui.border
                ColumnLayout {
                    id: helpCol
                    anchors.fill: parent
                    anchors.margins: 20
                    spacing: 8
                    Label { text: qsTr("Keyboard shortcuts"); font.pixelSize: 18; font.weight: Font.DemiBold; color: Ui.text; Layout.bottomMargin: 6 }
                    Repeater {
                        model: [
                            ["Space", qsTr("Start cleaning / pause")],
                            ["R", qsTr("Resume")],
                            ["D", qsTr("Send to dock")],
                            ["F", qsTr("Find robot (plays a sound)")],
                            ["E", qsTr("Empty bin into the base")],
                            ["1 – 6", qsTr("Switch page")],
                            ["C", qsTr("Clean picked rooms (Rooms page)")],
                            ["N", qsTr("New automation (Automations page)")],
                            ["?", qsTr("Show or hide this list")],
                            ["Q", qsTr("Quit")]
                        ]
                        RowLayout {
                            required property var modelData
                            Layout.fillWidth: true
                            Rectangle {
                                Layout.preferredWidth: 70
                                implicitHeight: keyLabel.implicitHeight + 6
                                radius: Math.min(4, theme.radius)
                                color: Ui.panelRaised
                                border.color: Ui.border
                                Label { id: keyLabel; anchors.centerIn: parent; text: modelData[0]; color: Ui.text; font.pixelSize: 12 }
                            }
                            Label { text: modelData[1]; color: Ui.muted; Layout.fillWidth: true; Layout.leftMargin: 8 }
                        }
                    }
                }
            }
        }
    }
}
