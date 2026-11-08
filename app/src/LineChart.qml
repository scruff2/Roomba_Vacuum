import QtQuick
import "Format.js" as Fmt

// Time-series chart drawn on a Canvas (Qt Charts isn't part of Omarchy).
// series: [{points: [[t, v], ...], color: "#..", label: "..."}]
Canvas {
    id: chart
    property var series: []
    property real yMin: NaN
    property real yMax: NaN
    property string ySuffix: ""
    property string emptyText: qsTr("No data yet")
    property bool dateLabels: false

    implicitHeight: 160
    renderStrategy: Canvas.Cooperative
    onSeriesChanged: requestPaint()
    onWidthChanged: requestPaint()
    onHeightChanged: requestPaint()
    Connections { target: theme; function onChanged() { chart.requestPaint() } }

    function bounds() {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, n = 0;
        for (const s of series)
            for (const p of s.points || []) {
                if (p[1] === null || p[1] === undefined) continue;
                x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
                y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); n++;
            }
        if (!isNaN(yMin)) y0 = yMin;
        if (!isNaN(yMax)) y1 = yMax;
        if (y1 - y0 < 1) { y0 -= 1; y1 += 1; }
        return { x0, x1, y0, y1, n };
    }

    onPaint: {
        const ctx = getContext("2d");
        ctx.reset();
        const b = bounds();
        const left = 60, right = 8, top = 8, bottom = 22;
        const w = width - left - right, h = height - top - bottom;
        ctx.font = "11px sans-serif";

        if (b.n < 2 || w <= 0 || h <= 0) {
            ctx.fillStyle = Ui.faint;
            ctx.textAlign = "center";
            ctx.fillText(emptyText, width / 2, height / 2);
            return;
        }
        const X = (t) => left + (b.x1 === b.x0 ? w / 2 : (t - b.x0) / (b.x1 - b.x0) * w);
        const Y = (v) => top + h - (v - b.y0) / (b.y1 - b.y0) * h;

        // Grid and y labels.
        ctx.strokeStyle = Ui.border;
        ctx.lineWidth = 1;
        ctx.fillStyle = Ui.faint;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        for (let i = 0; i <= 4; i++) {
            const v = b.y0 + (b.y1 - b.y0) * i / 4;
            const y = Math.round(Y(v)) + 0.5;
            ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + w, y); ctx.stroke();
            ctx.fillText(Math.round(v) + ySuffix, left - 6, y);
        }
        // Time labels at both ends and the middle.
        ctx.textBaseline = "top";
        const fmt = (t) => dateLabels ? Fmt.date(t) : Fmt.time(t);
        ctx.textAlign = "left"; ctx.fillText(fmt(b.x0), left, top + h + 6);
        ctx.textAlign = "center"; ctx.fillText(fmt((b.x0 + b.x1) / 2), left + w / 2, top + h + 6);
        ctx.textAlign = "right"; ctx.fillText(fmt(b.x1), left + w, top + h + 6);

        for (const s of series) {
            const pts = (s.points || []).filter((p) => p[1] !== null && p[1] !== undefined);
            if (pts.length < 2) continue;
            ctx.strokeStyle = s.color || theme.accent;
            ctx.lineWidth = 1.6;
            ctx.lineJoin = "round";
            ctx.beginPath();
            pts.forEach((p, i) => i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])));
            ctx.stroke();
        }
    }
}
