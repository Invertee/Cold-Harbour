# Install Cold Harbour in Home Assistant

## Local add-on installation

1. Extract the release ZIP. Copy its complete `cold-harbour` folder to the Home Assistant **addons** share. The result must be `/addons/cold-harbour/config.yaml`, with `Dockerfile`, `package.json`, `server/` and `public/` beside it. Use the `addons` share, rather than the ESPHome or Home Assistant `config` folder.
2. In Home Assistant, open **Settings → Apps/Add-ons → Store**. Refresh the store/check for updates from its menu. Cold Harbour appears under **Local apps/add-ons**.
3. Install it. Home Assistant builds the container locally for amd64 or aarch64. Start it, enable Start on boot and the sidebar option if wanted, then select **Open Web UI**.
4. The Home Assistant connection is automatic through the Supervisor. No Home Assistant URL or long-lived token is required. The web UI is accessed through ingress. Port **8102/tcp** is enabled for signed ESP telemetry; adjust its host mapping if the port is already in use.
5. In the app’s Connections page, match the **Controller ID** to `cold_harbour.device_id` in the firmware (normally the `device_name` substitution). Create a pairing key for a fresh installation. Enter it in the ESPHome device’s **Cold Harbour Pairing Key** control, and set **Cold Harbour Server URL** to `http://<Home Assistant host IP>:8102`. Use the mapped host port if changed. Use the host’s LAN address, not the ingress URL or ESP address.
6. Leave **Heating Control Mode: PID**. Readings normally arrive every 30 seconds. Energy entities are discovered from Home Assistant’s BottlecapDave Octopus Energy integration; select a meter if more than one is available.

The manifest is `config.yaml`. `repository.yaml` at the ZIP root also makes the extracted layout ready to place in a Git add-on repository. No hosted repository or public URL has been created by this release. To publish later, put the ZIP contents in a reachable Git repository and add that repository URL through Home Assistant’s store.

## Moving from the desktop app

A fresh add-on has a separate private `/data` volume. To move configuration through the UI, export a password-protected file in **Settings → Backups** on the desktop, then preview and import it on the add-on. It transfers rooms, schedules, mappings and saved credentials. Import selects Planning; review the setup before enabling Active. Stop the old controlling instance and update the ESP’s **Cold Harbour Server URL** to the new host. The add-on uses its own Supervisor connection. See [configuration backup details](README.md#settings-and-configuration-backups).

Configuration exports do not transfer measurement history. To retain the exact configuration/history, keep the complete desktop `data` directory, including `secrets.key`, and migrate its contents to the add-on’s private `/data` while both instances are stopped, using host/container tooling. Copying it into the add-on’s source folder does not migrate it.

Subsequent add-on updates preserve `/data`. The manifest uses cold backups so Home Assistant stops the process while backing up SQLite and its key together. The existing `mods` slug is retained. A watchdog checks `/health`; no host network, privileged mode or Docker API access is requested.

## Start an OpenTherm capture

With firmware component **0.8.0**, open **Boiler monitor → Diagnostics → OpenTherm capture → Start 5-minute capture**. The request travels over the existing authenticated ESP connection; no Home Assistant entity is needed. Wait for the queued request to become confirmed, then open **Diagnostics → OpenTherm capture**. Stop capture early with the neighbouring button, or let its five-minute timer expire. The start request normally reaches the ESP within 30 seconds; messages arrive on later exchanges.

For an existing 0.7.x firmware configuration, replace the complete `components/cold_harbour/` folder with 0.8.0 and compile/upload using your existing YAML and credentials. Callbacks are now attached automatically; missing manual YAML callbacks no longer prevent capture. The Home Assistant switch in `runtime-connection.yaml` remains optional. Details are in [the firmware guide](esphome/README.md).

Older capture-capable firmware can use its Home Assistant **OpenTherm Message Capture** diagnostic switch. The app discovers that specific ESPHome entity through the entity registry and can trigger it when available. With several candidates, choose the boiler’s capture entity in Connections. A missing or disabled switch is explained rather than mapped to a different heating control.

Direct capture commands expire if not delivered within two minutes and are tied to the current ESP boot. In Planning they retain PID authority. With Active and existing firmware, the diagnostic command uses a signed observation reply: it acknowledges readings and retains the existing lease until the following exchange renews it. Repeated undelivered diagnostics can therefore allow a lease to expire. Repeated deliveries use the same operation ID and do not restart the five-minute timer. Pending requests are discarded after app restart, ESP reboot or re-pairing. Active grants bounded 90-second heating/off leases only when its readiness checks pass.

## What Central Heating Enabled means

This permits normal central heating from the local controller. **Off** pauses normal heating demand. **On** allows it, subject to the selected Local PID or Smart Thermostat controller and local checks. It is not a schedule or target temperature. Domestic hot water is controlled separately. Local frost protection still has priority, subject to valid sensors and boiler-fault checks. An enclosure probe cannot establish frost safety throughout the house.

## Use the graphs

- Temperature graphs use each device exchange, normally every **30 seconds**, and retain older one-minute history when present. Choose 15 minutes, 1 hour, 6 hours, 24 hours or **7 days**. The week view includes all available exchanges, with rendering reduced to screen resolution while retaining actual values for tooltips and CSV.
- Select **Captured OpenTherm measurements** for individual register readings collected during capture. Their times are estimated from receipt and device age. This can be finer than 30 seconds but does not create additional boiler polling.
- Hover or tap a reading for its exact timestamp, values and available operating context. Drag horizontally to zoom, use Zoom out/Reset view, toggle individual series and download CSV for the visible range. Keyboard arrows, Home/End and Escape support inspection.
- Energy bars show the actual meter interval, consumption and reported interval cost. Power history has the same value inspection. No finer meter resolution is invented when Home Assistant only supplies half-hour intervals.
- Coloured backgrounds show reported heating, hot water, settling and idle phases. Unknown periods and gaps are unshaded. These are sampled operating states, not an exact burner-runtime measurement.
- **Heating delta-T** charts flow minus return only for fresh CH-qualified samples, excluding hot water and its two-minute settling period. The 20°C dashed line is a reference, not a required target or an efficiency score. Look at return temperature, cycling and room comfort alongside the differential.
- Displayed times use **12-hour am/pm**, including schedule editing. Storage and exported timestamps retain their machine-readable format and timezone meaning.
- Pressure has been removed from the monitoring display. No firmware upload is required; to stop requesting it on an existing device, remove its `ch_pressure:` sensor block from your existing YAML and upload through ESPHome. Keep your node name, credentials, pins and calibration.
- Gaps and missing values remain visible. Primary water/return values can describe DHW operation. Use CH-qualified history rather than those raw values for heating analysis.

## Plan Smart Thermostat heating

The Heating page keeps the house setpoint, room priorities and resulting heating decision together. **Local PID** is the current ESP controller, using the HA average and local Dallas fallback. **Smart Thermostat** is the new app plan. Its intended targets and flow remain separate from actual ESP request and modulation. The Smart Thermostat operating-mode dialog selects Planning or Active. The older firmware option names stay compatible without reflashing.

- Save the **House setpoint** on the main page. High room targets use it plus the room offset.
- Open **Schedule**. Choose **Someone home** or **Everyone away**, then select a weekday/weekend period and choose **High** or **Low** for each room. Add/remove periods, drag start-time dividers or use the am/pm time editor. Save schedule commits all dialog changes; closing discards them. Only weekday/weekend rows are shown. Editing a row applies it to every day in that group. Switching occupancy tabs retains unsaved changes to both plans until Save schedule.
- Set **Period setpoint °C** to give a period its own High temperature (7–28°C), including room warmer/cooler preferences. Leave it blank to follow the house setpoint. Low still uses the household low temperature and room preference, capped at that period’s High target.
- Under **Home Assistant schedule override**, choose the **Gone to bed** binary sensor and the profile to use while it is on, then **Save schedule**. This profile takes priority over both occupancy schedules on every day, including across midnight. When the sensor turns off, is missing, unknown or unavailable, the current normal schedule resumes. Choose **No sensor override** to remove the link. The overview and room reasons identify an active sensor override.
- Open **Occupancy** to select people/trackers, set the departure delay, choose a manual occupancy override and change setback. Anyone home runs the home schedule. Everyone known away selects the Everyone away schedule after the delay. Its High/Low room priorities are configurable independently of Someone home. Unknown tracking keeps the home schedule.
- High means comfort at house setpoint + room offset. Low means setback + setback offset, capped at comfort and with a 7°C floor. High-room requests lead over low-room setbacks. A fresh room below 7°C takes precedence with flow capped at 40°C. A sunny kitchen does not cancel another room’s demand. Presence observations do not override the schedule.
- Open **Weather planning** to optionally select an HA weather entity/outside sensor and tune the initial heating curve. Colder outdoors raises starting flow; room shortfall adds a correction within configured bounds. No room demand means zero planned flow. Missing weather uses minimum flow plus correction. The dialog previews the curve and explains its limits; it is app-side planning, with no boiler OpenTherm compensation flag or learned model.

Existing period times and room offsets survive upgrade. Old priorities 3–5 become High and 1–2 become Low. Manual activity overrides and activity temperature offsets stop applying. The complete old plan is archived as `heatingPlanBeforePriority` in SQLite settings, alongside original rule records. Weekdays now share Monday’s plan and weekends share Saturday’s, separately for home/away. Previous individual days are archived as `heatingPlanBeforeOccupancySchedules`. Preserve the complete stopped-app data directory if rolling back application versions.

Linked history charts show room/target temperatures, planned Smart Thermostat flow, actual Local PID flow and boiler modulation with separate temperature/percentage axes. New observations also retain weather, priority and decision context for analysis. Old history stays intact; missing new fields remain gaps. Warm-up observations remain observational and exclude DHW, settling, stale feedback and changing sources/targets.

## Forecast planning and observations

1. In **Weather planning**, use `weather.forecast` (or your weather entity) as the reported outdoor source and leave Forecast weather entity on “Use the reported source” if the same entity supplies both. Alternatively select your actual outside sensor for learning and a separate weather entity for forecasts.
2. Enable **Use outside weather and forecasts in the plan**, then **Save & view forecast**. Only the selected weather entity is queried through HA’s `weather.get_forecasts` data action; no weather-provider credentials or boiler changes are needed. Allow the background refresh to finish if the initial view says Refreshing.
3. **Plan ahead** provides hourly conditional flow guidance, daily low/high guidance for the next seven available days, and upcoming comfort periods for each occupancy schedule. Choose Someone home or Everyone away. These are alternative scenarios, not predictions that either person will arrive or leave.
4. Open **Heating observations → View observations & planning → Room learning** for per-room evidence. Collection runs every minute while Cold Harbour is running, even with the dialog closed. It shows ongoing heating, source counts, outdoor matches, min/°C by outside-temperature band, actual flow and recent qualifying periods. Use the graph tooltips, zoom and CSV for details.
5. Start-by estimates appear only after three comparable completed heating periods across two days, with matching probes/valve/outdoor source, at least 80% reported outdoor coverage, and similar initial room temperature (±2°C), outside temperature (±3°C) and actual flow (±5°C). No matching evidence stays Learning. Old observations without an identifiable outdoor source are kept for overall warm-up statistics and excluded from weather learning.

Forecasts refresh every 30 minutes, with failed types retried after five minutes. Hourly/daily caches expire after two/twelve hours. Missing forecast types work independently, and daily high/low values are never treated as precise hourly temperatures. A future start estimate uses the room temperature now; cooling and solar gain before the scheduled time are not predicted. The configurable preparation window defaults to 180 minutes. Estimated start times do not command the boiler or valves.

The local ESP protections remain unchanged; selected authority depends on Planning/Active and the ESP mode. No firmware update is needed. Home Assistant weather forecast API documentation is [here](https://www.home-assistant.io/actions/weather.get_forecasts/).

## Planning and Active operation

Open **Heating → Smart Thermostat · Planning**. Choose Planning or Active, then Save operating mode. The dialog explains both modes and shows readiness, actual control entities, requested openings and reported settings. The initial upgrade is Planning. Later selections persist across app restarts.

For Active, also select **Cold Harbour** in the ESP’s Heating Control Mode, turn on **Central Heating Enabled**, and wait for fresh signed telemetry and HA readings. Enable the TRVZB’s **Valve opening degree**, **Valve closing degree** and **Adaptive mode** entities in ZHA. Map its climate entity to the correct room; extra controls are discovered from that same registered device. Unknown/disabled/ambiguous controls keep Active waiting. No new ESP firmware upload is needed if protocol revision 2 and flow limits are already reported.

Active applies radiator settings, waits for HA to report them, then requests bounded boiler flow for the leading room demand. Boiler commands expire after 90 seconds. New shortfalls start heat more than 0.2°C below target; heating remains requested until target. Valve requests use an initial proportional 50% opening per 1°C, rounded to 5% steps with a 10% minimum while requesting heat. Closing degree remains 100%; the finite elevated device target is displayed separately from the real room target. These are requested travel settings, not measured flow or calibrated heat output. External temperature inputs stay unchanged.

Planning or ESP PID selection stops app TRV writes; Planning releases an existing boiler lease on the next successful exchange, otherwise it expires. The last TRV settings remain. The app does not install a separate valve-reset watchdog. An in-flight HA command can finish, but further commands are cancelled after operation, connection or mapping changes. Forecast start-time estimates remain advisory and do not automatically preheat even in Active.

On **Boiler monitor**, use the new connection-health panel to compare accepted exchanges, failure increases reported over 15 minutes, longest observed gap and server rejections. The lifetime counter is **Failed exchanges since ESP restart**. It is not an OpenTherm fault counter; a sleeping laptop or stopped server can increase it. The ESP HTTP timeout is currently 1.5 seconds. A server that never receives a request cannot diagnose its network failure. HTTP 401 suggests pairing/authentication, 400 payload/identity validation, 409 replay, 429 excess frequency; missing/late/invalid responses can also fail at the ESP.

## Kitchen TRV planning

Edit Kitchen and map its ZHA climate entity. Select its **measured temperature** explicitly if it should contribute to the room average. Keep existing room sensors selected to average them; select one representation of each physical probe.

Room details show temperature contributors, actual device target, scheduled room target and requested opening. In Active the app keeps Adaptive mode off and uses Manual/Heat with a bounded elevated device target and requested valve opening. Mechanical valves retain their physical settings.

Previous manual Follow/Focus/Pause automation is paused during Smart Thermostat planning. Planning sends no radiator or boiler heating commands and valve settings remain where they were. Active uses coordinated control instead of those old overrides. The saved previous radiator mode can be cleared from room details. Room mappings, credentials and measurement history survive. The existing ESP frost and fault handling is unchanged; an enclosure probe cannot protect distant pipework.

No firmware update is needed. The navigation item **Activity log** is the application event log, separate from heating schedules.

## Validation and limits

The source and add-on layout are checked locally, and firmware compilation uses isolated test credentials. Docker/Home Assistant Supervisor is unavailable in the development environment, so the container installation itself must be verified on your Home Assistant host. Planning tests and component-rendering checks use isolated fixtures. This release has not been checked in an interactive browser or commissioned against real heating hardware.

References: [Home Assistant app configuration](https://contributors.home-assistant.io/apps/reference/configuration/), [automatic Supervisor connection](https://contributors.home-assistant.io/apps/guides/communication/) and [repository layout](https://contributors.home-assistant.io/apps/guides/repository/).

## Set a room warmer or cooler

Open Heating → Edit room → Room temperatures. Under When High · comfort, choose The same temperature, Warmer or Cooler relative to the house temperature. Enter a positive difference when choosing Warmer or Cooler. Under When Low · reduced heating, do the same relative to the household Low/setback temperature. The preview displays the actual High/Low room targets as you edit, including any caps. For a house temperature of 20°C, Warmer by 0.5°C means a 20.5°C room target; Cooler by 2°C means 18°C. Existing preferences are retained. Save room applies changes; closing the dialog discards edits. This does not calibrate the thermometer or change schedule priority.
