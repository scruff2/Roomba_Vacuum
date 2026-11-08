# Sweep

Local control for an iRobot Roomba (built for a j8+, "Vanilla Thunder"), with
far more than the phone app: every mission recorded with its own stats,
automations that know whether anyone's home, every setting the robot exposes,
and a health view of the battery, sensors and firmware. Nothing goes through
iRobot's cloud.

```
sweepd (daemon/)     background service; owns the robot's single local connection,
                     records history in SQLite, runs automations, sends desktop alerts,
                     serves an API on 127.0.0.1:8099
Sweep  (app/)        Qt Quick desktop app for Omarchy, talks to sweepd
roomba.js            command-line client for sweepd
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

## The app

| Key | Action |
| --- | --- |
| Space | Start cleaning / pause |
| R | Resume |
| D | Send to dock (pauses first if cleaning) |
| F | Find robot (plays a sound) |
| E | Empty bin into the base |
| 1 – 5 | Home, History, Automations, Settings, Health |
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
