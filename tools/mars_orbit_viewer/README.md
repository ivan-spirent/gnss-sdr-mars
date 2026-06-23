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

- `/Mars-GPS-like-5min/GPS_orbits_mars 1.gps`
- `/Mars-GPS-like-5min/sat_data_V1A1.csv`
- `/Mars-GPS-like-5min/motion_V1.csv`
- `/build/gps_like_dynamic_orbit_corrected_no_frame_geojson/latest_pvt.geojson`
- `/build/gnss_sdr_pvt.nmea`

Three.js is vendored in `vendor/` with its MIT license.
