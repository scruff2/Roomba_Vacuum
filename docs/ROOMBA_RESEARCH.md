# Roomba j8+ local control: research notes

What we've learned about controlling an iRobot Roomba j8+ over its local
connection, from building Sweep and from deliberate experiments. Use it as
the starting point for future features: what is confirmed, what failed,
what is untested, and what must never be sent.

Last updated: 2026-11-08.

## The robot

| | |
| --- | --- |
| Model | Roomba j8+ (SKU `j855020`), Clean Base dock with auto-empty |
| Firmware | `sapphire+24.29.3+2024-10-12` (nav `24.29.3`, Linux `sextant-7.37.0`) |
| Local API | MQTT over TLS on port 8883; username = BLID, password from iRobot's cloud |
| Discovery | UDP 5678, send `irobotmcs`, JSON reply (name, sku, firmware, `cap`, `nc`) |
| Capabilities (`cap`) | `pose:2 maps:3 pmaps:10 mc:2 sched:2 odoa:7 floorTypeDetect:2 binFullDetect:2 multiPass:2 eco:1 area:1 oMode:10 team:1 log:2 ota:2` |

## How the connection works

- **One client at a time.** The robot accepts a single local MQTT
  connection. sweepd holds it, so everything else (app, CLI, research tools)
  goes through sweepd's API. Stop sweepd (`systemctl --user stop sweepd`)
  before using `tools/sniff.js`. The discovery reply's `nc` field is 1 while a
  client is connected, which lets you check without connecting.
- **TLS.** The firmware rejects dorita980's default TLS 1.2 cipher, so TLS 1.3
  suites must be offered first (`TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256:AES128-SHA256`).
- **Password.** The local "hold Home" method does not work on this firmware.
  The cloud method (dorita980 `get-roomba-password-cloud`, iRobot account
  login) does.
- **Writes.** Commands go to topic `cmd` as `{command, time, initiator, ...}`;
  settings go to topic `delta` as `{"state": {...}}` (dorita980
  `setPreferences`). State arrives as `$aws/things/<blid>/shadow/update`,
  `state.reported`.
- **Silent refusals.** Most refused writes produce no error. Always confirm a
  write by waiting for the new value to come back in `state.reported`
  (`tools/try-setting.js` does this).

## What the robot reports, and when

- **On connect:** the full state (~70 keys), including all lifetime counters
  (`bbrun`, `bbswitch`, `bbchg`, `bbmssn`, `bbrstinfo`, `bbsys`,
  `runtimeStats`, `batInfo`). These counters **only** arrive on connect, so
  sweepd reconnects after each mission to diff them into per-mission stats.
- **During a mission:** only `cleanMissionStatus` changes and `signal`
  (Wi-Fi RSSI, about every 1.4 s). Nothing else streams.
- **Never locally:** `pose` (robot position) is always null even though
  `cap.pose` is 2, so a live map is impossible locally. `mssnM` (mission
  minutes) stays 0; use the `runtimeStats` diff instead. `sqft` is never sent.
- **Room names:** not available; they live only in iRobot's cloud.

## Commands (`cmd` topic)

| Command | Status | Notes |
| --- | --- | --- |
| `start` | ✅ confirmed | Whole-house clean |
| `start` + rooms/zones | ✅ confirmed | See "Room and zone cleaning" below |
| `pause`, `resume`, `stop` | ✅ confirmed | |
| `dock` | ✅ confirmed, with a quirk | Mid-clean it only pauses. Send `pause`, wait ~2.5 s, then `dock` |
| `find` | ✅ confirmed | Plays a sound |
| `evac` | ✅ confirmed | Empty the bin into the dock (while docked) |
| `train` | ✅ seen | Mapping run; the iRobot app sent it for the first map |
| `spot`, `quick`, `skip` | ❓ untested | Mentioned for older models; `cap.mc` hints `skip` may exist |
| `reset`, `wlapon`, `wlapoff`, `wlston`, `wlstoff`, `wifiscan`, `off`, `sleep` | ⛔ never send | May factory-reset (deleting maps) or drop the robot off Wi-Fi |

## Room and zone cleaning

Confirmed on this robot. The robot never lists its rooms locally; it reports
the iRobot app's last command as `lastCommand`, and Sweep learns rooms from
that.

```json
{"command": "start", "initiator": "localApp", "ordered": 1, "params": null,
 "pmap_id": "FlMVrzHlRMKFOd8oMfA15Q", "user_pmapv_id": "261108T200212",
 "regions": [
   {"region_id": "1", "type": "rid", "params": {"noAutoPasses": true, "twoPass": true}},
   {"region_id": "0", "type": "zid", "params": {"noAutoPasses": true, "twoPass": false}}
 ]}
```

- `type` is `rid` for a room and `zid` for a clean zone. **Rooms and zones are
  numbered separately**: room 0 and zone 0 can both exist (Sweep keys them as
  `0` and `z0`).
- Per-region `params` carry passes: auto `{false,false}`, one `{true,false}`,
  two `{true,true}` for `{noAutoPasses, twoPass}`. Two passes per room is
  confirmed working.
- **Map version (`user_pmapv_id`):** the robot rejects a stale or not-yet-synced
  version with **error 224** ("See app for help", red light, nothing in the
  app). The robot saves a new local version after many cleans and after map
  edits. Sweep tries the version the iRobot app last used, then the robot's
  latest from `pmaps`, and remembers whichever is accepted.
- **Stuck map state:** after editing a clean zone, the robot once refused all
  room/zone cleans from both apps (error 224) and its `pmaps` list briefly went
  empty. **Restarting the robot fixed it.**
- When a clean is requested, the robot briefly reports `cycle: "clean"` while
  still in `phase: "charge"`, even if it then refuses. A clean has only
  started once `phase` is `run` (or `hm*`). The same transient report carries
  the *previous* mission's `missionId`.

## Settings (`delta` topic)

Tested by writing, waiting for the echo, and restoring the original value
(`tools/try-setting.js`).

| Setting | Result | Meaning / notes |
| --- | --- | --- |
| `noAutoPasses` + `twoPass` | ✅ echoed | Global passes. Send both keys together; singly they may be dropped |
| `binPause` | ✅ echoed | `false` = keep cleaning when the bin is full |
| `childLock` | ✅ echoed | Disables the button |
| `ecoCharge` | ✅ echoed | Slower charging |
| `audio.volume` | ✅ echoed (~5 s) | 0–100 |
| `schedHold` | ✅ echoed (1 s) | Pauses robot-side schedules without deleting them |
| `rankOverlap` | ✅ echoed (15 → 25 → 15) | Probably overlap between cleaning rows; effect on the j8+ **untested** (inert on an i3 per others) |
| `chrgLrPtrn` | ✅ echoed (0 → 1 → 0) | Probably the light-ring pattern while charging; not visually checked |
| `cleanSchedule2` | ✅ echoed, whole-house **and per-room** | Robot-side schedules; see below. **Firing not yet tested** |
| `carpetBoost` + `vacHigh` | ❌ silently ignored | **Suction cannot be changed locally** on the j8+ |
| `openOnly` | n/a | Reported as null: edge-clean setting not supported |
| `odoaMode`, `odoaFeats`, `optFeats.odoaLite` | ❓ do not write blind | Camera obstacle avoidance ("On-Device Obstacle Avoidance"); values undocumented |
| `reflexSettings` | ❓ do not write blind | `{rlWheelDrop, rlThresholdTraversal}`, probably wheel-drop and door-sill reflexes |
| `peopleFilter`, `sceneRecog`, `imgUpload`, `mapUploadAllowed`, `pmapLearningAllowed`, `evacAllowed` | ❓ untested | Privacy/cloud switches and camera features; `pmapLearningAllowed:false` may freeze map learning |
| `pmaps`, `pmapShare`, `featureFlags` | ⛔ never write | Map storage and firmware feature flags |

### Robot-side schedules (`cleanSchedule2`)

Accepted by the robot, including room lists (not documented by any other
project). Each write **replaces the whole list**; `[]` clears it. Days run
0 = Sunday to 6 = Saturday. Entries without `type` or `cmd` are dropped.

```json
{"cleanSchedule2": [
  {"enabled": true, "type": 0, "start": {"day": [1, 3, 5], "hour": 9, "min": 0},
   "cmd": {"command": "start", "ordered": 1}},
  {"enabled": true, "type": 0, "start": {"day": [2], "hour": 18, "min": 30},
   "cmd": {"command": "start", "ordered": 1, "pmap_id": "FlMVrzHlRMKFOd8oMfA15Q",
           "user_pmapv_id": "261108T200212",
           "regions": [{"region_id": "0", "type": "rid", "params": {"noAutoPasses": true, "twoPass": false}}]}}
]}
```

Open question: a stored room schedule names a map version, which goes stale
(error 224) after the map changes. Schedules would need refreshing whenever
Sweep learns a new accepted version.

## Cleaning-quality findings

- The robot drives to rooms and zones with brushes and vacuum **off**, and
  only switches them on once it starts cleaning.
- A clean zone over a cramped spot (a litter box) produced ~1.5-minute runs
  with 50–60 bumps a minute and no bin emptying: the robot reached it, found
  little it could clean, and called the zone "done". Bigger zones didn't help.
- Signs of a real clean: several minutes of `run`, under ~30 bumps a minute,
  and the dock empties the bin (`evac` phase) afterwards. Sweep's mission
  review (`daemon/insights.js`) uses exactly these signals.
- Lifetime counters at the time of writing: 1,126 main-brush stalls over ~327
  cleaning hours; worth watching after brush maintenance.

## Cloud-only (not reachable locally)

Creating or editing keep-out and clean zones; room names; maps as images and
coverage; mission history with per-room timing; dirt detection; object
photos; maintenance-part resets in the app. A future "cloud phase" would mean
reverse-engineering the iRobot app's private API with the user's account.

## Tools in this repo

| Tool | Use |
| --- | --- |
| `GET /api/raw` (sweepd) | Full raw robot state |
| `POST /api/raw/delta` (sweepd, needs `X-Sweep: 1`) | Raw settings write |
| `tools/try-setting.js '<json>' [--keep]` | Write a setting, confirm the echo, restore the original |
| `tools/sniff.js [secs] [--get] [--clean]` | Log every MQTT packet (stop sweepd first) |

## Next experiments

1. **Robot-side schedule fire test.** Store an enabled Kitchen schedule 2
   minutes ahead; confirm the robot starts by itself and that the mission is
   tagged with the room. If it works, add "Save to robot" for Sweep schedules
   so they run with the laptop off. *Moves the robot.*
2. **Decode app settings.** Watch `/api/raw` while flipping one setting at a
   time in the iRobot app (obstacle avoidance, pet-waste avoidance, edge
   cleaning, carpet behaviour) to learn `odoaMode`, `reflexSettings`,
   `peopleFilter` and friends. *No movement.*
3. **Row overlap in practice.** Kitchen at `rankOverlap` 15 vs 25: compare run
   time, bumps and how clean it looks. *Moves the robot.*
4. **Mission-level `params`.** The app sends a top-level `"params": null` with
   room cleans; test whether non-null params (e.g. passes for a whole-house
   clean) are honoured. *Moves the robot.*
5. **`spot` / `skip`.** Try once each while the robot is in a safe state.
   *Moves the robot.*

## Sources

- [dorita980](https://github.com/koalazak/dorita980) (`lib/v2/local.js`)
- [ha_roomba_plus #140](https://github.com/johnnyh1975/ha_roomba_plus/issues/140) and [features](https://github.com/johnnyh1975/ha_roomba_plus/blob/main/docs/FEATURES.md)
- [roomba-net](https://github.com/imilosk/roomba-net) and its [notes](https://github.com/imilosk/roomba-net/blob/master/docs/ROOMBA_NOTES_AND_ROADMAP.md)
- [roomba-combo10-local](https://github.com/Vitalionn/roomba-combo10-local)
- [Roomba980-Python](https://github.com/NickWaterton/Roomba980-Python)
- [openHAB iRobot binding](https://www.openhab.org/addons/bindings/irobot/)
- [doomba](https://docs.rs/doomba/latest/doomba/api/enum.RoombaMessage.html)
