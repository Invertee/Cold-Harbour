# Release notes

## 0.20.0 — 24 November 2026

- Fixed ZHA valve discovery for Adaptive mode registry identifiers. Changed opening requests now reach Home Assistant on the next control cycle, even when the previous request is still awaiting confirmation.
- Room cards show valve activity, requested opening and the setting reported by Home Assistant. Heating history plots both opening settings.
- In Active mode, set a temporary valve opening from the room card for 15 minutes to two hours, or resume automatic control early. Frost protection and gas-budget limits take precedence.
- Shortened interface copy, grouped room devices and sensors in a collapsible section, and added temperature corrections to the Sun impact slider.

## 0.19.2 — 17 November 2026

- Added a configurable emergency room temperature that can override a gas-budget pause.

## 0.19.1 — 9 November 2026

- Added a three-minute idle period on the ESP when a Cold Harbour lease expires, is released, or control is changed to Local PID after remote operation.
- Reconnecting cannot bypass the idle period. Further dropouts during the same wait do not extend it. Once it ends, a fresh remote command or valid Local PID demand can resume, subject to the existing minimum off interval.
- Frost protection, boiler faults, OpenTherm availability and local heating permission retain priority.
- The ESP reports **Control handover: idle** during the wait and does not report Cold Harbour as controlling while idle.
- The firmware option `handover_idle` defaults to `3min` and accepts 30 seconds to 15 minutes. Existing YAML uses the default automatically after updating the component and recompiling.
- Requires updating and uploading the ESP firmware; installing the app alone cannot change fallback behaviour during a network outage.

## 0.19.0 — 6 November 2026

- Added the Lighting page using the existing Home Assistant connection.
- Added persistent light groups with separate warmest and coolest Kelvin limits, light selection, search, editing and deletion.
- Added a smooth sun-elevation temperature curve with configurable twilight and high-daylight endpoints for seasonal variation.
- Added 60-second adjustments by default, native bulb fades where supported, and stepped temperature adjustments otherwise.
- Added per-light reported and target temperatures, on/off status, paused and unavailable states, and retry feedback.
- Limited adjustments to selected, switched-on individual lights and each bulb's supported temperature range. Brightness is preserved.
- Kept lighting requests separate from heating updates and included lighting configuration in backups.
- Daylight lighting starts disabled until configured and enabled. Existing heating and connection settings are retained.
