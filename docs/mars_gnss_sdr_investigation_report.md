# Mars GNSS-SDR Investigation Report

Date: 2026-06-18

## Executive Summary

This work adapted GNSS-SDR to process the Mars GPS L1 C/A simulation, recover usable telemetry from satellites that were previously tracked but not decoded, and produce 2D fixed-surface PVT output for a receiver located near 0 deg latitude and 0 deg longitude on the Mars surface.

The original failures were not caused by bad simulator navigation data, failed parity logic, bad preamble detection, channel cross-talk, dropped tracker-to-telemetry samples, or weak acquisition. The strongest remaining root cause is tracker-side Costas branch ambiguity: the prompt sign stream can be stable, strongly locked, and still wrong for stretches after a valid preamble. A decoder-side branch repair option now detects compact periodic branch-slip masks only when they make all 10 GPS LNAV words pass parity.

The latest normal Mars run completes the full 3 minute capture, emits NMEA and GeoJSON PVT outputs, and can be inspected in the two static web UIs.

## Committed Artifacts

- Mars-aware GNSS-SDR source changes in acquisition, tracking, telemetry decoding, observables, RTKLIB PVT, and constants.
- Mars replay configs:
  - `conf/File_input/GPS/gnss-sdr_GPS_L1_CA_Mars_SPIR.conf`
  - `conf/File_input/GPS/gnss-sdr_GPS_L1_CA_Mars_SPIR_tlm_debug.conf`
- Scenario metadata:
  - `Scenario Data/GPS_Mars.gps`
  - `Scenario Data/GPS_L1_ca.navtxt`
  - `Scenario Data/motion_V1.csv`
  - `Scenario Data/sat_data_V1A1.csv`
- Assistance XML files:
  - `gps_mars_ephemeris.xml`
  - `gps_ephemeris.xml`
  - `gps_iono.xml`
  - `gps_utc_model.xml`
- Conversion and analysis scripts:
  - `utils/scripts/spirent_gps_to_gnss_sdr_xml.py`
  - `utils/scripts/analyze_mars_l1ca_sync.py`
- Web UIs:
  - `tools/mars_receiver_ui/`
  - `tools/mars_orbit_viewer/`
- Runtime-output ignore rules in `.gitignore`.

The 11 GB raw IQ capture in `Mars 3 minutes/`, generated build outputs, receiver logs, NMEA files, GeoJSON files, and Python cache files are intentionally not committed.

## Mars Constants and Ephemeris

GNSS-SDR and RTKLIB originally used Earth gravitational constants while interpreting the Mars scenario. That made the broadcast orbits internally inconsistent with the simulation.

Changes made:

- `src/core/system_parameters/MATH_CONSTANTS.h`
  - Uses `PlanetaryParams::MU` for GPS, Galileo, GLONASS, and BeiDou under `GNSS_PLANETARY_CONTEXT_MARS`.
  - Adds a Mars relativistic constant for GPS/Galileo/BeiDou.
  - Keeps Earth ICD constants for the normal Earth build context.
- `src/algorithms/libs/rtklib/rtklib_ephemeris.cc`
  - Uses Mars GM under the Mars planetary context.
- `utils/scripts/spirent_gps_to_gnss_sdr_xml.py`
  - Converts Spirent `.gps` data into GNSS-SDR GPS ephemeris XML using Mars GM.

Result:

- The receiver can use simulator-derived Mars GPS ephemerides without Earth-orbit dynamics leaking into satellite propagation.

## Observables and Time-of-Week Bootstrapping

The Mars replay initially produced invalid or negative pseudorange behavior during startup. The observables block now applies a Mars-specific receive TOW initialization offset.

Change made:

- `src/algorithms/observables/gnuradio_blocks/hybrid_observables_gs.cc`
  - Under Mars, initializes the receive TOW offset as `TOW_ref + 100 ms`.

Result:

- Initial Mars pseudoranges stay positive and the receiver can progress to PVT instead of failing early on observables timing.

## Surface-Constrained 2D PVT

The scenario does not always provide enough decoded satellites for unconstrained 3D PVT. A Mars surface receiver at known height can be solved with three satellites by adding a fixed-height equation.

Changes made:

- `src/algorithms/PVT/adapters/rtklib_pvt.cc`
  - Adds `Single_2D`, `2D`, and `fixed_height_2d` configuration support.
  - Adds `fixed_height_2d_m`, `fixed_height_2d_sigma_m`, `initial_latitude_deg`, `initial_longitude_deg`, and `initial_height_m`.
  - Seeds RTKLIB with the configured initial Mars surface position.
  - Allows a Mars elevation mask down to -45 deg.
- `src/algorithms/libs/rtklib/rtklib.h`
  - Extends `prcopt_t` with fixed-height 2D fields.
- `src/algorithms/libs/rtklib/rtklib_rtksvr.h`
  - Updates `PRCOPT_DEFAULT`.
- `src/algorithms/libs/rtklib/rtklib_pntpos.cc`
  - Adds the fixed-height pseudo-observation row.
  - Allows 3-satellite fixed-height validation.
  - Adds a rough surface-constrained seed for the 3-observation case.
- `src/algorithms/PVT/libs/rtklib_solver.cc`
  - Lowers the minimum observation count to 3 when fixed-height 2D is enabled.
- `src/algorithms/PVT/gnuradio_blocks/rtklib_pvt_gs.cc`
  - Avoids PVT reset loops when a valid Mars 3-satellite fixed-height solution is expected.
- PVT unit tests were updated for the extended `prcopt_t` defaults and Mars NMEA formatting.

Result:

- The Mars replay can produce a fixed-height 2D PVT solution with three usable satellites.

## Telemetry Investigation

The investigation focused on PRNs 16 and 21, which acquired and tracked strongly but initially produced almost no valid LNAV words. The simulator NAV source was verified as good.

Evidence established:

- Earth scenario decodes correctly.
- Mars PRNs 16 and 21 acquire and track strongly.
- Simulator NAV truth passes the same parity algorithm used by GNSS-SDR.
- PRN16 reaches an exact 8/8 preamble match at simulator epoch 0:32:36, subframe 2.
- Preamble detection, bit sync, parity computation, channel indexing, dropped samples, and tracker-to-telemetry handoff were ruled out.
- The first wrong bits appear in the tracker prompt-sign stream itself after a valid preamble.
- PLL discriminator remains small and carrier phase is smooth.
- Fixed polarity, 1 bit shift, 1 ms shift, and 20 ms bit-boundary correction sweeps do not rescue the original decode.

Instrumentation added:

- `src/algorithms/acquisition/gnuradio_blocks/pcps_acquisition.cc`
  - Logs code phase, Doppler, and acquisition metric for diagnostic PRNs.
- `src/algorithms/channel/adapters/channel.cc`
  - Logs channel acquisition setup.
- `src/algorithms/tracking/gnuradio_blocks/dll_pll_veml_tracking.cc`
  - Logs prompt I/Q, prompt signs, bit candidates, carrier phase, PLL discriminator, accumulator state, emitted symbols, and post-preamble milliseconds.
- `src/algorithms/telemetry_decoder/gnuradio_blocks/gps_l1_ca_telemetry_decoder_gs.cc`
  - Logs telemetry input symbols, preamble candidates, recovered bits, expected-like diagnostic fields, word CRCs, and frame-sync loss.
- `utils/scripts/analyze_mars_l1ca_sync.py`
  - Provides an offline forensics path for prompt-sign, NAV-bit, and parity timeline comparisons.

All high-volume instrumentation is gated by `GNSS_SDR_MARS_SYNC_DEBUG` and focused on PRNs 2, 16, and 21.

## Telemetry Repair

The decoder now has an optional branch-repair path for Mars telemetry.

Changes made:

- `src/algorithms/telemetry_decoder/libs/tlm_conf.h`
- `src/algorithms/telemetry_decoder/libs/tlm_conf.cc`
  - Adds `TelemetryDecoder_1C.enable_costas_branch_repair`.
  - Default is `false`.
- `src/algorithms/telemetry_decoder/gnuradio_blocks/gps_l1_ca_telemetry_decoder_gs.cc`
  - Refactors subframe decode into reusable candidate assembly.
  - Preserves previous GPS word D29/D30 state until a full subframe passes parity.
  - If nominal parity fails and repair is enabled, tests compact periodic branch-slip masks.
  - Accepts a repair only when all 10 words in the 300-bit GPS LNAV subframe pass parity.
  - Leaves preamble bits untouched during repair so a false preamble cannot be manufactured by the repair path.

Debug evidence:

- PRNs 16 and 21 both produced parity-clean repaired subframes in debug runs.
- A recurring successful mask was `period=25`, `start=9`, `length=13`, with 156 flipped bits in a 300-bit window.
- This points to stable tracker-side Costas branch ambiguity rather than random bit decisions or telemetry logic failure.

## Tracking Dynamics Assessment

This is not high dynamics in the usual receiver-loop stress sense, despite high absolute satellite velocity in the Mars simulation.

Reasoning:

- The affected channels have strong CN0 and stable lock.
- The PLL discriminator stays small near the first divergence.
- Carrier phase appears smooth.
- Acquisition quality and Doppler search range are sufficient.
- The failure mode is a stable but wrong prompt-sign branch, not loss of tracking.

The configuration still keeps the Mars replay conservative:

- Wider Doppler acquisition search: `Acquisition_1C.doppler_max=15000`.
- 125 Hz Doppler step.
- 50 Hz PLL bandwidth.
- 10 Hz DLL bandwidth.
- 20-symbol extended coherent tracking.
- Long lock-fail limits to avoid premature channel recycle during Mars diagnostics.

## Web Visualization

Two static web UIs were added.

`tools/mars_receiver_ui/`:

- Loads the GNSS-SDR run log, NMEA file, and latest GeoJSON PVT output.
- Shows acquisition/tracking/PVT status, channel events, CN0, PVT trajectory, and a NMEA-only sky plot.
- The sky plot intentionally uses NMEA `GSV`/`GSA` data, not simulator truth.

`tools/mars_orbit_viewer/`:

- Visualizes Mars, Earth direction, the receiver, satellite positions/orbits, and the receiver PVT trajectory.
- Loads scenario data from `Scenario Data/`.
- Loads receiver output from `build/latest_pvt.geojson` and `build/gnss_sdr_pvt.nmea`.
- Uses vendored Three.js so it runs locally without a network dependency.

Run either app from the repository root with:

```sh
python3 -m http.server 8770 --bind 127.0.0.1
```

Then open:

```text
http://127.0.0.1:8770/tools/mars_receiver_ui/
http://127.0.0.1:8770/tools/mars_orbit_viewer/
```

## Validation Results

Build:

- `cmake --build build --target gnss-sdr -j2` completed successfully.
- The Mars build emits expected compile-time warnings indicating Mars constants are active.

UI checks:

- `node --check tools/mars_receiver_ui/app.js` passed.
- `node --check tools/mars_orbit_viewer/app.js` passed.
- The local HTTP server successfully served both UIs and their data dependencies.

Latest full Mars replay:

- Command used from `build/`:

```sh
./src/main/gnss-sdr --config_file=./gps_mars.conf > gnss_sdr_run_fixed.log 2>&1
```

- Runtime completed normally.
- Simulated duration: 3 minutes.
- Wall-clock processing time: 54.849191 s.
- PVT GeoJSON output: `build/PVT_260618_093638.geojson`.
- Latest PVT symlink: `build/latest_pvt.geojson`.
- PVT points: 159.
- NMEA file: `build/gnss_sdr_pvt.nmea`.
- NMEA sentence counts:
  - GGA: 159
  - GSA: 159
  - GSV: 214
- Last logged fix:
  - Time: 2026-Mar-02 00:32:20.500000 UTC
  - Observations: 3
  - Latitude: 0.005607 deg
  - Longitude: -0.014698 deg
  - Height: 0.00 m

Telemetry in the latest normal run:

- NAV messages were emitted for PRNs 02, 05, 12, 15, 21, and 22.
- PRN16 acquired, tracked, bit-locked, and restarted during the full normal run, but did not emit NAV in that run.
- PRN16 did emit parity-clean repaired subframes in prior debug runs, so the remaining issue is likely deterministic startup/channel timing sensitivity rather than the original parity failure.

## Known Limitations and Follow-Up

- The fixed-height 2D PVT now works, but the final horizontal estimate is still slightly offset from the intended 0 deg latitude and 0 deg longitude Mars-surface truth. That residual bias should be investigated separately using the simulator motion truth and satellite geometry.
- PRN16 is improved but not fully deterministic in the latest normal full replay. A focused follow-up should compare the debug and normal startup timing for PRN16.
- `TelemetryDecoder_1C.enable_costas_branch_repair` is intentionally opt-in. It is enabled in the Mars configs, but remains disabled by default for normal GNSS-SDR use.
- The repair is conservative because it requires all 10 LNAV words to pass parity. It is still a mitigation, not a complete tracker-side carrier branch fix.
- The raw IQ capture is not committed because of its size. The tracked config points to its expected local path.
- The debug instrumentation is behind `GNSS_SDR_MARS_SYNC_DEBUG`; future cleanup can reduce it once the tracker-side branch ambiguity is fixed directly.

## Practical Run Commands

Normal Mars replay from repository root:

```sh
./build/src/main/gnss-sdr --config_file=./conf/File_input/GPS/gnss-sdr_GPS_L1_CA_Mars_SPIR.conf
```

Telemetry diagnostic replay from repository root:

```sh
GNSS_SDR_MARS_SYNC_DEBUG=1 ./build/src/main/gnss-sdr --config_file=./conf/File_input/GPS/gnss-sdr_GPS_L1_CA_Mars_SPIR_tlm_debug.conf
```

Open the receiver UI and orbit viewer:

```sh
python3 -m http.server 8770 --bind 127.0.0.1
```

```text
http://127.0.0.1:8770/tools/mars_receiver_ui/
http://127.0.0.1:8770/tools/mars_orbit_viewer/
```
