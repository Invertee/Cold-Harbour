# Cold Harbour

Cold Harbour brings heating plans, boiler monitoring, energy readings and daylight lighting into one app using the existing Home Assistant connection.

Version 0.19.1 adds a three-minute idle period on the ESP when Cold Harbour control hands back to Local PID. See the [firmware update instructions](esphome/README.md) to install this change on your device.

Version 0.19.0 adds the **Lighting** page. Create groups of adjustable white lights, set a warmest and coolest temperature for each group, then enable daylight lighting. Targets follow the sun's elevation with a default transition of one minute. New and upgraded installations start with daylight lighting disabled.

See [Daylight lighting](DOCS.md) for setup and behaviour, and [release notes](CHANGELOG.md) for this release.

## Run locally

Use Node.js 24 or newer. Run `npm start`, then open `http://127.0.0.1:8099`. Configure the Home Assistant connection under **Settings → Connections**. Data is stored in `data/` unless `DATA_DIR` is set. The included Docker Compose file provides an alternative local setup.

The Home Assistant add-on uses the Supervisor connection automatically. Its web interface is available through Home Assistant ingress.

## Checks

Run `npm test` and `npm run check`. Where process creation is restricted, the test suite can also run with `node --test --test-isolation=none`.
