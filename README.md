# Sweep

Local control for an iRobot Roomba (built for a j8+, "Vanilla Thunder"), with
far more than the phone app: every mission recorded with its own stats,
automations that know whether anyone's home, every setting the robot exposes,
a health view of the battery, sensors and firmware, and a map of your floor
with click-to-clean and per-mission coverage. Schedules can be stored on the
robot itself, so they run even when the laptop is off. Control is entirely local; only
the map is read (never written) from iRobot's cloud.

```
sweepd (daemon/)     background service; owns the robot's single local connection,
                     records history in SQLite, runs automations, sends desktop alerts,
                     serves an API on 127.0.0.1:8099
Sweep  (app/)        Qt Quick desktop app for Omarchy, talks to sweepd
roomba.js            command-line client for sweepd
mcp/sweep-mcp.js     MCP server so AI assistants (Claude etc.) can use Sweep
tools/sniff.js       raw MQTT sniffer for research (stop sweepd first)
```

## Setup

1. Robot credentials go in `~/.config/sweep/config.json` (mode 600):
   `{"ip": "10.0.0.9", "blid": "...", "password": "..."}`. Get them with
   dorita980's `get-roomba-password-cloud` (j-series firmware won't hand the
   password out locally).
2. `npm install`, then `bin/install-daemon` installs and starts `sweepd` as a
   systemd user service.
3. `app/bin/install` builds the app and installs it as an Arch package (asks
   for your sudo password), so it shows up in the launcher (Super + Space).
4. Optional, for the map: `bin/sweep-cloud-login` stores your iRobot account
   password in GNOME Keyring (never in a file), then
   `systemctl --user restart sweepd`. Sweep then loads the saved map, names
   every room as in the iRobot app, and attaches each mission's coverage.

## The app

| Key | Action |
| --- | --- |
| Space | Start cleaning / pause |
| R | Resume |
| D | Send to dock (pauses first if cleaning) |
| F | Find robot (plays a sound) |
| E | Empty bin into the base |
| 1 – 7 | Home, Map, Rooms, History, Automations, Settings, Health |
| C | Clean the rooms picked on the Map or Rooms page, in order |
| N | New automation (Automations page) |
| ? | Show shortcuts |
| Q | Quit |

## What the robot does and doesn't tell us locally

- It allows **one** local MQTT connection at a time; sweepd holds it, so
  everything else goes through sweepd's API.
- During a clean it streams only state changes and Wi-Fi signal. There is
  **no position data** on this firmware, so no live map.
- Lifetime counters (bumps, cliffs, stuck, charge cycles, …) only arrive when
  a connection opens. sweepd reconnects after each mission and diffs them to
  get per-mission stats.
- `dock` mid-clean only pauses; sweepd pauses, waits, then docks.
- Settings changes take about 5 s to be confirmed by the robot.

Detailed findings, experiment results and next steps: [docs/ROOMBA_RESEARCH.md](docs/ROOMBA_RESEARCH.md).

## AI assistants (MCP)

`mcp/sweep-mcp.js` is an MCP server (no dependencies) that gives Claude Code,
Claude Desktop or any MCP client a safe set of tools for Sweep: status, rooms
and routines, recent cleans, stats, health, care items, automations, the
activity log, and actions (clean rooms by name, run a routine, clean
everywhere, pause, resume, go home, stop, find the robot, empty the bin, mark
care done). Tools that send the robot out take `preview: true` to describe the
plan without moving it. Raw robot settings are deliberately not exposed.

- In this repo, Claude Code picks it up from `.mcp.json` (approve it once).
- Everywhere else:
  `claude mcp add --scope user sweep -- node /path/to/Roomba_Vacuum/mcp/sweep-mcp.js`
- Other clients: run `node mcp/sweep-mcp.js` over stdio. `SWEEP_URL`
  overrides the API address (default `http://127.0.0.1:8099`).

Then ask things like "clean the kitchen and the litter box", "how did the
last clean go?" or "is anything due for maintenance?".

## CLI

```
node roomba.js status | start | pause | resume | stop | dock | find | evac
node roomba.js settings [passes=two volume=60 ...]
node roomba.js missions [n] | log [n] | health
```

## Development

```
npm test              # daemon unit tests
app/bin/test          # Qt tests (SSE parser, theme, translator)
app/bin/build         # build app/build/sweep
journalctl --user -u sweepd -f
```
