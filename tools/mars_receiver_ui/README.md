# Mars Receiver UI

Static dashboard for GNSS-SDR Mars replay artifacts.

Run from the repository root:

```sh
python3 -m http.server 8770 --bind 127.0.0.1
```

Open:

```text
http://127.0.0.1:8770/tools/mars_receiver_ui/
```

The `Load build outputs` button reads:

- `/build/gnss_sdr_gps_like_dynamic_orbit_corrected_no_frame.log`
- `/build/gnss_sdr_pvt.nmea`
- `/build/gps_like_dynamic_orbit_corrected_no_frame_geojson/latest_pvt.geojson`
- `/build/gnss_sdr_gps_like_iq_summary.json`

The file pickers can load a different receiver log, NMEA file, or GeoJSON trajectory.
The sky plot is derived only from NMEA `GSV`/`GSA` sentences.
The 3D and 2D error plots assume the GPS-like truth receiver position is Mars latitude `30`, longitude `30`, height `30 m`, and compute distance on the IAU Mars ellipsoid used by the receiver build.
The I/Q dominance panel is derived from the compact I/Q summary JSON when present, or directly from `MARS_SYNC_DIAG` prompt samples in the receiver log. It prefers telemetry-output prompt samples, then post-lock 1 ms samples, then pre-lock 1 ms samples.
