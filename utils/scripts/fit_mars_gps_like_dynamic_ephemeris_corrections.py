#!/usr/bin/env python3
"""Fit time-dependent GPS LNAV ephemeris corrections against Mars ranges.

The output CSV is consumed by PVT.gps_ephemeris_corrections_file. Rows include
either:

* linear_fit: one row per PRN with an intercept at a per-PRN GPS TOW reference
  and a linear rate term for each corrected broadcast parameter.
* true_dynamic_fit: one row per PRN and GPS TOW sample. GNSS-SDR interpolates
  those samples at each PVT epoch.
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
    ("delta_m0_rad", "M_0", "delta_m0_rate_rad_s"),
    ("delta_omega0_rad", "OMEGA_0", "delta_omega0_rate_rad_s"),
    ("delta_i0_rad", "i_0", "delta_i0_rate_rad_s"),
    ("delta_omega_rad", "omega", "delta_omega_rate_rad_s"),
    ("delta_sqrtA", "sqrtA", "delta_sqrtA_rate_s"),
)


def parse_prns(text):
    if not text:
        return None
    return {int(item.strip()) for item in text.split(",") if item.strip()}


def parse_static_corrections(path):
    corrections = {}
    if path is None:
        return corrections
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        parts = [item.strip() for item in line.replace(",", " ").split() if item.strip()]
        if len(parts) < 6:
            continue
        prn = int(parts[0])
        if len(parts) >= 12:
            corrections[prn] = {
                "reference_tow_s": float(parts[1]),
                "delta_m0_rad": float(parts[2]),
                "delta_omega0_rad": float(parts[3]),
                "delta_i0_rad": float(parts[4]),
                "delta_omega_rad": float(parts[5]),
                "delta_sqrtA": float(parts[6]),
                "delta_m0_rate_rad_s": float(parts[7]),
                "delta_omega0_rate_rad_s": float(parts[8]),
                "delta_i0_rate_rad_s": float(parts[9]),
                "delta_omega_rate_rad_s": float(parts[10]),
                "delta_sqrtA_rate_s": float(parts[11]),
            }
        elif len(parts) == 7:
            corrections[prn] = {
                "reference_tow_s": float(parts[1]),
                "delta_m0_rad": float(parts[2]),
                "delta_omega0_rad": float(parts[3]),
                "delta_i0_rad": float(parts[4]),
                "delta_omega_rad": float(parts[5]),
                "delta_sqrtA": float(parts[6]),
            }
        else:
            corrections[prn] = {
                "delta_m0_rad": float(parts[1]),
                "delta_omega0_rad": float(parts[2]),
                "delta_i0_rad": float(parts[3]),
                "delta_omega_rad": float(parts[4]),
                "delta_sqrtA": float(parts[5]),
            }
    return corrections


def reference_tow_for_prn(rows, prn):
    tows = [row["tow_ms"] * 0.001 for row in rows if row["prn"] == prn]
    if not tows:
        return 0.0
    return statistics.mean(tows)


def rows_by_prn(rows):
    grouped = {}
    for row in rows:
        grouped.setdefault(row["prn"], []).append(row)
    for prn_rows in grouped.values():
        prn_rows.sort(key=lambda row: row["tow_ms"])
    return grouped


def corrected_ephemeris(ephemeris, correction, tow_s):
    result = copy.copy(ephemeris)
    reference_tow_s = correction.get("reference_tow_s", tow_s)
    dt_s = tow_s - reference_tow_s
    for correction_key, eph_key, rate_key in FIELDS:
        result[eph_key] += correction.get(correction_key, 0.0) + correction.get(rate_key, 0.0) * dt_s
    return result


def correction_evaluated_at(correction, tow_s):
    evaluated = {"reference_tow_s": tow_s}
    reference_tow_s = correction.get("reference_tow_s", tow_s)
    dt_s = tow_s - reference_tow_s
    for correction_key, _, rate_key in FIELDS:
        evaluated[correction_key] = correction.get(correction_key, 0.0) + correction.get(rate_key, 0.0) * dt_s
    return evaluated


def residuals_for_prn(rows, ephemerides, receiver_ecef, prn, correction):
    residuals = []
    rx, ry, rz = receiver_ecef
    for row in rows:
        if row["prn"] != prn:
            continue
        tow_s = row["tow_ms"] * 0.001
        ephemeris = corrected_ephemeris(ephemerides[prn], correction, tow_s)
        sx, sy, sz = satellite_position(ephemeris, tow_s, 0.0, 0.0)
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


def fit_prn(
    rows,
    ephemerides,
    receiver_ecef,
    prn,
    initial_correction,
    bounds,
    passes,
    golden_iterations,
    center_bounds_on_initial=False,
):
    correction = dict(initial_correction)
    correction["reference_tow_s"] = reference_tow_for_prn(rows, prn)
    for _, _, rate_key in FIELDS:
        correction.setdefault(rate_key, 0.0)

    fit_keys = list(bounds)
    for _ in range(passes):
        for key in fit_keys:
            limit = bounds[key]
            center = correction.get(key, 0.0) if center_bounds_on_initial else 0.0

            def objective(value):
                candidate = dict(correction)
                candidate[key] = value
                return rms(residuals_for_prn(rows, ephemerides, receiver_ecef, prn, candidate))

            correction[key], _ = golden_section_minimize(objective, center - limit, center + limit, golden_iterations)
    return correction


def local_window_rows(prn_rows, center_index, window_epochs):
    if window_epochs <= 1:
        return [prn_rows[center_index]]
    target_count = min(len(prn_rows), max(1, window_epochs))
    half = target_count // 2
    start = max(0, center_index - half)
    end = min(len(prn_rows), start + target_count)
    start = max(0, end - target_count)
    return prn_rows[start:end]


def correction_sample_at(samples, tow_s):
    if not samples:
        return {}
    if tow_s <= samples[0]["reference_tow_s"]:
        return samples[0]
    if tow_s >= samples[-1]["reference_tow_s"]:
        return samples[-1]
    low = 0
    high = len(samples) - 1
    while low + 1 < high:
        mid = (low + high) // 2
        if samples[mid]["reference_tow_s"] <= tow_s:
            low = mid
        else:
            high = mid
    left = samples[low]
    right = samples[high]
    span = right["reference_tow_s"] - left["reference_tow_s"]
    weight = 0.0 if span <= 0.0 else (tow_s - left["reference_tow_s"]) / span
    correction = {"reference_tow_s": tow_s}
    for correction_key, _, _ in FIELDS:
        correction[correction_key] = left.get(correction_key, 0.0) + (
            right.get(correction_key, 0.0) - left.get(correction_key, 0.0)
        ) * weight
    return correction


def fit_true_dynamic_prn(
    prn_rows,
    ephemerides,
    receiver_ecef,
    prn,
    base_correction,
    bounds,
    passes,
    golden_iterations,
    window_epochs,
    step_epochs,
):
    samples = []
    step = max(1, step_epochs)
    for center_index in range(0, len(prn_rows), step):
        target_tow_s = prn_rows[center_index]["tow_ms"] * 0.001
        local_rows = local_window_rows(prn_rows, center_index, window_epochs)
        initial = correction_evaluated_at(base_correction, target_tow_s)
        if samples:
            initial.update(samples[-1])
        correction = fit_prn(
            local_rows,
            ephemerides,
            receiver_ecef,
            prn,
            initial,
            bounds,
            passes,
            golden_iterations,
            center_bounds_on_initial=True,
        )
        correction["reference_tow_s"] = target_tow_s
        samples.append(correction)
    if samples and samples[-1]["reference_tow_s"] != prn_rows[-1]["tow_ms"] * 0.001:
        target_tow_s = prn_rows[-1]["tow_ms"] * 0.001
        local_rows = local_window_rows(prn_rows, len(prn_rows) - 1, window_epochs)
        initial = correction_evaluated_at(base_correction, target_tow_s)
        initial.update(samples[-1])
        correction = fit_prn(
            local_rows,
            ephemerides,
            receiver_ecef,
            prn,
            initial,
            bounds,
            passes,
            golden_iterations,
            center_bounds_on_initial=True,
        )
        correction["reference_tow_s"] = target_tow_s
        samples.append(correction)
    return samples


def summarize(rows, ephemerides, receiver_ecef, corrections):
    residuals = []
    for row in rows:
        prn = row["prn"]
        if prn not in ephemerides:
            continue
        tow_s = row["tow_ms"] * 0.001
        ephemeris = corrected_ephemeris(ephemerides[prn], corrections.get(prn, {}), tow_s)
        sx, sy, sz = satellite_position(ephemeris, tow_s, 0.0, 0.0)
        rx, ry, rz = receiver_ecef
        residuals.append(math.sqrt((sx - rx) ** 2 + (sy - ry) ** 2 + (sz - rz) ** 2) - row["range_m"])
    return {
        "count": len(residuals),
        "mean_m": statistics.mean(residuals) if residuals else float("nan"),
        "rms_m": rms(residuals),
        "min_m": min(residuals) if residuals else float("nan"),
        "max_m": max(residuals) if residuals else float("nan"),
    }


def summarize_true_dynamic(rows, ephemerides, receiver_ecef, samples_by_prn):
    residuals = []
    for row in rows:
        prn = row["prn"]
        if prn not in ephemerides:
            continue
        tow_s = row["tow_ms"] * 0.001
        correction = correction_sample_at(samples_by_prn.get(prn, []), tow_s)
        ephemeris = corrected_ephemeris(ephemerides[prn], correction, tow_s)
        sx, sy, sz = satellite_position(ephemeris, tow_s, 0.0, 0.0)
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
    parser.add_argument(
        "--fit-method",
        choices=["linear_fit", "true_dynamic_fit"],
        default="linear_fit",
        help="linear_fit writes one intercept+rate row per PRN. true_dynamic_fit writes one interpolated sample row per PRN epoch.",
    )
    parser.add_argument("--initial-static-csv", type=Path)
    parser.add_argument("--m0-bound-rad", type=float, default=2.0e-3)
    parser.add_argument("--omega0-bound-rad", type=float, default=2.0e-3)
    parser.add_argument("--i0-bound-rad", type=float, default=2.0e-4)
    parser.add_argument("--omega-bound-rad", type=float, default=1.0e-5)
    parser.add_argument("--sqrtA-bound", type=float, default=2.0)
    parser.add_argument("--m0-rate-bound-rad-s", type=float, default=2.0e-6)
    parser.add_argument("--omega0-rate-bound-rad-s", type=float, default=2.0e-6)
    parser.add_argument("--i0-rate-bound-rad-s", type=float, default=2.0e-7)
    parser.add_argument("--omega-rate-bound-rad-s", type=float, default=2.0e-7)
    parser.add_argument("--sqrtA-rate-bound-s", type=float, default=1.0e-2)
    parser.add_argument("--fit-intercepts", action="store_true")
    parser.add_argument("--passes", type=int, default=7)
    parser.add_argument("--golden-iterations", type=int, default=70)
    parser.add_argument(
        "--true-dynamic-window-epochs",
        type=int,
        default=31,
        help="Centered local fitting window, in simulator epochs, for true_dynamic_fit.",
    )
    parser.add_argument(
        "--true-dynamic-step-epochs",
        type=int,
        default=1,
        help="Output every Nth simulator epoch for true_dynamic_fit. The last epoch is always emitted.",
    )
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

    static_corrections = parse_static_corrections(args.initial_static_csv)
    base_corrections = {}
    for prn in sorted({row["prn"] for row in rows}):
        base_correction = dict(static_corrections.get(prn, {}))
        base_correction.setdefault("reference_tow_s", reference_tow_for_prn(rows, prn))
        base_corrections[prn] = base_correction

    bounds = {
        "delta_m0_rate_rad_s": args.m0_rate_bound_rad_s,
        "delta_omega0_rate_rad_s": args.omega0_rate_bound_rad_s,
        "delta_i0_rate_rad_s": args.i0_rate_bound_rad_s,
        "delta_omega_rate_rad_s": args.omega_rate_bound_rad_s,
        "delta_sqrtA_rate_s": args.sqrtA_rate_bound_s,
    }
    if args.fit_intercepts:
        bounds.update(
            {
                "delta_m0_rad": args.m0_bound_rad,
                "delta_omega0_rad": args.omega0_bound_rad,
                "delta_i0_rad": args.i0_bound_rad,
                "delta_omega_rad": args.omega_bound_rad,
                "delta_sqrtA": args.sqrtA_bound,
            }
        )
    true_dynamic_bounds = {
        "delta_m0_rad": args.m0_bound_rad,
        "delta_omega0_rad": args.omega0_bound_rad,
        "delta_i0_rad": args.i0_bound_rad,
        "delta_omega_rad": args.omega_bound_rad,
        "delta_sqrtA": args.sqrtA_bound,
    }

    base = summarize(rows, ephemerides, receiver_ecef, base_corrections)
    if args.fit_method == "true_dynamic_fit":
        grouped_rows = rows_by_prn(rows)
        samples_by_prn = {}
        for prn in sorted(grouped_rows):
            prn_rows = grouped_rows[prn]
            samples = fit_true_dynamic_prn(
                prn_rows,
                ephemerides,
                receiver_ecef,
                prn,
                base_corrections.get(prn, {}),
                true_dynamic_bounds,
                args.passes,
                args.golden_iterations,
                args.true_dynamic_window_epochs,
                args.true_dynamic_step_epochs,
            )
            samples_by_prn[prn] = samples
            prn_base = rms(residuals_for_prn(rows, ephemerides, receiver_ecef, prn, base_corrections.get(prn, {})))
            prn_fit = summarize_true_dynamic(prn_rows, ephemerides, receiver_ecef, {prn: samples})["rms_m"]
            print(f"PRN {prn:02d}: {prn_base:.3f} m -> {prn_fit:.3f} m ({len(samples)} samples)")

        fitted = summarize_true_dynamic(rows, ephemerides, receiver_ecef, samples_by_prn)
        lines = [
            "# mode=true_dynamic_fit",
            "# prn,tow_s,delta_m0_rad,delta_omega0_rad,delta_i0_rad,delta_omega_rad,delta_sqrtA",
        ]
        for prn in sorted(samples_by_prn):
            for correction in samples_by_prn[prn]:
                lines.append(
                    f"{prn},"
                    f"{correction.get('reference_tow_s', 0.0):.6f},"
                    f"{correction.get('delta_m0_rad', 0.0):.17e},"
                    f"{correction.get('delta_omega0_rad', 0.0):.17e},"
                    f"{correction.get('delta_i0_rad', 0.0):.17e},"
                    f"{correction.get('delta_omega_rad', 0.0):.17e},"
                    f"{correction.get('delta_sqrtA', 0.0):.17e}"
                )
        args.output_csv.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"Wrote true dynamic GPS ephemeris corrections to {args.output_csv}")
        print(f"Overall RMS: {base['rms_m']:.3f} m -> {fitted['rms_m']:.3f} m")
        return

    corrections = {}
    for prn in sorted({row["prn"] for row in rows}):
        correction = fit_prn(
            rows,
            ephemerides,
            receiver_ecef,
            prn,
            base_corrections.get(prn, {}),
            bounds,
            args.passes,
            args.golden_iterations,
        )
        corrections[prn] = correction
        prn_base = rms(residuals_for_prn(rows, ephemerides, receiver_ecef, prn, base_corrections.get(prn, {})))
        prn_fit = rms(residuals_for_prn(rows, ephemerides, receiver_ecef, prn, correction))
        print(f"PRN {prn:02d}: {prn_base:.3f} m -> {prn_fit:.3f} m")

    fitted = summarize(rows, ephemerides, receiver_ecef, corrections)
    lines = [
        "# mode=linear_fit",
        "# prn,reference_tow_s,delta_m0_rad,delta_omega0_rad,delta_i0_rad,delta_omega_rad,delta_sqrtA,delta_m0_rate_rad_s,delta_omega0_rate_rad_s,delta_i0_rate_rad_s,delta_omega_rate_rad_s,delta_sqrtA_rate_s",
    ]
    for prn in sorted(corrections):
        correction = corrections[prn]
        lines.append(
            f"{prn},"
            f"{correction.get('reference_tow_s', 0.0):.6f},"
            f"{correction.get('delta_m0_rad', 0.0):.17e},"
            f"{correction.get('delta_omega0_rad', 0.0):.17e},"
            f"{correction.get('delta_i0_rad', 0.0):.17e},"
            f"{correction.get('delta_omega_rad', 0.0):.17e},"
            f"{correction.get('delta_sqrtA', 0.0):.17e},"
            f"{correction.get('delta_m0_rate_rad_s', 0.0):.17e},"
            f"{correction.get('delta_omega0_rate_rad_s', 0.0):.17e},"
            f"{correction.get('delta_i0_rate_rad_s', 0.0):.17e},"
            f"{correction.get('delta_omega_rate_rad_s', 0.0):.17e},"
            f"{correction.get('delta_sqrtA_rate_s', 0.0):.17e}"
        )
    args.output_csv.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote linear fit GPS ephemeris corrections to {args.output_csv}")
    print(f"Overall RMS: {base['rms_m']:.3f} m -> {fitted['rms_m']:.3f} m")


if __name__ == "__main__":
    main()
