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
