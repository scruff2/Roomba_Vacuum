import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material

// Material's Button pins itself to a full pill; follow Hyprland's rounding instead.
Button {
    Material.roundedScale: theme.radius
}
