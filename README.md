# Cold Harbour

Cold Harbour 0.14.1 coordinates room demand, TRVZB radiator openings and OpenTherm boiler flow through Home Assistant. Smart Thermostat has Planning and Active modes. New installations and upgrades start in Planning; this update does not enable heating control automatically. Local PID remains an independent ESP mode and fallback.

For Home Assistant add-on installation and capture controls, follow [DOCS.md](DOCS.md). The release ZIP includes the add-on manifest, repository metadata, ingress, watchdog and automatic Supervisor API connection.

## Run and update

Requires Node.js 24+. Run `npm start` and open http://localhost:8099. For LAN testing in PowerShell:

```powershell
$env:HOST = "0.0.0.0"
npm start
```

Open this computer’s LAN IP on port 8099 from another device. The independent signed ESP listener defaults to `0.0.0.0:8102`, configurable with `DEVICE_HOST` and `DEVICE_PORT`. The web listener uses `HOST` and `PORT`. In the Home Assistant add-on, enable the optional 8102/tcp port; open the UI through ingress. Docker Compose keeps the web port on localhost and publishes 8102.

Stop the previous app, replace its source files and restart. Keep the complete `data` directory, including `secrets.key`; it contains encrypted credentials, pairing, room mappings and history. The migration retains those records and Home Assistant energy mappings. It removes the old thermostat mapping, control settings, demo setting and saved direct Octopus credentials. Legacy command and commissioning-test endpoints are removed. The dedicated Heating operating-mode dialog can select Active. Planning leaves radiator settings unchanged and releases the boiler to Local PID on its next signed exchange. Previous Follow/Focus/Pause room overrides do not control the version-two Smart Thermostat. The new mode selection persists across ordinary app restarts.

## Settings and configuration backups

**Settings** brings together **Connections**, **Notifications**, **Entity library**, and **Backups**. The entity library searches names, IDs, states and units, filters by type and availability, and sorts by name, ID, state or type. It shows 25 rows per page by default, with 50 and 100 row options. Old Connections and Entity library bookmarks still open the corresponding Settings section.

In **Settings → Backups**, choose a password of at least ten characters and download the configuration backup. The JSON file uses password-based scrypt key derivation and authenticated AES-256-GCM encryption, including the saved Home Assistant token and ESP pairing key. Keep the password: it cannot be recovered from the file. The instance’s local `secrets.key` is never exported; import encrypts the credentials with the destination’s own key.

To restore, choose the file (up to 8 MB), enter its password and select **Preview backup**. Review the rooms, schedules, timezone, Home Assistant address and controller, then confirm replacement and select **Import configuration**. The preview expires after ten minutes and must be repeated if configuration or credentials change. Invalid, unsupported, corrupted or incorrectly passworded files leave the existing setup untouched. The full validated configuration is replaced in one database transaction.

Backups include current connection settings, energy mappings, room sensors and presence settings, household occupancy, heating schedules, weather planning, freshness/retention settings and saved credentials. Import replaces those settings, rooms and legacy schedules, including clearing a destination credential when the backup has none. Smart Thermostat always returns to **Planning**, and legacy radiator overrides return to Monitor. Queued app commands are discarded; a request already sent to Home Assistant can still complete. The next signed exchange releases the boiler to Local PID; TRVs retain their last physical settings. Review the imported setup before choosing Active.

History, learning observations, cached entities/forecasts, activity logs, host ports/environment variables, Supervisor credentials and old migration archives are not transferred. Existing destination history stays in place. Supervisor connections use the destination’s Supervisor token; a standalone destination needs its own saved Home Assistant credentials if the backup has none. When moving hosts, stop the old controlling instance and update the ESP’s **Cold Harbour Server URL** to the new device listener. The pairing key can be retained. For a complete history backup, keep using a stopped copy of the complete `data` directory, including `secrets.key`.

## Home Assistant notifications

Open **Settings → Notifications** to discover notification destinations using the existing Home Assistant connection, including the automatic Supervisor connection in the add-on. Select your preferred recipients, enable sending to saved devices, and choose **Save notifications**. These settings survive restarts and are included in encrypted configuration backups. Older backups without notification preferences restore with notifications off.

In **Send a test notification**, choose one device, optionally edit the title and message, then select **Send test message**. A test can target an unsaved device even when sending to saved recipients is off. Only that selected destination receives the test. Success means Home Assistant accepted the request; check the device to confirm delivery. Unavailable destinations cannot be tested. Use **Refresh devices** after adding or renaming a destination; save any pending preferences first.

Discovery supports [Companion app notification actions](https://companion.home-assistant.io/docs/notifications/notifications-basic/) (`notify.mobile_app_*`) and [notify entities](https://www.home-assistant.io/integrations/notify/) (`notify.send_message`). Other HA devices need one of these notification destinations before they can receive messages. Unknown notify-entity state can mean no message has been sent yet and does not prevent testing. Titles are included only where supported. Home Assistant and device permissions can still prevent delivery after a request is accepted.

The shared server sender is available as `context.notifications.send({title,message})`. `POST /api/notifications/send` accepts the same fields and uses only the enabled, saved recipients; `POST /api/notifications/test` accepts `{target,title?,message?}` for one discovered destination. Both endpoints require the existing JSON and `X-MODS-Request: 1` protections. `GET /api/notifications` returns destination IDs and availability. Multi-recipient sending returns per-device acceptance/errors, including partial failures, without retrying successful recipients. Message text and credentials are not recorded in activity logs. This adds the sending facility and manual tests; automatic alert triggers are not configured by this feature.

## Connect the ESPHome device

Existing 0.6.1 firmware works without another upload. Leave **Heating Control Mode** on **PID**. In Connections, match **Controller ID** to the firmware’s `cold_harbour.device_id` (usually its `device_name` substitution). The ESPHome node name can differ if the YAML was edited separately.

Retain the existing pairing key if the device is already paired. Otherwise create one and enter it in the Home Assistant ESPHome device’s **Cold Harbour Pairing Key** text control. Set **Cold Harbour Server URL** to the app computer’s device listener, for example `http://192.168.1.20:8102`, without a path. Both settings survive ordinary restarts and can be changed while running.

The ESP sends signed telemetry every 30 seconds. Planning replies return `authority: pid`, zero lease and no app heat/off demand. Active additionally requires the ESP’s Cold Harbour selection, fresh HA/boiler feedback, comfort permission, valid ESP flow bounds and verified radiator controls. Pending radiator settings hold boiler heat with a signed remote-off lease. Confirmed settings allow bounded flow requests with a 90-second lease. The ESP retains frost/fault handling and its minimum off interval. A lost lease returns boiler control to Local PID; radiator settings are not automatically restored. Boiler climate services are never used: boiler demand travels over the authenticated device connection.

## Exchange health

Boiler monitor separates the cumulative Failed exchanges since ESP restart counter from accepted exchanges, newly reported failure increases, longest observed gap and HTTP server rejections over the last 15 minutes. The counter includes failed/rejected app HTTP exchanges, not OpenTherm bus errors. The current ESP request timeout is 1.5 seconds. Laptop sleep, a stopped app, firewall/network issues, slow replies, authentication or response validation can contribute; the lifetime total alone cannot identify the cause. Counter increases are attributed to when reported, not exact failure times during outages. Boot/counter resets do not become negative or fabricated failures. Requests that never reach the server cannot have a server rejection reason. Diagnostics never include request bodies or credentials.

## Monitor and logs

**Boiler monitor** shows CH request, primary/return water, DHW temperature/setpoint/flow, modulation, heating delta-T, flame/CH/DHW flags, fault/frost state, local/PID temperatures, input source, memory, lease and exchange health. Unsupported or stale source values are omitted; an offline device is clearly marked and its displayed values are historical.

Long-term history is recorded once a minute for the configured 1–90 days (default 30). Interactive graphs use every 30-second exchange, or individual captured register readings when selected. Exact tooltips, series toggles, keyboard/touch inspection, drag zoom and CSV exports make those values accessible. The 15-minute/1/6/24-hour and seven-day views retain primary data, with background shading for reported heating, hot water, settling and idle phases. Outages and unknown phases remain unshaded. Seven-day charts retain all available exchanges; SVG rendering preserves extremes while tooltips and CSV use the original readings. The separate heating delta-T chart uses only fresh CH-qualified flow/return pairs, excludes DHW and settling, and shows a dashed 20°C tuning reference. Lower return temperatures and steady comfortable operation matter more than forcing a fixed differential. All displayed times, including schedule editors, use am/pm; stored timestamps and exports remain ISO/24-hour machine-readable values. Only fresh CH-qualified samples should be used for future heating analysis; internal primary and return sensors can describe hot-water operation.

The Device logs view shows operating-state changes, faults, restarts and restored connections. Routine temperature and modulation changes stay in the charts. Accepted exchange telemetry is retained for chart history and diagnostic API downloads for seven days. It is not the ESPHome console log. Activity records connection and controller/phase/fault/frost changes. Direct OpenTherm message capture uses firmware component 0.8.0; older 0.7.0 capture switches are supported through Home Assistant. See the details in [the firmware guide](esphome/README.md). Captures are kept for 24 hours. Downloads return up to the latest 5,000 entries; raw-message storage is capped at 50,000 rows and exchange logs at 125,000.

The message log preserves direction, type, data ID and hexadecimal data, with selected temperature/status decoding. It captures existing valid request/reply fields rather than physical wire bits. Invalid frames and protocol timeouts remain in ESPHome logs. Capture timestamps are estimated from server receipt and device age, not synchronized bus timestamps. Read-request placeholders and negative replies are never decoded as measurements.

## Home Assistant energy and room planning

Energy readings, electricity/gas consumption, costs, standing charges and tariffs are read exclusively through Home Assistant’s BottlecapDave Octopus Energy integration. Cold Harbour no longer connects directly to Octopus. Under Connections, load HA entities and select the appropriate meters; overrides support renamed entities. Interval history, independent usage/cost completeness, variable rates and UK clock changes remain supported.

In **Heating**, the house setpoint defines comfort. The schedule selects **High** or **Low** for each room: High uses house setpoint + room offset, Low uses setback + setback offset. Low targets never exceed the room comfort target and have a 7°C floor. High rooms lead comfort demand; low rooms can still request heat below setback. A fresh room below 7°C takes precedence, with a planned flow cap of 40°C. A warm kitchen cannot cancel another room’s request.

The main page shows the resulting Smart Thermostat decision, leading room and bounded planned flow beside actual Local PID state. **Schedule**, **Occupancy** and **Weather planning** open dialogs. The Someone home and Everyone away schedules each have weekday/weekend rows with direct room High/Low selectors and draggable time boundaries. Individual-day editing is removed. The activity selector and manual radiator dropdowns have been removed. Presence observations remain available for reference, without overriding scheduled priority.

Household person/tracker entities select home versus away. Anyone home runs the Someone home schedule; everyone known away for the configured delay selects Everyone away. Both schedules can select High or Low for any room; away does not force every room Low. Missing tracking retains the home schedule. Occupancy overrides and setback temperature are in the Occupancy dialog.

Upgrade preserves schedule times and room offsets, converts priorities 3–5 to High and 1–2 to Low, resets manual activity to automatic, and removes activity temperature offsets from the new calculation. The complete previous plan is archived in SQLite settings for recovery; original rule records remain. This deliberately changes target semantics to the simpler house/setback model. Review the preview in Planning before selecting Active. The weekday/weekend upgrade uses Monday and Saturday as the group plans for both occupancy schedules, and archives the previous individual days as `heatingPlanBeforeOccupancySchedules`.

**Local PID** means the existing ESP control using HA average house temperature, with the local Dallas probe if that input becomes unavailable/stale. It runs independently of Cold Harbour. **Smart Thermostat** means the app’s scheduled room and weather-aware plan. The firmware’s existing `PID` / `Cold Harbour` option names are retained for compatibility and translated in the app. Select Cold Harbour on the ESP and Active in the app to use live control. ESP PID is a local override and prevents app TRV writes. Existing protocol-revision-two firmware supports this without another upload.

The Heating page records room temperatures/targets and ESP demand once a minute, independently of browser visits. Linked graphs show each room, optional dashed room targets, house target, planned Smart Thermostat flow, actual requested flow temperature, actual modulation and Local PID demand. Temperature and percentage axes are separate. Hover/tap, keyboard inspection, synchronised drag zoom and CSV export are available for 1/6/24 hours and seven days. History starts collecting after this update; no historical room values are invented.

Warm-up observations use the last 30 days of minute records. A period requires continuous fresh CH-active feedback, no fault or DHW/settling, stable sensor membership and target, at least three distinct fresh source reports, ten minutes and a 0.2°C rise. Cached temperatures are not counted as fresh evidence. Room statistics show total observed heating minutes divided by total observed positive rise, plus degrees/hour, period count and recent evidence. Fewer than three qualifying periods are labelled early estimates; no evidence stays Collecting. These observations are not causal efficiency measurements or a calibrated heat-loss model. Qualified completed periods can support indicative preparation estimates, subject to weather/flow/source matching. Heating samples are retained for 90 days, capped at 129,600 rows. New minute observations retain reported outdoor source/time, actual CH flow/return and room context. Historic samples without identifiable outdoor provenance remain in the overall warm-up rate and are excluded from weather-based learning.

## Smart radiator valves

In Heating, edit the kitchen room and map its ZHA climate entity as the radiator. The temperature picker also accepts that entity's measured current_temperature, alongside separate room sensors. Select it explicitly; mapping a valve does not automatically add a temperature input. Fresh selected readings are averaged equally in Celsius. Unknown, invalid, unavailable and stale readings are skipped. Do not select both a thermostat attribute and a duplicate separate entity for the same physical probe.

Smart Thermostat shows actual and intended room/device targets and requested valve openings. Map each valve’s ZHA climate entity, and enable its Valve opening degree and Valve closing degree number entities. Its Adaptive mode switch must also be available. Controls are discovered only from that same ZHA device and must report the supported 0–100 range. Missing, ambiguous, disabled or unavailable controls prevent Active operation. Mechanical valves cannot be closed by the app; they retain their physical settings.

Active keeps Adaptive mode off and the TRV in Manual/Heat. Requested opening starts at 50% travel per 1°C shortfall, rounded upward in 5% steps with a 10% minimum while heat is needed and 100% maximum. Heat starts more than 0.2°C below target and stays requested until the target is reached. Closing degree stays at 100%. The actuator setpoint is 3°C above the room target, raised if needed above the TRV reading, but never more than 5°C above the room target or beyond device limits. This preserves an internal thermostat ceiling. The room’s intended target remains separate. It is an initial proportional controller, not a learned or calibrated valve-flow model. External temperature selection/input are not changed; keep external mode off unless a separate automation supplies fresh actual temperatures.

Changed radiator targets are rate-limited to one per minute; unconfirmed settings retry after five minutes. HTTP success is not confirmation: the app waits for fresh HA-reported settings before requesting boiler heat. Reported settings do not prove physical valve travel or water flow. Room snapshots include planned opening and reported opening; a reported zero-opening valve is excluded from new warm-up periods.

Switching to Planning stops app valve writes; the next ESP exchange releases the boiler to Local PID. TRVs retain their last settings on Planning, app/network failure and local fallback. No independent HA valve-reset watchdog is installed. Pending HTTP writes cannot be recalled, but mode/connection/mapping changes prevent subsequent writes in the same sequence. Previous legacy room overrides can be cleared from details and do not bypass coordinated version-two control.

## Weather-aware planning

Weather planning is optional and runs on the Cold Harbour host using current HA `weather.*` temperature attributes or an outside `sensor.*`, with Celsius/Fahrenheit conversion and freshness checks. It does not enable OpenTherm’s boiler weather compensation. [Home Assistant documents weather temperature attributes and units here](https://www.home-assistant.io/integrations/weather/).

For a room that needs heat, the initial flow estimate is:

```text
relative heat loss = clamp((room target - outside) / (room target - cold design outside), 0, 1)
starting flow = minimum flow + (maximum flow - minimum flow) × relative heat loss
planned flow = clamp(starting flow + room shortfall × correction gain, minimum flow, maximum flow)
```

Defaults are 35–52°C flow, −3°C design outside and 5°C flow correction per 1°C room shortfall. No heat request gives zero planned flow. Disabled or unavailable weather uses minimum flow plus room correction, with unavailable weather explicitly labelled. Room frost planning has a 40°C cap. The weather dialog includes a curve preview. These are adjustable initial estimates, not measured kW, learned heat loss or requested modulation percentages. Wind, future room cooling, solar-gain prediction and automatic heating-curve calibration remain future work. Active requests are additionally clamped to the current ESP limits and its local safety authority.

## Forecasts and continuous room learning

In Weather planning, select a current reported outdoor source and a forecast weather entity. A single `weather.*` entity can supply both; alternatively use a local outside sensor for observations and a separate weather entity for forecasts. Enable weather planning and choose **Save & view forecast**. The app retrieves hourly and daily data with HA’s read-only [weather.get_forecasts action](https://www.home-assistant.io/actions/weather.get_forecasts/), using the [REST response-data wrapper](https://contributors.home-assistant.io/core/internals/rest-api/). It never calls heating services for this feature.

Forecasts refresh on the host every 30 minutes; failed types retry after five minutes, independently. The hourly cache expires after two hours and daily cache after twelve. Unsupported types, missing units, gaps and stale data are explicit. Forecasts stay on the host; there is no additional ESP polling or firmware work. Selecting a reported outdoor source records its current readings for learning even when weather-based flow planning is off.

**Heating observations → View observations & planning** opens a large dialog. **Room learning** shows active periods, distinct source counts, confirmed heating/outdoor samples, first reach of the planned target, weather bands, descriptive correlation, interactive episode graphs and recent evidence. CH circulation can contribute during a flame-off interval if fresh, qualified CH feedback remains active. DHW, settling, faults, stale readings and paused valves are excluded. A period still needs three distinct readings, ten minutes and a 0.2°C rise. Collection runs independently of the browser; the open dialog refreshes, preserves chart zoom, and pauses redraw while inspecting pinned values or open details.

**Plan ahead** shows hourly outside temperatures and conditional starting-flow guidance for up to 72 hours, a seven-day daily low/high outlook, and Low → High room transitions over the next 48 hours. Both Someone home and Everyone away are shown as alternative schedule scenarios; future occupancy is not predicted. Daily values are not turned into artificial hourly forecasts. Missing hourly coverage prevents a precise start estimate.

An indicative warm-up/start time requires at least three completed comparable periods over two days, within 2°C starting room temperature, 3°C outside and 5°C actual boiler flow, with at least 80% reported-outdoor coverage and matching room sensors, valve mapping and outdoor source. The estimate uses aggregate observed minutes per degree from that neighbourhood. Six periods over three days receive the stronger evidence label. Ongoing periods are not training evidence. The planning window defaults to 180 minutes; estimates beyond it are labelled rather than silently truncated into an achievable target.

Preparation estimates start from the room temperature **now**. Future cooling, solar gain and future occupancy are not simulated, so these are conditional estimates, not promises of readiness. Initial flow guidance still uses the adjustable heating curve; warm-up evidence does not automatically retune PID or the boiler curve. Forecasts are never stored as measured outdoor observations. SQLite preserves measurement history and settings across restarts; forecasts are fetched again after startup. The main Heating page retains a compact observation summary.

## Validation

Application checks cover priority selection, migration, weather units/freshness/fallback, sunny rooms, occupancy, planned-versus-actual history and the absence of planning commands, alongside the existing signed OpenTherm, energy and persistence coverage. Active mode tests additionally cover signed lease bounds, observed valve acknowledgements, registry identity, cancellation, persisted mode, hysteresis and connection-health accounting. Native firmware protections are unchanged. The app and dialog markup are checked with isolated fixtures; this release has no new interactive browser or real HA/boiler/TRV commissioning result. Home Assistant container installation still requires the target host.

## Room temperature preferences

In Edit room, When High · comfort and When Low · reduced heating each offer The same temperature, Warmer or Cooler, with a positive degree difference. High compares with the house temperature; Low compares with the household Low/setback temperature. Live previews show the resulting targets and any caps. For example, house 20°C with Warmer by 0.5°C targets 20.5°C; Cooler by 2°C targets 18°C. Changes to the house temperature continue to move the room target accordingly. Existing signed adjustments are preserved without changing controller behaviour. These preferences adjust desired room temperatures, not sensor calibration.
# Cold-Harbour
