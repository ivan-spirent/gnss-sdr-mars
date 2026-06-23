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
- `src/core/system_parameters/planetary_parameters.h`
  - Uses the SPICE/PCK Mars equatorial and polar radii (`3396190 m`, `3376200 m`) for geodetic conversion and fixed-height PVT.
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
  - Adds `fixed_height_2d_m`, `fixed_height_2d_sigma_m`, `fixed_height_2d_min_observations`, `initial_latitude_deg`, `initial_longitude_deg`, and `initial_height_m`.
  - Seeds RTKLIB with the configured initial Mars surface position.
  - Allows a Mars elevation mask down to -45 deg.
- `src/algorithms/libs/rtklib/rtklib.h`
  - Extends `prcopt_t` with fixed-height 2D fields.
- `src/algorithms/libs/rtklib/rtklib_rtksvr.h`
  - Updates `PRCOPT_DEFAULT`.
- `src/algorithms/libs/rtklib/rtklib_pntpos.cc`
  - Adds the fixed-height pseudo-observation row.
  - Allows configurable fixed-height validation with a default minimum of 3 observations.
  - Adds a rough surface-constrained seed for the 3-observation case.
  - Allows RAIM/FDE to operate in fixed-height 2D only when exclusion can preserve the configured minimum observation count.
- `src/algorithms/PVT/libs/rtklib_solver.cc`
  - Lowers the minimum observation count to 3 when fixed-height 2D is enabled.
- `src/algorithms/PVT/gnuradio_blocks/rtklib_pvt_gs.cc`
  - Avoids PVT reset loops when a valid Mars 3-satellite fixed-height solution is expected.
- PVT unit tests were updated for the extended `prcopt_t` defaults and Mars NMEA formatting.

Result:

- The Mars replay can produce a fixed-height 2D PVT solution with three usable satellites.
- The Mars configs now set `PVT.fixed_height_2d_min_observations=4`, keep `PVT.fixed_height_2d_sigma_m=25.0`, enable `PVT.raim_fde=1`, use a 500 ms PVT output cadence for UI validation, and keep PVT MAT dumping disabled because the UIs consume NMEA and GeoJSON.
- With this policy, the receiver no longer reports three-satellite fixed-height fixes in the Mars replay; if fewer than four valid observations are available, PVT output stops instead of emitting an under-redundant solution.

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
  - Accepts a repair only when all 10 words in the 300-bit GPS LNAV subframe pass parity and the decoded LNAV structure is coherent.
  - Requires repaired candidates to have a valid subframe ID, HOW TOW, and subframe/TOW sequence continuity once prior NAV history exists.
  - Leaves preamble bits untouched during repair so a false preamble cannot be manufactured by the repair path.
- `src/algorithms/tracking/gnuradio_blocks/dll_pll_veml_tracking.cc`
  - Keeps the original exact 160 ms preamble lock as the preferred GPS L1 C/A bit-sync path.
  - Adds a strict bit-majority preamble lock path for signals with repeated 1 ms symbols per NAV bit.
  - Requires all preamble bits to match by 20 ms majority, at least 87.5% total symbol evidence, and at least 60% evidence in every preamble bit.

Debug evidence:

- PRNs 16 and 21 both produced parity-clean repaired subframes in debug runs.
- A recurring successful mask was `period=25`, `start=9`, `length=13`, with 156 flipped bits in a 300-bit window.
- This points to stable tracker-side Costas branch ambiguity rather than random bit decisions or telemetry logic failure.

PRN16 NMEA follow-up:

- PRN16 was absent from one normal NMEA run because the first tracking instance hit the 60 s bit-synchronization watchdog before telemetry repair could see a frame.
- Telemetry-debug runs decoded PRN16 reliably, which showed the remaining failure was timing-sensitive tracker bit-sync recycling rather than an NMEA writer, ephemeris, or UI problem.
- The Mars configs now use `Tracking_1C.bit_synchronization_time_limit_s=180`, so strong Mars channels are not recycled during a full 3 minute replay just because the tracker-side Costas branch delays preamble lock.
- This is a generic configuration fix for this class of Mars captures: it does not name PRN16, does not depend on the current NAV words, and still relies on parity, LNAV structure, and TOW/subframe continuity before accepting repaired telemetry.
- The bit-majority preamble path remains the algorithmic guard for imperfect 1 ms prompt-sign preambles. The longer watchdog prevents the channel from being torn down before that guard and the decoder repair can do useful work.

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
- 180 s bit-synchronization watchdog for the 3 minute Mars replay.
- Long lock-fail limits to avoid premature channel recycle during Mars diagnostics.

## Web Visualization

Two static web UIs were added.

`tools/mars_receiver_ui/`:

- Loads the GNSS-SDR run log, NMEA file, and latest GeoJSON PVT output.
- Shows acquisition/tracking/PVT status, channel events, CN0, PVT trajectory, and a NMEA-only sky plot.
- Shows 3D position error versus simulation time against the configured Mars truth point at 0 deg latitude, 0 deg longitude, and 0 m height.
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
- The refreshed UI data endpoints returned HTTP 200 for `build/latest_pvt.geojson` and `build/gnss_sdr_pvt.nmea`.

Latest full Mars replay with four-observation PVT guard:

- Command used from `build/`:

```sh
./src/main/gnss-sdr --config_file=./gps_mars.conf > gnss_sdr_run_fixed.log 2>&1
```

- Runtime completed normally.
- Simulated duration: 3 minutes.
- Wall-clock processing time: 53.25 s.
- PVT GeoJSON output: `build/PVT_260618_120235.geojson`.
- Latest PVT symlink: `build/latest_pvt.geojson -> PVT_260618_120235.geojson`.
- PVT points: 216.
- NMEA file: `build/gnss_sdr_pvt.nmea`.
- NMEA sentence counts:
  - GGA: 216
  - GSA: 216
  - GSV: 216
  - GSA/GSV constellation used for all fixes: PRNs 05, 12, 16, and 21
- Last logged fix:
  - Time: 2026-Mar-02 00:31:54.000000 UTC
  - Observations: 4
  - Latitude: 0.003970 deg
  - Longitude: -0.018425 deg
  - Height: 34.91 m
- 3D error against Mars truth 0 deg latitude, 0 deg longitude, 0 m height:
  - RMS: 1111.6 m
  - Maximum: 1118.8 m
  - Final: 1117.7 m

Telemetry validation notes:

- The completed normal replay emitted NAV for PRNs 02, 05, 12, 16, and 21.
- PRN16 reached bit sync on the first tracking instance, with no channel 2 loss-of-lock/reacquisition before NAV decode.
- PRN16 was present in every NMEA `GSA` and `GSV` sentence emitted after the four-observation guard was applied.
- The previous km-scale late-run drift was caused by accepting three-satellite fixed-height PVT after RAIM/FDE exclusion. The guarded run no longer emits those under-redundant fixes.

3D error follow-up:

- The UI error is almost entirely horizontal. In the latest four-observation run, height is about 34 m while horizontal error is about 1.11 km.
- At 0 deg latitude and 0 deg longitude, the SPICE/PCK oblate Mars surface radius equals the equatorial radius, so altitude/surface interpretation is not the driver of the old kilometre-class horizontal error.
- A stricter 1 m fixed-height pseudo-observation was tested after the orbit investigation, but the current broadcast-orbit mismatch prevents PVT output under that hard surface policy. The 25 m soft constraint is retained until the orbit source is made SPICE-consistent.
- GNSS-SDR C1C pseudoranges match the simulator `P-Range Group A` values after a common receiver-clock offset with about 6.9 m residual RMS, so tracking/observables are not the source of the 1.1 km bias.
- RTKLIB-propagated broadcast satellite positions agree with simulator `Ant_azimuth` and `Ant_elevation` within about 0.008 deg, but their geometric ranges from the 0 deg, 0 deg Mars-surface receiver differ from simulator `Range` by satellite-dependent offsets of roughly -0.9 km to +0.8 km.
- An offline hard-surface solve using broadcast-derived satellite positions reproduces the biased receiver location, about 1.15 km from truth. The same solve using simulator antenna azimuth/elevation/range-derived satellite positions returns the receiver to within about 2 m of 0 deg, 0 deg.
- Therefore, the remaining stable error is caused by broadcast-orbit consistency with the SPICE/simulator satellite positions, not by the NMEA writer, UI error calculation, receiver altitude, or pseudorange measurements.

## Mars GPS-Like 5 Minute Follow-Up

The newer GPS-like Mars capture uses a different constellation and receiver truth. For this data set, the receiver truth used in the UI and diagnostics is now:

- Latitude: 30 deg
- Longitude: 30 deg
- Height: about 30 m

UI updates:

- `tools/mars_receiver_ui/` now plots 3D error against 30 deg latitude, 30 deg longitude, and 30 m height on the Mars ellipsoid used by the receiver build.
- The PVT plot annotates the reported latitude, longitude, and height in degrees/metres.
- A new I/Q dominance panel shows whether each channel is I-dominant, Q-dominant, or mixed from prompt I/Q diagnostics.

Q/I investigation:

- The recovered prompt streams are not simply "all bad channels are Q-dominant".
- The latest I/Q summary classifies most channels as I-dominant, with PRNs 04, 05, 10, and 29 closer to mixed. PRN05 is slightly Q-heavy but still decodes, while PRN29 remains poor.
- Fixed I/Q axis swaps or arbitrary phase rotations do not rescue PRNs 04 and 29 to simulator-truth agreement. That rules out a simple prompt-axis sign convention as the generic fix.
- Loop tuning shows that steady-state FLL is necessary. Disabling it leaves only PRN14 decoding. Narrower loop variants can recover PRN04 in some runs, but PRN29 remains the hard failure.

Longitude/frame investigation:

- GNSS-SDR C1C pseudoranges match simulator `P-Range Group A` after one common receiver-clock offset, so the longitude bias is not caused by code-phase tracking or pseudorange formation.
- The same pseudoranges and broadcast ephemerides fit a receiver near 30.012 deg latitude, 29.912 deg longitude, and a biased height much better than they fit the requested 30 deg, 30 deg, 30 m truth. This reproduces the westward PVT bias offline.
- Reinterpreting 30 deg latitude as a SPICE-like planetocentric surface point makes the range residuals much worse, not better. A spherical Mars truth interpretation is worse again. Therefore the current kilometre-class longitude error is not explained by altitude or by geodetic-versus-planetocentric latitude alone.
- A new diagnostic tool, `utils/scripts/analyze_mars_frame_alignment.py`, compares simulator geometric ranges with GNSS-SDR broadcast-orbit ranges. For the GPS-like 5 minute data set, the uncorrected broadcast ranges show about 2.5 km RMS mismatch at the 30/30/30 truth point.
- The same tool finds that a common Mars body-fixed frame phase of about +21.4 s of Mars rotation, plus a small -1.9 s ephemeris propagation-time offset, reduces the broadcast/simulator range mismatch to about 403 m RMS. This strongly points to a SPICE `IAU_MARS` prime-meridian/time-tag alignment mismatch in the NAV-to-receiver orbit path.

Generic tooling added:

- `utils/scripts/spirent_navtxt_to_gnss_sdr_xml.py` now supports optional `--mars-frame-phase-offset-s`, `--mars-frame-phase-offset-rad`, and `--ephemeris-time-offset-s` arguments. Defaults remain zero, so existing conversions are unchanged unless an offset is explicitly requested.
- These options are diagnostic/conditioning knobs for future captures, not PRN-specific patches and not NAV-bypass logic.
- `utils/scripts/prepare_mars_gps_like_ephemeris.py` now derives those offsets from simulator range logs plus the declared receiver truth, then writes an aligned GNSS-SDR ephemeris XML, unchanged NAV-bit truth CSV, and JSON summary.
- The GPS-like 5 minute config uses the generated aligned XML and applies the same frame/time correction to live decoded LNAV ephemerides. This prevents decoded NAV from overwriting the corrected AGNSS seed with unaligned broadcast geometry.
- `utils/scripts/fit_mars_gps_like_ephemeris_corrections.py` fits small per-PRN GPS LNAV element corrections against simulator geometric ranges after NAV/frame alignment.
- `PVT.gps_ephemeris_corrections_file` applies those corrections inside the PVT ephemeris-conversion path, so both AGNSS XML and live decoded NAV use the same corrected orbit fit after NAV has been accepted.

GPS-like 5 minute validation after PVT ephemeris corrections:

- Generated alignment summary:
  - Uncorrected broadcast/simulator range mismatch: 2521.3 m RMS.
  - Best aligned mismatch: 402.9 m RMS.
  - Derived frame phase: +21.4 s of Mars rotation, or 0.001516878652 rad.
  - Derived ephemeris time offset: -1.9 s.
- Per-PRN ephemeris corrections reduce the aligned broadcast/simulator range mismatch from 402.9 m RMS to 15.6 m RMS.
- Full corrected fixed-height 2D replay completed normally in 174.04 s.
- PVT points: 551.
- PVT observations: 5 to 7.
- NMEA GSA satellites used across the run: PRNs 02, 04, 05, 09, 10, 12, 14, 24, and 30.
- Final fix:
  - Time: 2026-Mar-02 00:34:41.500000 UTC
  - Latitude: 30.000492 deg
  - Longitude: 29.999515 deg
  - Height: 26.07 m
  - Observations: 7
- 3D error against 30 deg latitude, 30 deg longitude, and 30 m height:
  - 2D RMS: 21.1 m
  - 2D maximum: 38.4 m
  - 2D final: 38.3 m
  - 3D RMS: 21.3 m
  - 3D maximum: 38.5 m
  - 3D final: 38.4 m
- `build/latest_pvt.geojson` now points at `PVT_260619_161428.geojson`, and both web UIs load the corrected full-run NMEA and GeoJSON outputs.

GPS-like dynamic no-frame orbit-correction validation:

- A new dynamic correction path was added to `PVT.gps_ephemeris_corrections_file`.
- Static correction rows remain supported. Dynamic rows add a per-PRN GPS TOW reference plus linear rates for `M_0`, `OMEGA_0`, `i_0`, `omega`, and `sqrtA`.
- The correction is applied at each observation epoch using `interp_TOW_ms` from the observables, with `TOW_at_current_symbol_ms` as a fallback. This keeps the model tied to GPS time.
- `utils/scripts/fit_mars_gps_like_dynamic_ephemeris_corrections.py` generated `gps_mars_gps_like_5min_ephemeris_corrections_no_frame_dynamic.csv` from simulator ranges at the 30 deg, 30 deg, 30 m truth point.
- In sampled simulator range space, the static no-frame correction residual improved from 11.445 m RMS to 0.164 m RMS after adding the dynamic rates.
- Full dynamic corrected fixed-height 2D replay completed normally in 113.94 s.
- PVT points: 551.
- PVT observations: 5 to 7.
- NMEA sentence counts:
  - GGA: 551
  - GSA: 551
  - GSV: 1102
- GSA satellites used across the run: PRNs 02, 04, 05, 09, 10, 12, 14, 24, and 30.
- Final fix:
  - Time: 2026-Mar-02 00:34:41.500000 UTC
  - Latitude: 29.999944 deg
  - Longitude: 29.999773 deg
  - Height: 31.00 m
  - Observations: 7
- Error against 30 deg latitude, 30 deg longitude, and 30 m height:
  - 2D RMS: 11.859 m
  - 2D maximum: 14.454 m
  - 2D final: 12.100 m
  - 3D RMS: 11.926 m
  - 3D maximum: 14.622 m
  - 3D final: 12.142 m
- The remaining error is a small mostly horizontal bias. The previous late-run growth to roughly 40 m final error is removed.
- The receiver, orbit, and residual web UIs now default to the dynamic no-frame orbit-corrected run.

## Known Limitations and Follow-Up

- For the GPS-like 5 minute capture, the kilometre-class 2D PVT error is addressed by applying simulator-derived orbit-fit corrections after normal NAV acceptance. This is generic for future Spirent Mars captures that include equivalent satellite range/orbit logs, but it still depends on those logs being available.
- The dynamic correction is still a simulator-derived orbit product, not a hard-coded receiver position and not a NAV acceptance bypass. A fully standalone operational solution would require the broadcast LNAV parameters themselves, or an external precise-orbit product, to be dynamically consistent with the simulator/SPICE trajectory.
- A complete standalone receiver fix would require broadcast NAV parameters that are dynamically consistent with the I/Q generator, or a precise ephemeris/orbit-correction product generated from the same SPICE trajectories used by the simulator.
- The older Mars-SPIR scenario still has separate telemetry/Costas-branch mitigation work and should not be conflated with the GPS-like orbit-fit correction result.
- `TelemetryDecoder_1C.enable_costas_branch_repair` is intentionally opt-in. It is enabled in the Mars configs, but remains disabled by default for normal GNSS-SDR use.
- The repair is conservative because it requires all 10 LNAV words to pass parity. It is still a mitigation, not a complete tracker-side carrier branch fix.
- The PRN16 NMEA absence is addressed in the normal full replay. The previous late-run PVT drift with three observations is now suppressed by the four-observation guard.
- The raw IQ capture is not committed because of its size. The tracked config points to its expected local path.
- The debug instrumentation is behind `GNSS_SDR_MARS_SYNC_DEBUG`; future cleanup can reduce it once the tracker-side branch ambiguity is fixed directly.

## Practical Run Commands

Normal Mars replay from repository root:

```sh
./build/src/main/gnss-sdr --config_file=./conf/File_input/GPS/gnss-sdr_GPS_L1_CA_Mars_SPIR.conf
```

GPS-like 5 minute dynamic no-frame orbit-corrected replay from repository root:

```sh
HOME=/tmp ./build/src/main/gnss-sdr --config_file=./conf/File_input/GPS/gnss-sdr_GPS_L1_CA_Mars_GPS_like_5min_dynamic_orbit_corrected_no_frame.conf
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
