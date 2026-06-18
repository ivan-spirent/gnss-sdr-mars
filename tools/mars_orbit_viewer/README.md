# Mars Orbit Viewer

Static Three.js viewer for the Mars GNSS scenario.

Run from the repository root:

```sh
python3 -m http.server 8767 --bind 127.0.0.1
```

Open:

```text
http://127.0.0.1:8767/tools/mars_orbit_viewer/
```

Default data sources:

- `/Scenario Data/GPS_Mars.gps`
- `/Scenario Data/sat_data_V1A1.csv`
- `/Scenario Data/motion_V1.csv`
- `/build/latest_pvt.geojson`
- `/build/gnss_sdr_pvt.nmea`

Three.js is vendored in `vendor/` with its MIT license.
