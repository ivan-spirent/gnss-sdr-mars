#!/usr/bin/env python3
"""Fit small GPS LNAV ephemeris corrections against Mars simulator ranges.

The output CSV is consumed by PVT.gps_ephemeris_corrections_file. It does not
accept NAV data or bypass parity; it only compensates broadcast-orbit fit error
after a satellite has valid ephemeris.
"""

import argparse
import copy
import math
import statistics
from pathlib import Path
from types import SimpleNamespace

from analyze_mars_frame_alignment import (
    choose_epochs,
    load_ephemerides,
    load_sat_ranges,
    satellite_position,
    truth_to_ecef,
)


FIELDS = (
    ("delta_m0_rad", "M_0"),
    ("delta_omega0_rad", "OMEGA_0"),
    ("delta_i0_rad", "i_0"),
    ("delta_omega_rad", "omega"),
    ("delta_sqrtA", "sqrtA"),
)


def parse_prns(text):
    if not text:
        return None
    return {int(item.strip()) for item in text.split(",") if item.strip()}


def corrected_ephemeris(ephemeris, correction):
    result = copy.copy(ephemeris)
    for correction_key, eph_key in FIELDS:
        result[eph_key] += correction.get(correction_key, 0.0)
    return result


def residuals_for_prn(rows, ephemerides, receiver_ecef, prn, correction):
    ephemeris = corrected_ephemeris(ephemerides[prn], correction)
    residuals = []
    rx, ry, rz = receiver_ecef
    for row in rows:
        if row["prn"] != prn:
            continue
        sx, sy, sz = satellite_position(ephemeris, row["tow_ms"] / 1000.0, 0.0, 0.0)
        residuals.append(math.sqrt((sx - rx) ** 2 + (sy - ry) ** 2 + (sz - rz) ** 2) - row["range_m"])
    return residuals


def rms(values):
    if not values:
        return float("inf")
    return math.sqrt(statistics.mean(value * value for value in values))


def golden_section_minimize(func, low, high, iterations):
    ratio = (math.sqrt(5.0) - 1.0) * 0.5
    left = high - ratio * (high - low)
    right = low + ratio * (high - low)
    f_left = func(left)
    f_right = func(right)
    for _ in range(iterations):
        if f_left > f_right:
            low = left
            left = right
            f_left = f_right
            right = low + ratio * (high - low)
            f_right = func(right)
        else:
            high = right
            right = left
            f_right = f_left
            left = high - ratio * (high - low)
            f_left = func(left)
    value = (low + high) * 0.5
    return value, func(value)


def fit_prn(rows, ephemerides, receiver_ecef, prn, bounds, passes, golden_iterations):
    correction = {key: 0.0 for key in bounds}
    for _ in range(passes):
        for key, limit in bounds.items():
            def objective(value):
                candidate = dict(correction)
                candidate[key] = value
                return rms(residuals_for_prn(rows, ephemerides, receiver_ecef, prn, candidate))

            correction[key], _ = golden_section_minimize(objective, -limit, limit, golden_iterations)
    return correction


def summarize(rows, ephemerides, receiver_ecef, corrections):
    residuals = []
    for row in rows:
        prn = row["prn"]
        if prn not in ephemerides:
            continue
        ephemeris = corrected_ephemeris(ephemerides[prn], corrections.get(prn, {}))
        sx, sy, sz = satellite_position(ephemeris, row["tow_ms"] / 1000.0, 0.0, 0.0)
        rx, ry, rz = receiver_ecef
        residuals.append(math.sqrt((sx - rx) ** 2 + (sy - ry) ** 2 + (sz - rz) ** 2) - row["range_m"])
    return {
        "count": len(residuals),
        "mean_m": statistics.mean(residuals) if residuals else float("nan"),
        "rms_m": rms(residuals),
        "min_m": min(residuals) if residuals else float("nan"),
        "max_m": max(residuals) if residuals else float("nan"),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("sat_data", type=Path)
    parser.add_argument("ephemeris_xml", type=Path)
    parser.add_argument("output_csv", type=Path)
    parser.add_argument("--truth-lat-deg", type=float, required=True)
    parser.add_argument("--truth-lon-deg", type=float, required=True)
    parser.add_argument("--truth-height-m", type=float, required=True)
    parser.add_argument(
        "--truth-coordinate-type",
        choices=["geodetic", "planetocentric_surface", "spherical"],
        default="geodetic",
    )
    parser.add_argument("--truth-sphere-radius-m", type=float, default=3396190.0)
    parser.add_argument("--range-field", default="Range")
    parser.add_argument("--prns", default="")
    parser.add_argument("--max-epochs", type=int, default=0)
    parser.add_argument("--m0-bound-rad", type=float, default=2.0e-4)
    parser.add_argument("--omega0-bound-rad", type=float, default=2.0e-4)
    parser.add_argument("--i0-bound-rad", type=float, default=2.0e-4)
    parser.add_argument("--omega-bound-rad", type=float, default=0.0)
    parser.add_argument("--sqrtA-bound", type=float, default=0.2)
    parser.add_argument("--passes", type=int, default=6)
    parser.add_argument("--golden-iterations", type=int, default=80)
    args = parser.parse_args()

    allowed_prns = parse_prns(args.prns)
    ephemerides = load_ephemerides(args.ephemeris_xml)
    rows = load_sat_ranges(args.sat_data, args.range_field, prns=allowed_prns)
    rows = [row for row in rows if row["prn"] in ephemerides]
    rows = choose_epochs(rows, args.max_epochs)
    if not rows:
        raise SystemExit("No simulator range rows match the selected ephemerides")

    truth_args = SimpleNamespace(
        truth_lat_deg=args.truth_lat_deg,
        truth_lon_deg=args.truth_lon_deg,
        truth_height_m=args.truth_height_m,
        truth_coordinate_type=args.truth_coordinate_type,
        truth_sphere_radius_m=args.truth_sphere_radius_m,
    )
    receiver_ecef = truth_to_ecef(truth_args)

    bounds = {
        "delta_m0_rad": args.m0_bound_rad,
        "delta_omega0_rad": args.omega0_bound_rad,
        "delta_i0_rad": args.i0_bound_rad,
        "delta_sqrtA": args.sqrtA_bound,
    }
    if args.omega_bound_rad > 0.0:
        bounds["delta_omega_rad"] = args.omega_bound_rad

    base = summarize(rows, ephemerides, receiver_ecef, {})
    corrections = {}
    for prn in sorted({row["prn"] for row in rows}):
        correction = fit_prn(rows, ephemerides, receiver_ecef, prn, bounds, args.passes, args.golden_iterations)
        corrections[prn] = correction
        prn_base = rms(residuals_for_prn(rows, ephemerides, receiver_ecef, prn, {}))
        prn_fit = rms(residuals_for_prn(rows, ephemerides, receiver_ecef, prn, correction))
        print(f"PRN {prn:02d}: {prn_base:.3f} m -> {prn_fit:.3f} m")

    fitted = summarize(rows, ephemerides, receiver_ecef, corrections)
    lines = [
        "# prn,delta_m0_rad,delta_omega0_rad,delta_i0_rad,delta_omega_rad,delta_sqrtA",
    ]
    for prn in sorted(corrections):
        correction = corrections[prn]
        lines.append(
            f"{prn},"
            f"{correction.get('delta_m0_rad', 0.0):.17e},"
            f"{correction.get('delta_omega0_rad', 0.0):.17e},"
            f"{correction.get('delta_i0_rad', 0.0):.17e},"
            f"{correction.get('delta_omega_rad', 0.0):.17e},"
            f"{correction.get('delta_sqrtA', 0.0):.17e}"
        )
    args.output_csv.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote GPS ephemeris corrections to {args.output_csv}")
    print(f"Overall RMS: {base['rms_m']:.3f} m -> {fitted['rms_m']:.3f} m")


if __name__ == "__main__":
    main()
