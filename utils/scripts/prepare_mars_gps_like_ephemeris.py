#!/usr/bin/env python3
"""Prepare GNSS-SDR ephemeris assets for a Mars GPS-like Spirent scenario.

The script keeps simulator truth out of PVT. It uses simulator range logs only
to estimate a common body-fixed frame/time alignment for the broadcast
ephemeris before GNSS-SDR consumes it.
"""

import argparse
import json
import math
from pathlib import Path
from types import SimpleNamespace

from analyze_mars_frame_alignment import (
    MARS_ROTATION_RATE_RAD_S,
    choose_epochs,
    float_range,
    load_sat_ranges,
    rms_for_offsets,
    truth_to_ecef,
)
from spirent_navtxt_to_gnss_sdr_xml import (
    apply_frame_time_offsets,
    check_xml,
    parse_nav_subframes,
    parse_navtxt,
    write_ephemeris_xml,
    write_nav_bits_csv,
)


def parse_prns(text):
    if not text:
        return None
    return {int(item.strip()) for item in text.split(",") if item.strip()}


def ephemerides_by_prn(ephemerides):
    return {int(eph["PRN"]): eph for eph in ephemerides}


def sweep_offsets(rows, ephemerides, receiver_ecef, phase_values, dt_values):
    best = None
    phase_values = list(phase_values)
    dt_values = list(dt_values)
    for phase_s in phase_values:
        for dt_s in dt_values:
            rms, count, mean = rms_for_offsets(rows, ephemerides, receiver_ecef, phase_s, dt_s)
            if best is None or rms < best["rms_m"]:
                best = {
                    "rms_m": rms,
                    "mean_m": mean,
                    "rows": count,
                    "frame_phase_s": phase_s,
                    "frame_phase_rad": phase_s * MARS_ROTATION_RATE_RAD_S,
                    "frame_phase_deg": math.degrees(phase_s * MARS_ROTATION_RATE_RAD_S),
                    "ephemeris_time_offset_s": dt_s,
                }
    return best


def estimate_offsets(args, ephemerides):
    allowed_prns = parse_prns(args.prns)
    eph_by_prn = ephemerides_by_prn(ephemerides)
    rows = load_sat_ranges(args.sat_data, args.range_field, prns=allowed_prns)
    rows = [row for row in rows if row["prn"] in eph_by_prn]
    rows = choose_epochs(rows, args.max_epochs)
    if not rows:
        raise SystemExit("No simulator range rows match the selected PRNs and ephemerides")

    truth_args = SimpleNamespace(
        truth_lat_deg=args.truth_lat_deg,
        truth_lon_deg=args.truth_lon_deg,
        truth_height_m=args.truth_height_m,
        truth_coordinate_type=args.truth_coordinate_type,
        truth_sphere_radius_m=args.truth_sphere_radius_m,
    )
    receiver_ecef = truth_to_ecef(truth_args)

    base_rms, base_rows, base_mean = rms_for_offsets(rows, eph_by_prn, receiver_ecef, 0.0, 0.0)
    coarse = sweep_offsets(
        rows,
        eph_by_prn,
        receiver_ecef,
        float_range(args.phase_min_s, args.phase_max_s, args.phase_step_s),
        float_range(args.dt_min_s, args.dt_max_s, args.dt_step_s),
    )

    refine_phase_half_width = max(args.phase_step_s, args.refine_phase_half_width_s)
    refine_dt_half_width = max(args.dt_step_s, args.refine_dt_half_width_s)
    refined = sweep_offsets(
        rows,
        eph_by_prn,
        receiver_ecef,
        float_range(
            coarse["frame_phase_s"] - refine_phase_half_width,
            coarse["frame_phase_s"] + refine_phase_half_width,
            args.refine_phase_step_s,
        ),
        float_range(
            coarse["ephemeris_time_offset_s"] - refine_dt_half_width,
            coarse["ephemeris_time_offset_s"] + refine_dt_half_width,
            args.refine_dt_step_s,
        ),
    )

    return {
        "truth": {
            "coordinate_type": args.truth_coordinate_type,
            "lat_deg": args.truth_lat_deg,
            "lon_deg": args.truth_lon_deg,
            "height_m": args.truth_height_m,
            "sphere_radius_m": args.truth_sphere_radius_m,
        },
        "range_field": args.range_field,
        "selected_prns": sorted(allowed_prns) if allowed_prns else "all",
        "base": {
            "rms_m": base_rms,
            "mean_m": base_mean,
            "rows": base_rows,
            "frame_phase_s": 0.0,
            "frame_phase_rad": 0.0,
            "frame_phase_deg": 0.0,
            "ephemeris_time_offset_s": 0.0,
        },
        "coarse": coarse,
        "best": refined,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("navtxt", type=Path)
    parser.add_argument("sat_data", type=Path)
    parser.add_argument("output_xml", type=Path)
    parser.add_argument("--bits-output", type=Path)
    parser.add_argument("--summary-output", type=Path)
    parser.add_argument("--prns", default="")
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
    parser.add_argument("--max-epochs", type=int, default=80)
    parser.add_argument("--phase-min-s", type=float, default=-30.0)
    parser.add_argument("--phase-max-s", type=float, default=30.0)
    parser.add_argument("--phase-step-s", type=float, default=0.5)
    parser.add_argument("--dt-min-s", type=float, default=-5.0)
    parser.add_argument("--dt-max-s", type=float, default=5.0)
    parser.add_argument("--dt-step-s", type=float, default=0.5)
    parser.add_argument("--refine-phase-half-width-s", type=float, default=1.0)
    parser.add_argument("--refine-phase-step-s", type=float, default=0.05)
    parser.add_argument("--refine-dt-half-width-s", type=float, default=1.0)
    parser.add_argument("--refine-dt-step-s", type=float, default=0.1)
    args = parser.parse_args()

    allowed_prns = parse_prns(args.prns)
    ephemerides = parse_navtxt(args.navtxt, allowed_prns)
    summary = estimate_offsets(args, ephemerides)
    best = summary["best"]

    apply_frame_time_offsets(
        ephemerides,
        frame_phase_offset_rad=best["frame_phase_rad"],
        ephemeris_time_offset_s=best["ephemeris_time_offset_s"],
    )
    write_ephemeris_xml(ephemerides, args.output_xml)
    check_xml(args.output_xml)

    if args.bits_output:
        subframes = parse_nav_subframes(args.navtxt, allowed_prns)
        write_nav_bits_csv(subframes, args.bits_output)
        summary["nav_subframes_written"] = len(subframes)

    if args.summary_output:
        args.summary_output.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(f"Wrote corrected ephemeris XML to {args.output_xml}")
    if args.bits_output:
        print(f"Wrote NAV-bit truth CSV to {args.bits_output}")
    if args.summary_output:
        print(f"Wrote alignment summary to {args.summary_output}")
    print(
        "Mars frame alignment: "
        f"base_rms={summary['base']['rms_m']:.3f} m, "
        f"best_rms={best['rms_m']:.3f} m, "
        f"frame_phase_s={best['frame_phase_s']:.6f}, "
        f"frame_phase_rad={best['frame_phase_rad']:.17e}, "
        f"ephemeris_time_offset_s={best['ephemeris_time_offset_s']:.6f}"
    )


if __name__ == "__main__":
    main()
