# Cold Harbour ESPHome configuration 0.9.0

Targets the LILYGO T-ETH-Lite ESP32 / RTL8201 with the DIYLESS-style OpenTherm shield and existing Dallas sensor. Wi-Fi is enabled. Ethernet and LEDs remain commented out. The firmware supports Local PID and signed Cold Harbour control. App 0.14.0 adds Planning and Active: Planning releases authority to PID; Active can renew bounded boiler commands when the ESP is in Cold Harbour mode and app readiness passes. No firmware source change or upload is required for existing protocol-revision-two devices.

## App Planning and Active

Select operation in Heating → Smart Thermostat. Planning records and calculates without radiator writes. Active controls mapped ZHA TRVZB settings and signed boiler flow together; the ESP must also have Cold Harbour selected. A remote command lasts at most 90 seconds without renewal. ESP PID selection overrides the app. Local frost/fault protections and the minimum off interval retain priority. TRVs keep their last settings when the boiler returns to Local PID. See [the app guide](../DOCS.md) for readiness and control behaviour.

## Already running 0.8.0

App 0.9.0 adds week-long graphs, phase backgrounds, CH-qualified delta-T and 12-hour displayed times without a firmware upload. The controller component is unchanged. The example YAML now omits `ch_pressure`, because the Atlantic appears to return a fixed placeholder. To stop that polling, remove just that sensor block from your current YAML and compile/upload normally. Keep your existing identity, credentials, calibration and wiring. Older firmware pressure fields are still accepted for compatibility, but are no longer displayed.

## Already running 0.6.1 or 0.7.0

No firmware upload is needed for the app’s readings, state, telemetry log or history. Keep the device in **PID** mode, its saved server URL/key, existing calibration and normal local controls. Update the app first.

The component update adds a direct authenticated capture trigger and automatically attaches passive OpenTherm callbacks. It works even if no capture switch is exposed in Home Assistant. No real credentials or installable binary are supplied in this source package; compile with your existing configuration and secrets.

## Central Heating Enabled

The room-heating permission switch is now named **Central Heating Enabled** (previously **Comfort Heating Enabled**). Update the switch's `name` in your existing main YAML and copy the updated `panel.yaml` and `components/cold_harbour/` before compiling and uploading to apply the new ESPHome, LCD and controller-status labels. Keep the existing `id: comfort_heating` for the internal references. ESPHome derives entity identity and saved switch state from its name, so check the switch setting and any Home Assistant automation references after updating; without a matching saved state the existing restore mode defaults to on. The app also displays the new wording with older firmware. The 15-column LCD shows **Central Heating** with **Enabled** or **Paused (frost)** on the next line.

## Install or update

1. Keep the main YAML, `panel.yaml`, `runtime-connection.yaml` and `components/cold_harbour/` together in `/config/esphome` (the `config/esphome` Samba folder). Merge the example secrets into your existing file; keep your actual Wi-Fi, API and OTA credentials, node name, static IP and sensor offset. The full example defaults to `boiler-controller`; change its substitution to your actual identity when starting fresh. If the node name was edited separately, the app ID must match `cold_harbour.device_id`, not the file name.
2. For an existing 0.6.1/0.7.0 installation, replace the complete `components/cold_harbour/` folder. Keep the existing main YAML and credentials. No new manual OpenTherm hooks or Home Assistant capture entity are required: the component automatically finds the single hub and attaches callbacks. If there are several hubs, explicitly set `cold_harbour.opentherm_id`. Old manual `capture_frame` callbacks may be removed; duplicate copies within 5 ms are ignored. Updating `runtime-connection.yaml` also provides the optional local diagnostic switch.
3. Validate, compile and upload using ESPHome 2026.10.0 and your existing credentials. Keep the ESP-IDF framework, 16 MB flash and hardware pins. This package does not flash your device. An initial three-minute minimum off interval is expected; frost demand bypasses it.
4. In Home Assistant’s ESPHome device page, keep **Heating Control Mode: PID**. Under Configuration, set **Cold Harbour Server URL** to the device listener (for example `http://192.168.1.20:8102`, no path), and enter the pairing key created in the app’s Connections page. Existing saved values survive ordinary OTA and restarts with the same controller ID; factory erase removes them. The key field clears after submission. The configured indicator confirms a stored key; signed-exchange status confirms the matching instance.
5. The Dallas probe remains on GPIO5 with its existing **-5.0°C offset**, which needs real calibration checks. LCD/rotary wiring is retained. Leave the microSD slot unused because pins are shared. Keep Ethernet disabled while using Wi-Fi. Before enabling Ethernet later, comment the complete Wi-Fi block, uncomment the Ethernet block and disconnect/move the old GPIO0 LED data lead. The optional LED package uses GPIO4.

The `Central Heating` climate entity remains the local PID thermostat, including target and Heat/Off mode. The rotary encoder and **Central Heating Enabled** switch remain usable. The app never changes those values. A local enclosure probe cannot establish frost protection in distant rooms or pipework.

## Optional five-minute message capture

In Cold Harbour 0.8.0, choose **Boiler monitor → Diagnostics → OpenTherm capture → Start 5-minute capture**. The signed response queues a bounded diagnostic request independently of heating authority; the ESP confirms its operation ID in telemetry. Requests expire after two minutes if undelivered, are bound to the current boot and are not restored after an app restart. Duplicate deliveries do not extend the timer. Alternatively enable **OpenTherm Message Capture** on the ESPHome device in Home Assistant if that optional switch is present. It starts off after reboot and automatically stops after five minutes. Switching it off ends capture early; starting again begins a new session. The app’s OpenTherm messages tab shows capture state, remaining time, buffer overwrites and downloaded rows.

The callbacks copy direction, message type, data ID and 16-bit data without modifying the message or adding polling. They run in the main loop, not an interrupt. A fixed 64-entry ring uses about 1 KiB; it never writes frames to flash. Frames travel in the existing 30-second signed exchange, without additional HTTP requests or an ESP-side log server. The oldest frames are overwritten when the ring fills, with a visible counter; this may happen with a busy bus or network outage. Unacknowledged entries are retried and the server deduplicates by device boot ID and frame sequence. Frames older than 90 seconds are discarded. The ring and capture timer handle millis rollover; capture does not survive reboot.

The network worker stays at priority 1 with a 16 KiB stack and one job/result slot. Optional trace batches raise the fixed request cap to 6 KiB; large job copies are allocated on the heap to avoid growing the main-loop stack. Responses remain capped at 1.5 KiB, redirects are disabled and the socket-operation timeout remains 1.5 seconds. The main loop does not wait for HTTP. Check reported free heap on the actual board during capture; compilation reports static RAM only.

These are valid decoded OpenTherm message fields, not an electrical bus analyser or full ESPHome console stream. Parity/start/stop bits, malformed physical responses and protocol timeouts are not exported by these hooks. Use ESPHome logs for those errors. Capture times are reconstructed from server receipt and local age, with network delay uncertainty. Capture may contain gaps and must not be treated as complete burner accounting.

## Combi hot water and primary temperature

OpenTherm `t_set` is the CH request. `t_dhw_set` is the separate DHW setpoint. This configuration adds **read-only** `t_dhw` (DHW outlet temperature) and `t_dhw_set` (DHW setpoint readback) sensors. Unsupported registers remain unavailable. It does not configure a DHW setpoint output/number, a maximum-CH-setpoint override or a global modulation cap. The existing DHW enable switch is retained.

The `t_boiler` value is labelled **primary water temperature**: during a tap draw or preheat it can describe the boiler's internal hot-water cycle, rather than water delivered to radiators. Return temperature and modulation are also context dependent. Room control uses room/Dallas temperatures, so this primary reading is not substituted as a room measurement or used to reduce CH demand just because a tap makes it hotter. CH requests remain bounded while the boiler manages DHW priority. The exact Atlantic firmware behaviour must be observed during commissioning; separate OpenTherm registers alone do not prove its implementation.

Fresh `dhw_active` status or a recently reported DHW flow above 0.5 l/min marks a hot-water phase. The firmware then excludes at least two minutes after its last DHW observation. Only a known CH-active phase with fresh boiler feedback is marked `heating_sample_valid`. History retains raw primary readings, but `ch_flow_c`, `ch_return_c` and `ch_modulation_pct` are only present for usable CH samples. A future thermal learner must use these filtered fields/flags. A separate probe on the external CH flow pipe would provide a more direct radiator-circuit measurement; the internal return reading is not assumed to be a replacement.

## PID changes and protections

- Existing gains (`kp=0.5`, `ki=0.01`, `kd=0`) are retained. Negative integral windup is prevented, the positive integral is capped at 1.0, output is averaged across three PID samples, and integral adjustment continues at 5% gain inside the ±0.2°C deadband. These are initial settings to observe on the real installation, not a claim of autotuning.
- Sensor-source changes, control transitions and comfort enable changes reset the integral. Cached output is not reused until a new PID sample arrives. The previous independent target-number state and ineffective heating switch are replaced by controls that reflect or govern actual controller state.
- A three-minute minimum off interval limits new comfort heat calls. Explicit stops are immediate; there is no forced minimum-on period. This does not replace the boiler's internal burner timing.
- Local frost hysteresis starts at a valid calibrated probe reading of 7°C and stops at 9°C, using at most 40°C flow. Boiler faults and unavailable OpenTherm feedback inhibit CH. A fresh boiler-temperature reply is required within 90 seconds. Invalid/stale local and HA temperatures cannot drive PID; when both are unavailable and no valid remote lease exists, CH demand is zero.
- Network/API outages do not trigger periodic API reboot cycles. An OTA update temporarily releases CH without persisting a different comfort-switch setting. Restarts begin without a remote lease.

**The enclosure-mounted probe only protects the temperature it measures.** It cannot establish that rooms or remote pipework are frost-safe. Its accuracy and the retained offset need checking. Boiler power loss, ESP power loss, closed/stuck valves and frozen exposed pipes require installation-level arrangements. Keep the boiler's native protections and establish its minimum circulation path before expanding smart-valve control.

## Verification

The full 0.8.0 Wi-Fi firmware compiled with ESPHome 2026.10.0 / ESP-IDF and isolated credentials. Native checks cover capture limits/expiry/acknowledgements and the controller protections. No firmware has been uploaded by this development workflow. Observe temperatures, hot-water priority, local controls, source fallback and frost behaviour on the real installation before relying on it unattended.

References: [ESPHome OpenTherm callbacks](https://esphome.io/components/opentherm/), [LILYGO hardware](https://github.com/Xinyuan-LilyGO/LilyGO-T-ETH-Series), [Ethernet](https://esphome.io/components/ethernet/) and [PID](https://esphome.io/components/climate/pid/).
