# Mars Receiver UI

Static dashboard for GNSS-SDR Mars replay artifacts.

Run from the repository root:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

Open:

```text
http://127.0.0.1:8765/tools/mars_receiver_ui/
```

The `Load build outputs` button reads:

- `/build/gnss_sdr_run_fixed.log`
- `/build/gnss_sdr_pvt.nmea`
- `/build/latest_pvt.geojson`

The file pickers can load a different receiver log, NMEA file, or GeoJSON trajectory.
The sky plot is derived only from NMEA `GSV`/`GSA` sentences.
