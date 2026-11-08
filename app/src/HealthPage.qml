import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts
import "Format.js" as Fmt

ScrollView {
    id: page
    contentWidth: availableWidth
    Material.roundedScale: theme.radius
    property var h: null
    property var samples: []
    property bool refreshing: false

    function load() {
        daemon.get("/api/health", (ok, data) => { if (ok) page.h = data; });
        daemon.get("/api/samples?hours=24", (ok, data) => { if (ok) page.samples = data; });
    }
    function refreshCounters() {
        page.refreshing = true;
        daemon.send("POST", "/api/refresh", {}, (ok, data) => {
            page.refreshing = false;
            if (ok) { window.toast(qsTr("Counters refreshed"), false); page.load(); }
            else window.toast(qsTr("Couldn't refresh: %1").arg(data.error), true);
        });
    }
    onVisibleChanged: if (visible) load()
    Component.onCompleted: load()
    Timer { interval: 60000; running: page.visible; repeat: true; onTriggered: page.load() }

    function v(path) {
        let o = page.h;
        for (const k of path.split(".")) { if (o == null) return null; o = o[k]; }
        return o;
    }
    readonly property var bat: v("battery") || {}
    readonly property var chg: v("charging") || {}
    readonly property var resets: v("resets") || {}
    readonly property var run: v("lifetime.run") || {}
    readonly property var sw: v("lifetime.switches") || {}
    readonly property var mssn: v("lifetime.missions") || {}
    readonly property var cleaning: v("lifetime.cleaning") || {}
    readonly property var nav: v("navigation") || {}

    ColumnLayout {
        width: page.availableWidth
        spacing: 16

        RowLayout {
            Layout.fillWidth: true
            Label {
                Layout.fillWidth: true
                color: Ui.muted
                wrapMode: Text.Wrap
                text: qsTr("The robot only sends these counters when Sweep connects. Last updated %1.").arg(Fmt.ago(page.h ? page.h.countersUpdated : 0))
            }
            ActionButton { text: qsTr("Refresh counters"); enabled: !page.refreshing && daemon.online; onClicked: page.refreshCounters() }
        }

        MaintenancePanel { Layout.fillWidth: true }

        GridLayout {
            Layout.fillWidth: true
            columns: page.width > 1000 ? 3 : page.width > 640 ? 2 : 1
            columnSpacing: 16
            rowSpacing: 16

            Panel {
                title: qsTr("Battery")
                Layout.fillWidth: true
                Layout.fillHeight: true
                RowLayout {
                    spacing: 24
                    BigNumber { value: Fmt.number(page.bat.cycles); caption: qsTr("charge cycles") }
                    BigNumber { value: page.bat.ageDays != null ? (page.bat.ageDays / 365).toLocaleString(Qt.locale(), 'f', 1) : "—"; caption: qsTr("years old") }
                }
                StatLine { label: qsTr("Charge now"); value: page.bat.percent != null ? page.bat.percent + "%" : "—" }
                StatLine { label: qsTr("Made by"); value: page.bat.manufacturer || "—" }
                StatLine { label: qsTr("Manufactured"); value: page.bat.manufactured || "—" }
                StatLine { label: qsTr("Type"); value: page.bat.type || "—" }
            }

            Panel {
                title: qsTr("Charging")
                Layout.fillWidth: true
                Layout.fillHeight: true
                StatLine { label: qsTr("Successful charges"); value: Fmt.number(page.chg.nChgOk) }
                StatLine { label: qsTr("Charging errors"); value: Fmt.number(page.chg.nChgErr); valueColor: page.chg.nChgErr ? Ui.warn : Ui.text }
                StatLine { label: qsTr("Knocked off dock"); value: Fmt.number(page.chg.nKnockoffs); hint: qsTr("Times the robot lost contact with the dock while charging") }
                StatLine { label: qsTr("Contact chatter"); value: Fmt.number(page.chg.nChatters); hint: qsTr("Brief charging contact interruptions; a high count can mean dirty contacts") }
                StatLine { label: qsTr("Aborted charges"); value: page.chg.aborts ? Fmt.number(page.chg.aborts.reduce((a, b) => a + b, 0)) : "—" }
                StatLine { label: qsTr("Battery bus errors"); value: Fmt.number(page.chg.smberr) }
            }

            Panel {
                title: qsTr("Reliability")
                Layout.fillWidth: true
                Layout.fillHeight: true
                StatLine { label: qsTr("Missions completed"); value: page.mssn.nMssn ? qsTr("%1 of %2 (%3%)").arg(Fmt.number(page.mssn.nMssnOk)).arg(Fmt.number(page.mssn.nMssn)).arg(Math.round(100 * page.mssn.nMssnOk / page.mssn.nMssn)) : "—" }
                StatLine { label: qsTr("Missions failed"); value: Fmt.number(page.mssn.nMssnF) }
                StatLine { label: qsTr("Navigation restarts"); value: Fmt.number(page.resets.nNavRst) }
                StatLine { label: qsTr("Drive system restarts"); value: Fmt.number(page.resets.nMobRst) }
                StatLine { label: qsTr("Out-of-memory restarts"); value: Fmt.number(page.resets.nOomRst); valueColor: page.resets.nOomRst ? Ui.warn : Ui.text }
                StatLine { label: qsTr("Safety restarts"); value: Fmt.number(page.resets.nSafRst) }
            }

            Panel {
                title: qsTr("Lifetime")
                Layout.fillWidth: true
                Layout.fillHeight: true
                RowLayout {
                    spacing: 24
                    BigNumber { value: Fmt.number(page.cleaning.hr); caption: qsTr("hours cleaning") }
                    BigNumber { value: Fmt.number(page.mssn.nMssn); caption: qsTr("missions") }
                }
                StatLine { label: qsTr("Average mission"); value: Fmt.minutes(page.mssn.aMssnM) }
                StatLine { label: qsTr("Bin emptied by base"); value: Fmt.number(page.run.nEvacs) }
                StatLine { label: qsTr("Powered on"); value: page.v("lifetime.poweredOn.hr") != null ? qsTr("%1 h").arg(Fmt.number(page.v("lifetime.poweredOn.hr"))) : "—" }
            }

            Panel {
                title: qsTr("Obstacles & sensors")
                Layout.fillWidth: true
                Layout.fillHeight: true
                StatLine { label: qsTr("Bumper presses"); value: Fmt.number(page.sw.nBumper) }
                StatLine { label: qsTr("Cliffs avoided"); value: Fmt.number(page.run.nCliffsF) }
                StatLine { label: qsTr("Got stuck"); value: Fmt.number(page.run.nStuck) }
                StatLine { label: qsTr("Wheel drops"); value: Fmt.number(page.sw.nDrops) }
                StatLine { label: qsTr("Picked up"); value: Fmt.number(page.run.nPicks) }
                StatLine { label: qsTr("Brush stalls"); value: Fmt.number(page.run.nMBStll); hint: qsTr("Main brush stopped by tangles; worth cleaning the brushes if this climbs quickly") }
                StatLine { label: qsTr("Escape manoeuvres"); value: Fmt.number(page.run.nPanics) }
            }

            Panel {
                title: qsTr("Navigation (last mission)")
                Layout.fillWidth: true
                Layout.fillHeight: true
                StatLine { label: qsTr("Landmarks seen"); value: Fmt.number(page.nav.lmk) }
                StatLine { label: qsTr("Good landmarks"); value: Fmt.number(page.nav.gLmk) }
                StatLine { label: qsTr("Relocalizations"); value: Fmt.number(page.nav.reLc) }
                StatLine { label: qsTr("Planner"); value: page.nav.plnErr || "—" }
                StatLine { label: qsTr("Map state"); value: page.nav.mpSt || "—" }
                StatLine { label: qsTr("Floor tracking quality"); value: page.nav.h_squal != null ? page.nav.h_squal + "%" : "—" }
            }
        }

        Panel {
            title: qsTr("Wi-Fi signal and battery, last 24 hours")
            Layout.fillWidth: true
            LineChart {
                Layout.fillWidth: true
                Layout.preferredHeight: 170
                ySuffix: " dBm"
                series: [{ color: theme.accent, points: page.samples.map((x) => [x.t, x.rssi]) }]
            }
            LineChart {
                Layout.fillWidth: true
                Layout.preferredHeight: 130
                yMin: 0; yMax: 100; ySuffix: "%"
                series: [{ color: Ui.good, points: page.samples.map((x) => [x.t, x.battery]) }]
            }
        }

        GridLayout {
            Layout.fillWidth: true
            columns: page.width > 800 ? 2 : 1
            columnSpacing: 16
            rowSpacing: 16

            Panel {
                title: qsTr("Firmware")
                Layout.fillWidth: true
                Layout.fillHeight: true
                StatLine { label: qsTr("Software"); value: page.v("firmware.software") ? page.v("firmware.software").split("+")[1] : "—" }
                Repeater {
                    model: page.v("firmware.modules") ? Object.keys(page.v("firmware.modules")) : []
                    StatLine {
                        required property string modelData
                        label: modelData
                        // Versions look like "sapphire-nav+24.29.3+Firmware-…"; show the first part with a version number.
                        value: {
                            const parts = String(page.v("firmware.modules")[modelData]).split("+");
                            return parts.find((p) => /\d+\.\d+/.test(p)) || parts[0];
                        }
                    }
                }
            }
            Panel {
                title: qsTr("Dock & connection")
                Layout.fillWidth: true
                Layout.fillHeight: true
                StatLine { label: qsTr("Dock firmware"); value: page.v("dock.fwVer") || "—" }
                StatLine { label: qsTr("Dock part number"); value: page.v("dock.pn") || "—" }
                StatLine { label: qsTr("Auto-empty"); value: page.v("dock.cap.evac") ? qsTr("Supported") : qsTr("No") }
                StatLine { label: qsTr("Wi-Fi"); value: Fmt.signal(page.v("wifi.signal.rssi")) }
                StatLine { label: qsTr("Signal-to-noise"); value: page.v("wifi.signal.snr") != null ? page.v("wifi.signal.snr") + " dB" : "—" }
                StatLine { label: qsTr("Band"); value: page.v("wifi.net.freq") ? (page.v("wifi.net.freq") > 4000 ? qsTr("5 GHz (%1 MHz)") : qsTr("2.4 GHz (%1 MHz)")).arg(page.v("wifi.net.freq")) : "—" }
                StatLine { label: qsTr("Address"); value: page.v("wifi.net.addr") || "—" }
                StatLine { label: qsTr("Hardware"); value: page.v("hardware") ? qsTr("nav board %1 · drive board %2 · IMU %3").arg(page.v("hardware.navBoard")).arg(page.v("hardware.mobilityBoard")).arg(page.v("hardware.imu")) : "—" }
            }
        }
    }
}
