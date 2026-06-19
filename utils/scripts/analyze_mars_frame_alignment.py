#!/usr/bin/env python3
"""Estimate a common Mars frame/time offset from simulator ranges.

This is a diagnostic tool for Spirent Mars GPS-like scenarios. It compares
GNSS-SDR broadcast ephemeris ranges against simulator geometric ranges at a
known Mars receiver truth position.
"""

import argparse
import csv
import math
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path


MARS_MU = 4.282837e13
MARS_ROTATION_RATE_RAD_S = 7.088218e-5
MARS_A = 3396190.0
MARS_B = 3376200.0
MARS_F = (MARS_A - MARS_B) / MARS_A


def parse_float(text, default=None):
    try:
        return float(text)
    except (TypeError, ValueError):
        return default


def parse_int(text, default=None):
    try:
        return int(float(text))
    except (TypeError, ValueError):
        return default


def normalize_angle(angle):
    return (angle + math.pi) % (2.0 * math.pi) - math.pi


def timediff_week_crossover(time_s, toe_s):
    dt = time_s - toe_s
    if dt > 302400.0:
        dt -= 604800.0
    elif dt < -302400.0:
        dt += 604800.0
    return dt


def load_ephemerides(path):
    tree = ET.parse(path)
    ephemerides = {}
    for item in tree.findall(".//GNSS-SDR_ephemeris_map/item"):
        first = item.find("first")
        second = item.find("second")
        if first is None or second is None:
            continue
        prn = parse_int(first.text)
        if prn is None:
            continue
        fields = {}
        for child in second:
            value = parse_float(child.text)
            if value is not None:
                fields[child.tag] = value
        required = {
            "M_0",
            "delta_n",
            "ecc",
            "sqrtA",
            "OMEGA_0",
            "i_0",
            "omega",
            "OMEGAdot",
            "idot",
            "toe",
        }
        if required.issubset(fields):
            ephemerides[prn] = fields
    return ephemerides


def load_sat_ranges(path, range_field, prns=None):
    rows = []
    with path.open(newline="", errors="replace") as stream:
        for _ in range(4):
            next(stream, None)
        reader = csv.DictReader(stream)
        for row in reader:
            prn = parse_int(row.get("Sat_PRN"))
            tow_ms = parse_int(row.get("TOW_ms"))
            if prn is None or tow_ms is None:
                continue
            if prns is not None and prn not in prns:
                continue
            signal_db = parse_float(row.get("Signal_dB Group A"), 0.0)
            if signal_db <= 0.0:
                continue
            range_m = parse_float(row.get(range_field))
            if range_m is None:
                continue
            rows.append({"tow_ms": tow_ms, "prn": prn, "range_m": range_m})
    return rows


def choose_epochs(rows, max_epochs):
    by_tow = defaultdict(list)
    for row in rows:
        by_tow[row["tow_ms"]].append(row)
    epochs = sorted(by_tow)
    if max_epochs <= 0 or len(epochs) <= max_epochs:
        chosen = epochs
    else:
        chosen = []
        last_index = len(epochs) - 1
        for index in range(max_epochs):
            chosen.append(epochs[round(index * last_index / (max_epochs - 1))])
        chosen = sorted(set(chosen))
    selected = []
    for tow in chosen:
        selected.extend(by_tow[tow])
    return selected


def mars_geodetic_to_ecef(lat_deg, lon_deg, height_m):
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    e2 = MARS_F * (2.0 - MARS_F)
    sin_lat = math.sin(lat)
    cos_lat = math.cos(lat)
    n = MARS_A / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
    return (
        (n + height_m) * cos_lat * math.cos(lon),
        (n + height_m) * cos_lat * math.sin(lon),
        (n * (1.0 - e2) + height_m) * sin_lat,
    )


def mars_planetocentric_surface_to_ecef(lat_deg, lon_deg, height_m):
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    ux = math.cos(lat) * math.cos(lon)
    uy = math.cos(lat) * math.sin(lon)
    uz = math.sin(lat)
    surface_radius = 1.0 / math.sqrt(((ux * ux + uy * uy) / (MARS_A * MARS_A)) + ((uz * uz) / (MARS_B * MARS_B)))
    radius = surface_radius + height_m
    return (radius * ux, radius * uy, radius * uz)


def mars_spherical_to_ecef(lat_deg, lon_deg, height_m, radius_m):
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    radius = radius_m + height_m
    return (
        radius * math.cos(lat) * math.cos(lon),
        radius * math.cos(lat) * math.sin(lon),
        radius * math.sin(lat),
    )


def truth_to_ecef(args):
    if args.truth_coordinate_type == "geodetic":
        return mars_geodetic_to_ecef(args.truth_lat_deg, args.truth_lon_deg, args.truth_height_m)
    if args.truth_coordinate_type == "planetocentric_surface":
        return mars_planetocentric_surface_to_ecef(args.truth_lat_deg, args.truth_lon_deg, args.truth_height_m)
    return mars_spherical_to_ecef(args.truth_lat_deg, args.truth_lon_deg, args.truth_height_m, args.truth_sphere_radius_m)


def satellite_position(eph, time_s, frame_phase_rad, ephemeris_time_offset_s):
    a = eph["sqrtA"] ** 2
    mean_motion = math.sqrt(MARS_MU / (a ** 3)) + eph["delta_n"]
    m0 = eph["M_0"] + mean_motion * ephemeris_time_offset_s
    omega0 = (
        eph["OMEGA_0"] +
        frame_phase_rad +
        (eph["OMEGAdot"] - MARS_ROTATION_RATE_RAD_S) * ephemeris_time_offset_s
    )
    i0 = eph["i_0"] + eph["idot"] * ephemeris_time_offset_s
    tk = timediff_week_crossover(time_s, eph["toe"])

    mean_anomaly = normalize_angle(m0 + mean_motion * tk)
    ecc = eph["ecc"]
    eccentric_anomaly = mean_anomaly
    for _ in range(30):
        delta = (eccentric_anomaly - ecc * math.sin(eccentric_anomaly) - mean_anomaly) / (
            1.0 - ecc * math.cos(eccentric_anomaly)
        )
        eccentric_anomaly -= delta
        if abs(delta) < 1.0e-13:
            break

    sin_e = math.sin(eccentric_anomaly)
    cos_e = math.cos(eccentric_anomaly)
    argument_lat = math.atan2(math.sqrt(1.0 - ecc * ecc) * sin_e, cos_e - ecc) + eph["omega"]
    radius = a * (1.0 - ecc * cos_e)
    inclination = i0 + eph["idot"] * tk

    sin2u = math.sin(2.0 * argument_lat)
    cos2u = math.cos(2.0 * argument_lat)
    argument_lat += eph.get("Cus", 0.0) * sin2u + eph.get("Cuc", 0.0) * cos2u
    radius += eph.get("Crs", 0.0) * sin2u + eph.get("Crc", 0.0) * cos2u
    inclination += eph.get("Cis", 0.0) * sin2u + eph.get("Cic", 0.0) * cos2u

    x_orb = radius * math.cos(argument_lat)
    y_orb = radius * math.sin(argument_lat)
    node = omega0 + (eph["OMEGAdot"] - MARS_ROTATION_RATE_RAD_S) * tk - MARS_ROTATION_RATE_RAD_S * eph["toe"]
    cos_node = math.cos(node)
    sin_node = math.sin(node)
    cos_i = math.cos(inclination)
    return (
        x_orb * cos_node - y_orb * cos_i * sin_node,
        x_orb * sin_node + y_orb * cos_i * cos_node,
        y_orb * math.sin(inclination),
    )


def rms_for_offsets(rows, ephemerides, receiver_ecef, frame_phase_s, ephemeris_time_offset_s):
    frame_phase_rad = frame_phase_s * MARS_ROTATION_RATE_RAD_S
    residuals = []
    rx, ry, rz = receiver_ecef
    for row in rows:
        eph = ephemerides.get(row["prn"])
        if eph is None:
            continue
        sx, sy, sz = satellite_position(
            eph,
            row["tow_ms"] / 1000.0,
            frame_phase_rad,
            ephemeris_time_offset_s,
        )
        predicted = math.sqrt((sx - rx) ** 2 + (sy - ry) ** 2 + (sz - rz) ** 2)
        residuals.append(predicted - row["range_m"])
    if not residuals:
        return float("inf"), 0, float("nan")
    rms = math.sqrt(sum(value * value for value in residuals) / len(residuals))
    mean = sum(residuals) / len(residuals)
    return rms, len(residuals), mean


def float_range(start, stop, step):
    value = start
    limit = stop + step * 0.5
    while value <= limit:
        yield value
        value += step


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("sat_data", type=Path)
    parser.add_argument("ephemeris_xml", type=Path)
    parser.add_argument("--truth-lat-deg", type=float, required=True)
    parser.add_argument("--truth-lon-deg", type=float, required=True)
    parser.add_argument("--truth-height-m", type=float, required=True)
    parser.add_argument(
        "--truth-coordinate-type",
        choices=["geodetic", "planetocentric_surface", "spherical"],
        default="geodetic",
        help=(
            "How to interpret the truth latitude/longitude/height. "
            "planetocentric_surface intersects the IAU Mars ellipsoid along a center-out radial line."
        ),
    )
    parser.add_argument(
        "--truth-sphere-radius-m",
        type=float,
        default=MARS_A,
        help="Radius used only when --truth-coordinate-type=spherical. Default: Mars equatorial radius.",
    )
    parser.add_argument("--range-field", default="Range")
    parser.add_argument("--prns", default="")
    parser.add_argument("--max-epochs", type=int, default=40)
    parser.add_argument("--phase-min-s", type=float, default=-30.0)
    parser.add_argument("--phase-max-s", type=float, default=30.0)
    parser.add_argument("--phase-step-s", type=float, default=0.5)
    parser.add_argument("--dt-min-s", type=float, default=-5.0)
    parser.add_argument("--dt-max-s", type=float, default=5.0)
    parser.add_argument("--dt-step-s", type=float, default=0.5)
    args = parser.parse_args()

    prns = None
    if args.prns:
        prns = {int(item.strip()) for item in args.prns.split(",") if item.strip()}

    ephemerides = load_ephemerides(args.ephemeris_xml)
    rows = load_sat_ranges(args.sat_data, args.range_field, prns=prns)
    rows = [row for row in rows if row["prn"] in ephemerides]
    rows = choose_epochs(rows, args.max_epochs)
    receiver_ecef = truth_to_ecef(args)

    base_rms, base_n, base_mean = rms_for_offsets(rows, ephemerides, receiver_ecef, 0.0, 0.0)
    best = {"rms": base_rms, "n": base_n, "mean": base_mean, "phase_s": 0.0, "dt_s": 0.0}

    for phase_s in float_range(args.phase_min_s, args.phase_max_s, args.phase_step_s):
        for dt_s in float_range(args.dt_min_s, args.dt_max_s, args.dt_step_s):
            rms, n, mean = rms_for_offsets(rows, ephemerides, receiver_ecef, phase_s, dt_s)
            if rms < best["rms"]:
                best = {"rms": rms, "n": n, "mean": mean, "phase_s": phase_s, "dt_s": dt_s}

    print(f"Rows used: {base_n}")
    print(
        "Truth: "
        f"{args.truth_coordinate_type} lat={args.truth_lat_deg:.8f} deg, "
        f"lon={args.truth_lon_deg:.8f} deg, h={args.truth_height_m:.3f} m"
    )
    print(f"Base RMS: {base_rms:.3f} m, mean residual: {base_mean:.3f} m")
    print(
        "Best RMS: "
        f"{best['rms']:.3f} m, mean residual: {best['mean']:.3f} m, "
        f"phase_s: {best['phase_s']:.6f}, "
        f"phase_rad: {best['phase_s'] * MARS_ROTATION_RATE_RAD_S:.17e}, "
        f"phase_deg: {math.degrees(best['phase_s'] * MARS_ROTATION_RATE_RAD_S):.8f}, "
        f"dt_s: {best['dt_s']:.6f}"
    )


if __name__ == "__main__":
    main()
