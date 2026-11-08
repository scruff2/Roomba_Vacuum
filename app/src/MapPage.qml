import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts
import "Format.js" as Fmt

// The robot's saved map from iRobot's cloud: rooms, zones, doors, objects
// and the dock, with click-to-clean and a per-mission coverage overlay.
Item {
    id: page
    Material.roundedScale: theme.radius

    property var info: null          // /api/map response
    readonly property var map: info ? info.map : null
    property var view: ({ rotate: 0, mirror: false })
    property var selected: []        // room/zone keys in cleaning order
    property string hoverKey: ""
    property var coverage: null
    property string coverageId: ""
    property bool loading: false
    property string error: ""

    // Pan/zoom on top of the fitted view.
    property real zoom: 1
    property real panX: 0
    property real panY: 0

    readonly property bool canClean: daemon.online && !!daemon.status.connected && !daemon.status.active
    readonly property var roomInfo: {
        const out = {};
        for (const r of (info && info.rooms) || []) out[r.key] = r;
        return out;
    }

    function load() {
        daemon.get("/api/map", (ok, d) => {
            if (!ok) { page.error = d.error; return; }
            page.error = "";
            page.info = d;
            page.view = d.view || page.view;
            if (!page.coverageId && d.missions && d.missions.length) page.showCoverage(d.missions[0].id);
            canvas.requestPaint();
        });
    }
    function refreshFromCloud() {
        page.loading = true;
        daemon.send("POST", "/api/map/refresh", {}, (ok, d) => {
            page.loading = false;
            if (ok) { window.toast(qsTr("Map updated"), false); page.load(); }
            else window.toast(qsTr("Couldn't update the map: %1").arg(d.error), true);
        });
    }
    function showCoverage(id) {
        page.coverageId = id;
        page.coverage = null;
        canvas.requestPaint();
        if (!id) return;
        daemon.get("/api/map/coverage/" + id, (ok, d) => {
            if (page.coverageId !== id) return;
            if (ok) page.coverage = d; else window.toast(qsTr("Coverage not available: %1").arg(d.error), true);
            canvas.requestPaint();
        });
    }
    function setView(changes) {
        page.view = Object.assign({}, page.view, changes);
        page.resetZoom();
        daemon.send("PUT", "/api/map/view", changes, () => {});
    }
    function resetZoom() { page.zoom = 1; page.panX = 0; page.panY = 0; canvas.requestPaint(); }
    function toggle(key) {
        page.selected = page.selected.indexOf(key) >= 0 ? page.selected.filter((k) => k !== key) : page.selected.concat([key]);
        canvas.requestPaint();
    }
    function nameOf(key) {
        const r = page.roomInfo[key];
        return r && r.name ? r.name : (key[0] === "z" ? qsTr("Zone %1").arg(key.slice(1)) : qsTr("Room %1").arg(key));
    }
    function clean() {
        const keys = page.selected.slice();
        daemon.send("POST", "/api/rooms/clean", { rooms: keys }, (ok, d) => {
            if (ok) { window.toast(qsTr("Cleaning %1").arg(keys.map(page.nameOf).join(" → ")), false); page.selected = []; canvas.requestPaint(); }
            else window.toast(qsTr("Couldn't start: %1").arg(d.error), true);
        });
    }
    function missionLabel(m) {
        const where = m.rooms && m.rooms.length ? m.rooms.map((r) => r.name).join(", ") : qsTr("Whole house");
        const v = m.verdict === "poor" ? qsTr(" · poor") : "";
        return qsTr("%1 · %2%3").arg(Fmt.dateTime(m.start)).arg(where).arg(v);
    }

    onVisibleChanged: if (visible) load()
    Component.onCompleted: load()
    Connections {
        target: daemon
        function onLogAdded(entry) { if (entry.kind === "rooms" && page.visible) page.load(); }
    }
    Shortcut { sequence: "C"; enabled: page.visible && page.selected.length > 0 && page.canClean; onActivated: page.clean() }
    Shortcut { sequence: "Esc"; enabled: page.visible && page.selected.length > 0; onActivated: { page.selected = []; canvas.requestPaint(); } }

    // ---------- geometry ----------
    // Map metres -> view space (rotation in 90° steps, optional mirror), y up.
    function viewPoint(x, y) {
        let a = page.view.mirror ? -x : x, b = y;
        for (let i = 0; i < (page.view.rotate || 0); i++) { const t = a; a = -b; b = t; }
        return [a, b];
    }
    function viewBounds() {
        const bb = page.map && page.map.bounds;
        if (!bb) return null;
        const c = [viewPoint(bb.x0, bb.y0), viewPoint(bb.x1, bb.y0), viewPoint(bb.x0, bb.y1), viewPoint(bb.x1, bb.y1)];
        return { x0: Math.min(...c.map((p) => p[0])), x1: Math.max(...c.map((p) => p[0])), y0: Math.min(...c.map((p) => p[1])), y1: Math.max(...c.map((p) => p[1])) };
    }
    // Pixels per metre and offsets so the map fits, then pan/zoom.
    function mapTransform() {
        const vb = viewBounds();
        if (!vb) return null;
        const pad = 30;
        const s = Math.min((canvas.width - pad * 2) / Math.max(0.5, vb.x1 - vb.x0), (canvas.height - pad * 2) / Math.max(0.5, vb.y1 - vb.y0)) * page.zoom;
        const cx = (vb.x0 + vb.x1) / 2, cy = (vb.y0 + vb.y1) / 2;
        return { s, cx, cy, ox: canvas.width / 2 + page.panX, oy: canvas.height / 2 + page.panY };
    }
    function toScreen(t, x, y) {
        const p = viewPoint(x, y);
        return [t.ox + (p[0] - t.cx) * t.s, t.oy - (p[1] - t.cy) * t.s];
    }
    function toMap(t, sx, sy) {
        let a = (sx - t.ox) / t.s + t.cx, b = -(sy - t.oy) / t.s + t.cy;
        for (let i = 0; i < (page.view.rotate || 0); i++) { const u = a; a = b; b = -u; }   // undo rotation
        return [page.view.mirror ? -a : a, b];
    }
    function inside(poly, x, y) {
        let hit = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const [xi, yi] = poly[i], [xj, yj] = poly[j];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
        }
        return hit;
    }
    function keyAt(sx, sy) {
        const t = mapTransform();
        if (!t || !page.map) return "";
        const [x, y] = toMap(t, sx, sy);
        for (const z of page.map.zones) if (inside(z.polygon, x, y)) return z.key;   // zones sit on top of rooms
        for (const r of page.map.rooms) if (inside(r.polygon, x, y)) return r.key;
        return "";
    }
    function centroid(poly) {
        let x = 0, y = 0;
        for (const p of poly) { x += p[0]; y += p[1]; }
        return [x / poly.length, y / poly.length];
    }

    readonly property var roomColors: ["#5b8def", "#4fb39a", "#c98b4f", "#a77bd6", "#d26b8f", "#6fa8c9", "#b3a64a", "#7a8f5a"]

    ColumnLayout {
        anchors.fill: parent
        anchors.bottomMargin: 12
        spacing: 10

        // Not set up / errors
        Rectangle {
            visible: !!page.info && !page.info.cloud.configured || page.error !== ""
            Layout.fillWidth: true
            implicitHeight: setupLabel.implicitHeight + 24
            radius: Math.min(6, theme.radius)
            color: Ui.panel
            border.color: Ui.border
            Label {
                id: setupLabel
                anchors.fill: parent
                anchors.margins: 12
                wrapMode: Text.Wrap
                color: Ui.muted
                textFormat: Text.PlainText
                text: page.error !== "" ? qsTr("Couldn't load the map: %1").arg(page.error)
                    : qsTr("The map comes from iRobot's cloud (read-only). Connect your iRobot account once by running:\n%1/bin/sweep-cloud-login\nthen restart sweepd.").arg("~/Projects/Roomba_Vacuum")
            }
        }

        // Toolbar
        RowLayout {
            Layout.fillWidth: true
            spacing: 8
            visible: !!page.map
            Label { text: page.map ? page.map.name : ""; color: Ui.text; font.pixelSize: 16; font.weight: Font.DemiBold; elide: Text.ElideRight; Layout.maximumWidth: 180 }
            Label {
                text: page.map ? qsTr("%1 m² · updated %2").arg(Number(page.map.area || 0).toLocaleString(Qt.locale(), 'f', 0)).arg(Fmt.ago(page.map.fetchedAt)) : ""
                color: Ui.muted
                font.pixelSize: 12
            }
            Item { Layout.fillWidth: true; Layout.minimumWidth: 0 }
            Label { text: qsTr("Coverage"); color: Ui.muted }
            ComboBox {
                id: missionBox
                Layout.preferredWidth: 230
                Layout.minimumWidth: 140
                Layout.fillWidth: true
                Layout.maximumWidth: 320
                Material.roundedScale: theme.radius
                model: [qsTr("None")].concat(((page.info && page.info.missions) || []).map(page.missionLabel))
                currentIndex: {
                    const ms = (page.info && page.info.missions) || [];
                    const i = ms.findIndex((m) => m.id === page.coverageId);
                    return i + 1;
                }
                onActivated: (i) => page.showCoverage(i === 0 ? "" : page.info.missions[i - 1].id)
            }
            ActionButton { text: qsTr("Rotate"); flat: true; ToolTip.visible: hovered; ToolTip.text: qsTr("Turn the map a quarter turn"); onClicked: page.setView({ rotate: ((page.view.rotate || 0) + 1) % 4 }) }
            ActionButton { text: qsTr("Mirror"); flat: true; ToolTip.visible: hovered; ToolTip.text: qsTr("Flip the map left to right"); onClicked: page.setView({ mirror: !page.view.mirror }) }
            ActionButton { text: qsTr("Fit"); flat: true; onClicked: page.resetZoom() }
            ActionButton { text: qsTr("Update"); flat: true; ToolTip.visible: hovered; ToolTip.text: qsTr("Fetch the latest map from iRobot"); enabled: !page.loading && !!page.info && page.info.cloud.configured; onClicked: page.refreshFromCloud() }
        }

        // Map
        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            color: Ui.panel
            border.color: Ui.border
            radius: theme.radius
            clip: true

            Canvas {
                id: canvas
                anchors.fill: parent
                anchors.margins: 1
                renderStrategy: Canvas.Cooperative
                onWidthChanged: requestPaint()
                onHeightChanged: requestPaint()
                Connections { target: theme; function onChanged() { canvas.requestPaint() } }

                onPaint: {
                    const ctx = getContext("2d");
                    ctx.reset();
                    const map = page.map;
                    const t = page.mapTransform();
                    if (!map || !t) {
                        ctx.fillStyle = Ui.faint; ctx.font = "13px sans-serif"; ctx.textAlign = "center";
                        ctx.fillText(page.info ? qsTr("No map yet") : qsTr("Loading map…"), width / 2, height / 2);
                        return;
                    }
                    const path = (poly) => {
                        ctx.beginPath();
                        poly.forEach((p, i) => { const s = page.toScreen(t, p[0], p[1]); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
                        ctx.closePath();
                    };

                    // Floor outline (free space) first.
                    for (const b of map.borders) {
                        if (!b.polygon.length) continue;
                        path(b.polygon);
                        ctx.fillStyle = b.type === "not_free" ? Qt.rgba(0, 0, 0, 0.35) : Qt.rgba(1, 1, 1, 0.03);
                        ctx.fill();
                    }

                    // Rooms
                    map.rooms.forEach((r, i) => {
                        if (!r.polygon.length) return;
                        const sel = page.selected.indexOf(r.key) >= 0;
                        const hover = page.hoverKey === r.key;
                        path(r.polygon);
                        ctx.globalAlpha = sel ? 0.55 : hover ? 0.38 : page.coverage ? 0.14 : 0.24;
                        ctx.fillStyle = sel ? theme.accent : page.roomColors[i % page.roomColors.length];
                        ctx.fill();
                        ctx.globalAlpha = 1;
                        ctx.lineWidth = sel || hover ? 2 : 1;
                        ctx.strokeStyle = sel ? theme.accent : Qt.rgba(1, 1, 1, 0.35);
                        ctx.stroke();
                    });

                    // Coverage: the cells the robot cleaned in the chosen mission.
                    if (page.coverage) {
                        const cw = page.coverage.cell[0] * t.s, ch = page.coverage.cell[1] * t.s;
                        ctx.fillStyle = theme.accent;
                        ctx.globalAlpha = 0.55;
                        for (const c of page.coverage.cells) {
                            const s = page.toScreen(t, c[0], c[1]);
                            ctx.fillRect(s[0] - cw / 2, s[1] - ch / 2, Math.max(1, cw), Math.max(1, ch));
                        }
                        ctx.globalAlpha = 1;
                        ctx.fillStyle = Ui.bad;
                        for (const e of page.coverage.escapes) {
                            const s = page.toScreen(t, e[0], e[1]);
                            ctx.beginPath(); ctx.arc(s[0], s[1], 4, 0, Math.PI * 2); ctx.fill();
                        }
                    }

                    // Objects the robot recognised (faint when iRobot hides them).
                    for (const o of map.objects) {
                        if (!o.polygon.length) continue;
                        path(o.polygon);
                        ctx.fillStyle = Qt.rgba(0.85, 0.85, 0.9, o.shown ? 0.30 : 0.15);
                        ctx.fill();
                    }

                    // Keep-out zones
                    for (const k of map.keepouts) {
                        if (!k.polygon.length) continue;
                        path(k.polygon);
                        ctx.fillStyle = Qt.rgba(1, 0.42, 0.42, 0.25); ctx.fill();
                        ctx.strokeStyle = Ui.bad; ctx.lineWidth = 2; ctx.stroke();
                    }

                    // Clean zones
                    for (const z of map.zones) {
                        if (!z.polygon.length) continue;
                        const sel = page.selected.indexOf(z.key) >= 0;
                        path(z.polygon);
                        ctx.fillStyle = sel ? theme.accent : Qt.rgba(1, 1, 1, page.hoverKey === z.key ? 0.25 : 0.10);
                        ctx.globalAlpha = sel ? 0.6 : 1;
                        ctx.fill();
                        ctx.globalAlpha = 1;
                        ctx.setLineDash([5, 4]);
                        ctx.strokeStyle = sel ? theme.accent : Ui.warn; ctx.lineWidth = 2; ctx.stroke();
                        ctx.setLineDash([]);
                    }

                    // Doors: short gaps drawn in the panel colour.
                    ctx.strokeStyle = Ui.panelRaised; ctx.lineWidth = 3;
                    for (const d of map.doors) {
                        const a = page.toScreen(t, d[0][0], d[0][1]), b = page.toScreen(t, d[1][0], d[1][1]);
                        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
                    }

                    // Dock
                    const dk = page.toScreen(t, map.dock.x, map.dock.y);
                    ctx.fillStyle = Ui.good;
                    ctx.fillRect(dk[0] - 6, dk[1] - 6, 12, 12);
                    ctx.fillStyle = Ui.muted; ctx.font = "11px sans-serif"; ctx.textAlign = "center";
                    ctx.fillText(qsTr("Dock"), dk[0], dk[1] + 18);

                    // Labels (with cleaning order for selected rooms)
                    const label = (area) => {
                        if (!area.polygon.length) return;
                        const c = page.centroid(area.polygon);
                        const s = page.toScreen(t, c[0], c[1]);
                        const order = page.selected.indexOf(area.key);
                        ctx.textAlign = "center"; ctx.textBaseline = "middle";
                        ctx.font = "600 13px sans-serif";
                        ctx.fillStyle = Ui.text;
                        ctx.fillText(page.nameOf(area.key), s[0], s[1]);
                        if (order >= 0) {
                            ctx.beginPath(); ctx.fillStyle = theme.accent; ctx.arc(s[0], s[1] - 20, 10, 0, Math.PI * 2); ctx.fill();
                            ctx.fillStyle = theme.accentForeground; ctx.font = "600 11px sans-serif";
                            ctx.fillText(String(order + 1), s[0], s[1] - 20);
                        }
                    };
                    map.rooms.forEach(label);
                    map.zones.forEach(label);
                }

                MouseArea {
                    anchors.fill: parent
                    hoverEnabled: true
                    acceptedButtons: Qt.LeftButton
                    preventStealing: true
                    property real pressX: 0
                    property real pressY: 0
                    property real startPanX: 0
                    property real startPanY: 0
                    property bool dragged: false
                    cursorShape: page.hoverKey !== "" ? Qt.PointingHandCursor : Qt.ArrowCursor
                    onPressed: (e) => { pressX = e.x; pressY = e.y; startPanX = page.panX; startPanY = page.panY; dragged = false; }
                    onPositionChanged: (e) => {
                        if (pressed) {
                            if (Math.abs(e.x - pressX) + Math.abs(e.y - pressY) > 4) dragged = true;
                            if (dragged) { page.panX = startPanX + e.x - pressX; page.panY = startPanY + e.y - pressY; canvas.requestPaint(); }
                            return;
                        }
                        const k = page.keyAt(e.x, e.y);
                        if (k !== page.hoverKey) { page.hoverKey = k; canvas.requestPaint(); }
                    }
                    onExited: { page.hoverKey = ""; canvas.requestPaint(); }
                    onClicked: (e) => { if (!dragged) { const k = page.keyAt(e.x, e.y); if (k) page.toggle(k); } }
                    onWheel: (w) => {
                        // Zoom around the cursor.
                        const f = w.angleDelta.y > 0 ? 1.15 : 1 / 1.15;
                        const nz = Math.max(0.5, Math.min(8, page.zoom * f));
                        const k = nz / page.zoom;
                        const cx = canvas.width / 2 + page.panX, cy = canvas.height / 2 + page.panY;
                        page.panX = w.x - (w.x - cx) * k - canvas.width / 2;
                        page.panY = w.y - (w.y - cy) * k - canvas.height / 2;
                        page.zoom = nz;
                        canvas.requestPaint();
                    }
                }
            }

            // Hover card
            Rectangle {
                visible: page.hoverKey !== ""
                anchors.left: parent.left
                anchors.top: parent.top
                anchors.margins: 12
                width: hoverCol.implicitWidth + 20
                height: hoverCol.implicitHeight + 14
                radius: Math.min(6, theme.radius)
                color: Ui.panelRaised
                border.color: Ui.border
                ColumnLayout {
                    id: hoverCol
                    anchors.centerIn: parent
                    spacing: 0
                    Label { text: page.hoverKey ? page.nameOf(page.hoverKey) : ""; color: Ui.text; font.weight: Font.DemiBold }
                    Label {
                        readonly property var r: page.roomInfo[page.hoverKey]
                        readonly property var passText: ({ auto: qsTr("automatic passes"), one: qsTr("1 pass"), two: qsTr("2 passes") })
                        text: (page.hoverKey[0] === "z" ? qsTr("Clean zone") : qsTr("Room")) + (r && r.passes ? " · " + passText[r.passes] : "")
                        color: Ui.muted
                        font.pixelSize: 12
                    }
                }
            }

            // Coverage legend
            Rectangle {
                visible: !!page.coverage
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                anchors.margins: 12
                width: legend.implicitWidth + 20
                height: legend.implicitHeight + 14
                radius: Math.min(6, theme.radius)
                color: Ui.panelRaised
                border.color: Ui.border
                RowLayout {
                    id: legend
                    anchors.centerIn: parent
                    spacing: 8
                    Rectangle { width: 12; height: 12; color: theme.accent; opacity: 0.7 }
                    Label { text: page.coverage ? qsTr("Cleaned %1 m²").arg(Number(page.coverage.areaM2).toLocaleString(Qt.locale(), 'f', 1)) : ""; color: Ui.text; font.pixelSize: 12 }
                    Rectangle { width: 10; height: 10; radius: 5; color: Ui.bad; visible: page.coverage && page.coverage.escapes.length > 0 }
                    Label { visible: page.coverage && page.coverage.escapes.length > 0; text: qsTr("escapes"); color: Ui.muted; font.pixelSize: 12 }
                }
            }
        }

        // Selection bar
        RowLayout {
            Layout.fillWidth: true
            visible: !!page.map
            spacing: 10
            Label {
                Layout.fillWidth: true
                elide: Text.ElideRight
                color: page.selected.length ? Ui.text : Ui.muted
                text: page.selected.length ? qsTr("Clean in this order: %1").arg(page.selected.map(page.nameOf).join(" → "))
                    : daemon.status.active ? qsTr("The robot is cleaning now. Pick rooms for the next clean once it's docked.")
                    : qsTr("Click rooms or zones to choose what to clean. Drag to move, scroll to zoom.")
            }
            ActionButton { text: qsTr("Clear  (Esc)"); flat: true; visible: page.selected.length > 0; onClicked: { page.selected = []; canvas.requestPaint(); } }
            ActionButton {
                text: qsTr("Clean  (C)")
                highlighted: true
                enabled: page.selected.length > 0 && page.canClean
                onClicked: page.clean()
            }
        }
    }
}
