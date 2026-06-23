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

- `/Mars Molli 32 5 min/5 minutes IQ 32 SV Molli_scenario_data/GPS_Mars_32_SV.gps`
- `/Mars Molli 32 5 min/5 minutes IQ 32 SV Molli_scenario_data/sat_data_V1A1.csv`
- `/Mars Molli 32 5 min/5 minutes IQ 32 SV Molli_scenario_data/motion_V1.csv`
- `/build/molli_external_truth_satpos_3d_geojson/latest_pvt.geojson`
- `/build/gnss_sdr_molli_external_truth_3d_pvt.nmea`

Three.js is vendored in `vendor/` with its MIT license.
