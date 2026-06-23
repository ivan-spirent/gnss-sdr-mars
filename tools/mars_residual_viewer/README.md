# Mars Range Residual Viewer

Static dashboard for Molli Mars post-fit range residual analysis.

Run from the repository root:

```sh
python3 -m http.server 8770 --bind 127.0.0.1
```

Open:

```text
http://127.0.0.1:8770/tools/mars_residual_viewer/
```

The default loader reads:

- `/Mars Molli 32 5 min/5 minutes IQ 32 SV Molli_scenario_data/sat_data_V1A1.csv`
- `/gps_mars_molli_32_5min_nav_ephemeris.xml`
- `/gps_mars_molli_32_5min_ephemeris_corrections_true_dynamic.csv`
- `/build/gnss_sdr_molli_true_dynamic_pvt.nmea`

The residual is computed as dynamically corrected broadcast-orbit geometric range minus simulator range, using the Mars `0 deg, 0 deg, 0 m` truth receiver position and no Mars frame/time offset.
