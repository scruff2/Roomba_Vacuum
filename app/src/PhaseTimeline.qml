import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import "Format.js" as Fmt

// A mission's phases as coloured segments along its duration.
ColumnLayout {
    id: root
    property var phases: []   // [[t, phase], ...]
    property real start: 0
    property real end: 0
    spacing: 6

    function colorFor(p) {
        if (p === "run") return theme.accent;
        if (p === "stuck" || p === "chargingerror") return Ui.bad;
        if (p === "pause" || p === "stop") return Ui.warn;
        if (p && p.startsWith("hm")) return "#7e8cff";
        if (p === "charge" || p === "evac") return Ui.good;
        return Ui.faint;
    }

    readonly property var segments: {
        const out = [];
        const total = Math.max(1, end - start);
        for (let i = 0; i < phases.length; i++) {
            const a = Math.max(start, phases[i][0]);
            const b = i + 1 < phases.length ? phases[i + 1][0] : end;
            out.push({ phase: phases[i][1], from: a, frac: Math.max(0, (b - a) / total) });
        }
        return out;
    }

    Rectangle {
        Layout.fillWidth: true
        height: 14
        radius: Math.min(4, theme.radius)
        color: Ui.panelRaised
        clip: true
        Row {
            anchors.fill: parent
            Repeater {
                model: root.segments
                Rectangle {
                    required property var modelData
                    width: parent.width * modelData.frac
                    height: parent.height
                    color: root.colorFor(modelData.phase)
                    ToolTip.visible: segHover.hovered
                    ToolTip.text: Fmt.phase(modelData.phase) + " · " + Fmt.time(modelData.from)
                    HoverHandler { id: segHover }
                }
            }
        }
    }
    Flow {
        Layout.fillWidth: true
        spacing: 12
        Repeater {
            model: [...new Set(root.phases.map((p) => p[1]))]
            Row {
                required property var modelData
                spacing: 5
                Rectangle { width: 8; height: 8; radius: 4; color: root.colorFor(modelData); anchors.verticalCenter: parent.verticalCenter }
                Label { text: Fmt.phase(modelData); color: Ui.muted; font.pixelSize: 12 }
            }
        }
    }
}
