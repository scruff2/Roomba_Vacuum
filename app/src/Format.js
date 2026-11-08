// Formatting helpers shared by the pages. Not a .pragma library, so qsTr
// and Qt.locale() resolve in the importing file's context.

function minutes(m) {
    if (m === null || m === undefined || isNaN(m))
        return "—";
    m = Math.round(m);
    if (m < 60)
        return qsTr("%1 min").arg(m);
    return qsTr("%1 h %2 min").arg(Math.floor(m / 60)).arg(m % 60);
}

function number(n) {
    if (n === null || n === undefined || isNaN(n))
        return "—";
    return Number(n).toLocaleString(Qt.locale(), 'f', 0);
}

function dateTime(t) {
    if (!t)
        return "—";
    return new Date(t).toLocaleString(Qt.locale(), Locale.ShortFormat);
}

function date(t) {
    if (!t)
        return "—";
    return new Date(t).toLocaleDateString(Qt.locale(), Locale.ShortFormat);
}

function time(t) {
    if (!t)
        return "—";
    return new Date(t).toLocaleTimeString(Qt.locale(), Locale.ShortFormat);
}

function ago(t, now) {
    if (!t)
        return qsTr("never");
    const s = Math.max(0, Math.round(((now || Date.now()) - t) / 1000));
    if (s < 60)
        return qsTr("just now");
    if (s < 3600)
        return qsTr("%1 min ago").arg(Math.floor(s / 60));
    if (s < 86400)
        return qsTr("%1 h ago").arg(Math.floor(s / 3600));
    return qsTr("%1 days ago").arg(Math.floor(s / 86400));
}

function result(r) {
    switch (r) {
    case "completed": return qsTr("Completed");
    case "stopped": return qsTr("Stopped");
    case "error": return qsTr("Error");
    case "superseded": return qsTr("Interrupted");
    default: return qsTr("In progress");
    }
}

function phase(p) {
    switch (p) {
    case "charge": return qsTr("Docked");
    case "run": return qsTr("Cleaning");
    case "stop": return qsTr("Stopped");
    case "pause": return qsTr("Paused");
    case "hmUsrDock": return qsTr("Returning to dock");
    case "hmMidMsn": return qsTr("Docking to recharge");
    case "hmPostMsn": return qsTr("Finished, docking");
    case "stuck": return qsTr("Stuck");
    case "evac": return qsTr("Emptying bin");
    case "chargingerror": return qsTr("Charging error");
    case undefined: case null: return "—";
    default: return p || qsTr("Idle");
    }
}

function signal(rssi) {
    if (rssi === null || rssi === undefined)
        return "—";
    const q = rssi >= -55 ? qsTr("excellent") : rssi >= -67 ? qsTr("good") : rssi >= -75 ? qsTr("fair") : qsTr("weak");
    return qsTr("%1 dBm (%2)").arg(rssi).arg(q);
}

function dayNames() {
    const names = [];
    for (let d = 0; d < 7; d++)
        names.push(Qt.locale().dayName(d, Locale.ShortFormat));
    return names;
}
