# Daylight lighting

## Set up a group

1. Open **Lighting → Add light group**.
2. Name the group and choose its warmest and coolest white temperatures in Kelvin. Lower Kelvin is warmer; higher Kelvin is cooler.
3. Select individual adjustable white lights from Home Assistant. A light can belong to one Cold Harbour group.
4. Save the group. Repeat for spaces with different preferred ranges.
5. Select **Enable daylight lighting** to start. Each group can also be paused separately in its editor.

The connection is shared with the rest of Cold Harbour. No additional token or integration is needed. Home Assistant must expose `sun.sun` with its elevation, and each selected light must report `color_temp` support and its minimum and maximum Kelvin temperatures. Choose individual bulbs rather than Home Assistant aggregate light groups, so an adjustment cannot switch on their off members.

## How targets follow the sun

Cold Harbour uses Home Assistant's sun elevation at the configured home location. By default, each group uses its warmest white at −6° or below, eases towards cooler white as the sun rises, and reaches its coolest white at 45° or above. The same curve runs back towards warm white as the sun sets. At night, the target stays at the group's warmest setting.

The curve uses absolute sun height, so lower winter sun produces warmer targets than higher summer sun. It is a configurable lighting preference curve, not a measurement of outdoor colour temperature. **Lighting → Settings** lets you change the elevation endpoints and transition time. The defaults are −6°, 45° and 60 seconds; supported transition times are 30–300 seconds.

Each bulb's target is limited to the overlap between its reported capabilities and its group's range. A bulb with no overlapping range is left alone and shown with a range warning.

## Adjustments and monitoring

- The server checks lighting during its existing Home Assistant polling loop, normally every five seconds after the previous refresh completes. It keeps working when the browser is closed while the app is running.
- Only lights currently reported as on are adjusted. Commands set white temperature without changing brightness. Switching a light off clears its pending adjustment when the next refresh sees it.
- Newly switched-on lights move towards the current target. Bulbs reporting native transition support receive the target with the configured fade duration. Other bulbs receive small interpolated Kelvin changes over that duration.
- A bulb without a native fade needs a reported starting Kelvin temperature. If it does not have one, select white temperature mode in Home Assistant first; Cold Harbour explains this beside the light.
- Changes within 75 K of the target are left alone to avoid constant commands. A reading outside the group's effective limits is corrected even when the difference is smaller.
- Native fades are allowed to complete before starting another. Pausing stops subsequent adjustments; a fade already accepted by a bulb may finish.
- Missing, invalid or sun readings older than 15 minutes pause adjustments. A disconnected Home Assistant connection also pauses them. The last light settings are left in place.
- Failed light commands show a retry status and are retried after a minute. Lighting requests run separately from the heating loop.

Groups and lighting settings persist across restarts and are included in encrypted configuration backups. Older backups without lighting settings restore with daylight lighting disabled.

Home Assistant references: [Sun integration](https://www.home-assistant.io/integrations/sun/), [light capabilities and transitions](https://contributors.home-assistant.io/core/entities/light/).

# Heating budget emergency temperature

Open **Energy → Heating plan & budget → Daily gas budget** and set **Emergency room temperature °C**, then save the heating plan. The default is 7°C; the setting accepts 7–25°C and is included in configuration backups. Existing installations and older backups use 7°C automatically.

In Smart Thermostat **Active** mode, a room below this temperature requests heat even when the daily gas limit, a schedule allocation or a manual budget pause would normally stop heating. Only rooms needing emergency heat request their radiators to open; other rooms remain paused. A room warms to 0.5°C above the emergency temperature before its budget pause resumes. For example, a 10°C setting starts heating below 10°C and stops emergency heating at 10.5°C. Emergency gas use still counts towards the budget.

While the budget is enabled, the emergency temperature also acts as a minimum when the budget is still available and a scheduled target is lower. Normal heating above this minimum continues as usual. Emergency heating uses fresh mapped room temperatures and overrides sunshine reductions and early coasting when needed to reach the recovery temperature. The Heating and Energy pages explain when it overrides the budget. Planning mode only previews the request. Normal boiler readiness, ESP mode, heating permission, fault checks and radiator confirmation still apply; the device's local frost protection and fallback controls remain separate.

# Room radiator valves

Map the ZHA thermostat in **Edit room → Devices & sensors**. Enable **Valve opening degree**, **Valve closing degree** and **Adaptive mode** on the same ZHA device. Select **Active** in Cold Harbour and **Cold Harbour** mode on the ESP.

The room card shows the requested opening and the setting reported by Home Assistant. The percentages describe the valve setting. Use the reported heating or idle state alongside them. A fixed opening applies only after the room calls for heat. For example, a target of 18°C with a 1.5°C reopen shortfall waits until the room falls below 16.5°C before opening.

Use **Adjust** on the room card to set an opening for 15 minutes to two hours. A positive opening requests room heat, and 0% closes the valve and removes the room's heat request. Select **Resume automatic** to return to the schedule early. A gas-budget pause, frost protection, missing room readings, or the 28°C room limit can suspend the override.
