# Mars Range Residual Viewer

Static dashboard for GPS-like Mars post-fit range residual analysis.

Run from the repository root:

```sh
python3 -m http.server 8770 --bind 127.0.0.1
```

Open:

```text
http://127.0.0.1:8770/tools/mars_residual_viewer/
```

The default loader reads:

- `/Mars-GPS-like-5min/sat_data_V1A1.csv`
- `/gps_mars_gps_like_5min_nav_ephemeris.xml`
- `/gps_mars_gps_like_5min_ephemeris_corrections_no_frame_dynamic.csv`
- `/build/gnss_sdr_pvt.nmea`

The residual is computed as dynamically corrected broadcast-orbit geometric range minus simulator range, using the Mars `30 deg, 30 deg, 30 m` truth receiver position and no Mars frame/time offset.
