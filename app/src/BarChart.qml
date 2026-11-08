import QtQuick

// Simple bar chart on a Canvas. bars: [{label: "..", value: n}]
Canvas {
    id: chart
    property var bars: []
    property string valueSuffix: ""
    property string emptyText: qsTr("No data yet")
    property color barColor: theme.accent

    implicitHeight: 160
    renderStrategy: Canvas.Cooperative
    onBarsChanged: requestPaint()
    onWidthChanged: requestPaint()
    onHeightChanged: requestPaint()
    onBarColorChanged: requestPaint()

    onPaint: {
        const ctx = getContext("2d");
        ctx.reset();
        ctx.font = "11px sans-serif";
        const top = 18, bottom = 22, side = 4;
        const h = height - top - bottom, w = width - side * 2;
        const max = Math.max(1, ...bars.map((b) => b.value || 0));
        if (!bars.length || bars.every((b) => !b.value)) {
            ctx.fillStyle = Ui.faint;
            ctx.textAlign = "center";
            ctx.fillText(emptyText, width / 2, height / 2);
            return;
        }
        const slot = w / bars.length, bw = Math.max(2, Math.min(36, slot * 0.6));
        // Label every bar when they fit, otherwise every few.
        const every = Math.ceil(bars.length / Math.max(1, Math.floor(w / 46)));
        bars.forEach((b, i) => {
            const x = side + slot * i + (slot - bw) / 2;
            const bh = (b.value || 0) / max * h;
            ctx.fillStyle = barColor;
            ctx.fillRect(x, top + h - bh, bw, bh);
            ctx.textAlign = "center";
            if (b.value && bw >= 18) {
                ctx.fillStyle = Ui.muted;
                ctx.textBaseline = "bottom";
                ctx.fillText(Math.round(b.value) + valueSuffix, x + bw / 2, top + h - bh - 3);
            }
            if (i % every === 0) {
                ctx.fillStyle = Ui.faint;
                ctx.textBaseline = "top";
                ctx.fillText(b.label, x + bw / 2, top + h + 6);
            }
        });
    }
}
