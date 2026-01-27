# GNSS-SDR-MARS

**GNSS-SDR-MARS** is a research fork of [GNSS-SDR](https://github.com/gnss-sdr/gnss-sdr) that adapts the receiver architecture to operate with a **Mars-centered, Mars-fixed (MCMF)** planetary navigation system transmitting **GPS L1 C/A signals with LNAV navigation messages**.

The project follows a **minimal-modification philosophy**:
- Preserve the **GPS L1 C/A signal structure** and **IS-GPS-200 LNAV framing**
- Regenerate and reinterpret **navigation data** (time, ephemeris, clock) using **Mars physical constants**
- Disable **Earth-specific models and assumptions**
- Replace Earth reference frames with **Mars-centered equivalents**

This repository is intended for **research, experimentation, and validation** of Mars PNT concepts.  
It is **not an operational navigation system**.

---

## Status

- [x] Definition of Mars–GPS conceptual mapping for LNAV content
- [ ] Stable acquisition and tracking under Mars constellation dynamics
- [ ] Robust LNAV decoding with Mars-based ephemeris and clock parameters
- [ ] Consistent PVT solution in Mars-centered reference frames
- [ ] Quantitative PVT error analysis against reference trajectories

---

## Core Design Principles

### 1) GPS LNAV Reuse with Mars Semantics

The receiver maintains full compliance with the **GPS L1 C/A and LNAV message structure**:
- 50 bps data rate
- Standard TLM/HOW words and subframe structure
- GPS parity and preamble

However, the **semantic meaning** of navigation message fields is adapted for Mars:
- Ephemeris and clock parameters are derived from **Mars orbits and Mars time**
- Earth-only parameters (ionosphere, UTC conversion, leap seconds) are disabled or ignored
- Scaling, bit allocation, and word layout remain unchanged to minimize receiver redesign

This approach allows reuse of the mature GNSS-SDR signal-processing chain while exploring non-terrestrial PNT concepts.

---

## Differences from Upstream GNSS-SDR

### A. Planetary Constants and Reference Frames

GNSS-SDR-MARS removes implicit Earth assumptions and replaces them with Mars equivalents:

- Earth gravitational parameter → **Mars gravitational parameter**
- Earth rotation rate → **Mars rotation rate**
- WGS-84 ellipsoid → **Mars reference ellipsoid**
- ECEF / ITRF → **MCMF (Mars-Centered, Mars-Fixed)**

These changes affect:
- Satellite ephemeris interpretation
- Inertial-to-fixed frame transformations
- Coordinate conversion utilities
- PVT representation and logging

---

### B. Atmospheric and Propagation Models

Earth atmospheric corrections are not applicable:

- Ionospheric models are disabled
- Tropospheric models are disabled
- Single-frequency L1 operation is assumed

The measurement and tracking architecture remains otherwise unchanged.

---

### C. Time System Adaptation

GNSS-SDR-MARS introduces a **Mars GNSS time concept**:

- Retains LNAV Z-count and week structure
- Interprets them as **Mars time-of-week and Mars week number**
- Removes dependencies on Earth UTC, leap seconds, and GPS–UTC parameters

This allows existing LNAV decoding logic to remain intact while changing the underlying time semantics.

---

### D. Navigation Message Content Policy

The LNAV message layout remains IS-GPS-200 compliant, but content is Mars-derived:

| LNAV Element | Policy in GNSS-SDR-MARS |
|--------------|-------------------------|
| Ephemeris (SF2–SF3) | Mars orbits, same field layout |
| Clock parameters (SF1) | Mars-referenced clock model |
| Ionosphere (SF4) | Set to zero / ignored |
| UTC parameters | Disabled |
| TGD | Set to zero |

---

## Receiver Outputs

The receiver produces:

- Satellite tracking and navigation status
- Decoded LNAV navigation data
- PVT solutions expressed in:
  - **Mars-Centered Cartesian coordinates (MCMF)**
  - Optional Mars geodetic coordinates (latitude, longitude, height) using a Mars ellipsoid

---

## Repository Scope

GNSS-SDR-MARS focuses on **receiver-side adaptations**:

- Signal processing remains GPS L1 C/A compliant
- Navigation and PVT logic is modified for Mars physics
- Constellation design and signal generation are considered external inputs

---

## Suggested Validation Path

1. Demonstrate stable acquisition and tracking
2. Verify correct LNAV subframe decoding
3. Validate ephemeris and clock interpretation
4. Produce stable PVT solutions in MCMF
5. Evaluate PVT error statistics against known references

---

## Roadmap

- [X] Centralized Mars constants module
- [ ] Documentation of LNAV field reinterpretation
- [ ] MCMF frame and transformation utilities
- [ ] Mars-compatible geodetic conversion functions

---

## How to Compile for Mars

To compile the application with Mars parameters, use the following command when configuring your build:

```bash
cmake -DENABLE_MARS=ON ..
```

To switch back to Earth (default):

```bash
cmake -DENABLE_MARS=OFF ..
# or simply
cmake ..
```

---

## Contributions

Contributions are welcome, particularly in:
- Planetary reference frames
- Navigation filter adaptations
- Validation and test infrastructure
- Documentation and conceptual clarity

Please open an issue before submitting major changes.

---

## License

This repository follows the licensing terms of **GNSS-SDR** for upstream components.  
Refer to the `LICENSE` file and upstream documentation for details.

---

## Acknowledgements

- GNSS-SDR open-source project
- GPS L1 C/A and LNAV specifications (IS-GPS-200)
- Planetary geodesy and Mars reference frame literature
