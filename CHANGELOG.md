# Changelog

## 0.14.1

- Replace signed High/Low offset fields with Same / Warmer / Cooler room-temperature preferences and positive degree amounts.
- Show live High and Low target temperatures against the current house and Low settings, including any target caps.
- Preserve existing room adjustments and control calculations; update related schedule and house-temperature help.


## Unreleased

- Add a Notifications settings tab with saved Home Assistant recipients, device discovery and a test-message action for one selected device.
- Support Companion app notification actions and notify entities, validate destinations, and preserve recipient settings across restarts and encrypted backups.
- Group Connections, Entity library and Backups under Settings; retain existing page bookmarks and update connection links.
- Add entity type/availability filters, multi-word search, sortable columns and pagination with 25/50/100 rows.
- Export password-encrypted configuration backups with saved credentials; preview and atomically import them across instances with independent storage keys.
- Validate backup contents, reject stale previews, retain destination history and reset imported heating to Planning with radiator overrides cleared.

- Use Low temperature instead of setback in heating controls and room cards; replace generic radiator messages with the linked TRV’s reported state.

- Rename the room-heating permission switch to Central Heating Enabled in the controller interface, ESPHome project and LCD. Keep its existing internal ID and telemetry field compatible with installed devices.

## 0.14.0

- Add explicit Smart Thermostat Planning and Active operation; upgrades default to Planning and subsequent selection persists.
- Coordinate ZHA TRVZB Manual/Heat targets and requested openings with signed, bounded OpenTherm boiler leases; keep Adaptive mode off and retain ESP safety authority.
- Verify same-device valve controls, respect limits/rate controls, await HA-reported settings, cancel obsolete writes and expose Active readiness.
- Retain last TRV settings on Planning/Local PID fallback; add no automatic reset watchdog.
- Record planned openings, exclude reported zero-opening radiators from warm-up learning, and add room-demand hysteresis.
- Separate the ESP lifetime exchange-failure counter from recent reported increases, accepted exchanges, gaps and sanitized server rejection diagnostics.
- Keep existing protocol-revision-two firmware compatible; forecast start-time estimates remain advisory.


## 0.13.0

- Fetch hourly and daily forecasts for the selected HA weather entity through its fixed data-retrieval action, with independent caching, retries, unit checks and expiry.
- Add hourly conditional flow guidance, a seven-day low/high outlook and evidence-based preparation estimates for upcoming home/away comfort periods.
- Continuously pair room warm-up with reported outdoor provenance and actual qualified CH flow; include qualified circulation while the flame is off.
- Show active collection, first target reach, weather bands, descriptive correlation, interactive evidence charts and source diagnostics in a large observations/planning dialog.
- Keep forecast values separate from measured history; require comparable completed periods before estimating warm-up and show limitations when evidence or coverage is missing.
- Retain a compact main-page observation summary; add a separate forecast entity and bounded preparation window without firmware changes or heating commands.

## 0.12.1

- Replace individual-day editing with weekday/weekend groups in both occupancy schedules.
- Add Someone home / Everyone away tabs in the schedule dialog, with independently editable periods and room priorities.
- Let configured away High priorities use comfort targets rather than forcing all rooms to setback; retain occupancy delay and conservative unknown tracking.
- Use Monday and Saturday as weekday/weekend templates, archive previous individual days, and normalise subsequent plan saves.
- Keep Smart Thermostat in planning mode with Local PID authority and no radiator commands.

## 0.12.0

- Simplify Heating around a house setpoint and direct scheduled High/Low room priorities; remove the activity selector and manual radiator dropdowns.
- Move schedule, household occupancy and weather settings into dialogs, keeping draggable weekday/weekend periods and individual days.
- Show planned Smart Thermostat demand and flow beside actual Local PID state, using clear mode names while preserving firmware compatibility.
- Add app-side weather-aware initial flow planning with current HA weather/outside sensors, unit/freshness checks, fallback and a curve preview.
- Give High rooms comfort targets and Low rooms setback targets; preserve room frost priority and prevent sunny rooms cancelling cooler demand.
- Archive the previous plan, retain schedule times, convert priorities 3–5 to High / 1–2 to Low, and remove hidden activity offsets from the new model.
- Record planned flow, outside temperature, priority and decision context alongside actual history.
- Pause previous app radiator automation during planning; no boiler or TRV heating commands are sent. Existing ESP safeguards and firmware remain unchanged.

## 0.11.0

- Accept TRV/thermostat measured temperatures alongside room sensors, with explicit selection, unit conversion and freshness checks.
- Show temperature contributors and actual TRV measurement, target and operating state alongside the room plan.
- Add separate opt-in Monitor, Follow plan, Focus and Pause controls for mapped, registry-verified ZHA radiators; all existing mappings remain in Monitor.
- Bound target values and command frequency, suppress acknowledged/repeated writes, and report pending/error state.
- Keep signed boiler replies under local PID authority; no ESPHome upload is needed.
- Exclude paused/off radiators from new warm-up observations.

## 0.10.0

- Replace the Heating schedule editor with configurable activities and weekday/weekend timelines for home and away.
- Add house/setback targets, per-room offsets and activity room priorities; preserve legacy targets and overnight/day-specific plans during migration.
- Map household HA people/trackers with an everyone-away delay, conservative unknown-state handling and manual overrides.
- Record minute room/target/boiler history independently of the browser; provide linked charts with separate temperature/percentage axes, target lines, tooltips, zoom and CSV.
- Track observed room warm-up minutes per °C with fresh-source, heating-state, duration, rise, target and sensor consistency checks.
- Retain heating observations for 90 days and derive rates from the last 30 days; no fabricated backfill or boiler-control changes.
- Rename the event-log navigation item to Activity log.

## 0.9.0

- Seven-day boiler graphs retain all available exchanges, with pixel-scale rendering that preserves extremes and full-resolution tooltips/CSV.
- Shade reported heating, hot water, post-DHW settling and idle phases behind temperature and delta-T charts; leave unknown periods and outages unshaded.
- Add a CH-qualified flow-minus-return chart, live differential and dashed 20°C tuning reference; exclude DHW, settling, stale and missing samples.
- Remove pressure from monitor cards/tooltips and omit pressure polling from the optional ESPHome YAML. Existing firmware remains compatible.
- Use 12-hour am/pm for graphs, logs, activity, energy and schedule display/editing; retain machine-readable stored/exported times.

## 0.8.0

- Home Assistant add-on package with automatic Supervisor connection, ingress, watchdog and cold backups.
- Trigger capture directly over the signed ESP connection; operation IDs prevent retries extending its timer.
- Automatically attach passive OpenTherm callbacks, with an optional discovered Home Assistant diagnostic-switch fallback.
- Explain normal comfort-heating permission and show when it is paused.
- Interactive temperature, energy and power graphs with precise tooltips, keyboard/touch support, drag zoom, series toggles and CSV export.
- Use every device exchange for temperature graphs; optionally inspect individual captured OpenTherm measurements.

## 0.7.0

- Listen-only monitoring, room planning, device logs and bounded OpenTherm message capture.
- Removed app heating commands, demo data and direct Octopus API access.
