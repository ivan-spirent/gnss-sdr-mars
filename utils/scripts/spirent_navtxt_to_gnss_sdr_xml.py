#!/usr/bin/env python3
"""Convert a Spirent GPS L1 C/A NAV analysis text file to GNSS-SDR XML."""

import argparse
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path


MARS_MU = 4.282837e13
MARS_ROTATION_RATE_RAD_S = 7.088218e-5

SEMICIRCLE_FIELDS = {
    "M_0",
    "OMEGA_0",
    "i_0",
    "omega",
}

SEMICIRCLE_RATE_FIELDS = {
    "delta_n",
    "OMEGAdot",
    "idot",
}


def parse_numeric(text):
    value = text.strip()
    if "." in value or "e" in value.lower():
        return float(value)
    return int(value)


def make_pattern(label, units=None):
    units_part = "" if units is None else rf"\s+{units}"
    return re.compile(
        rf"{re.escape(label)}\s+\S+\s+([+-]?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?)" + units_part,
        re.IGNORECASE,
    )


PATTERNS = [
    ("WN", make_pattern("Week no", r"week")),
    ("code_on_L2", make_pattern("Ca or p code", r"none")),
    ("SV_accuracy", make_pattern("Satellite accuracy")),
    ("SV_health", make_pattern("Satellite health")),
    ("IODC", make_pattern("Issue of data clock")),
    ("L2_P_data_flag", make_pattern("L2 p data flag")),
    ("TGD", make_pattern("Tgd correction", r"seconds")),
    ("toc", make_pattern("Clock data ref time", r"seconds")),
    ("af2", make_pattern("Af2", r"s/s\*\*2")),
    ("af1", make_pattern("Af1", r"s/s")),
    ("af0", make_pattern("Af0", r"seconds")),
    ("IODE_SF2", make_pattern("Issue of data eph 2")),
    ("Crs", make_pattern("Crs sin harmonic corr", r"metres")),
    ("delta_n", make_pattern("Mean motion diff", r"semi-c/s")),
    ("M_0", make_pattern("Mean anomaly", r"!\s+semi-c")),
    ("Cuc", make_pattern("Cuc cos harmonic corr", r"radians")),
    ("ecc", make_pattern("Eccentricity")),
    ("Cus", make_pattern("Cus sin harmonic corr", r"radians")),
    ("sqrtA", make_pattern("Root semi major")),
    ("toe", make_pattern("Ref time eph", r"seconds")),
    ("fit_interval_flag", make_pattern("Fit interval flag")),
    ("AODO", make_pattern("AODO")),
    ("Cic", make_pattern("Cic cos harmonic", r"radians")),
    ("OMEGA_0", make_pattern("Long of asc node", r"!\s+semi-c")),
    ("Cis", make_pattern("Cis sine harmonic corr", r"radians")),
    ("i_0", make_pattern("Inclination", r"!\s+semi-c")),
    ("Crc", make_pattern("Crc cos harmonic corr", r"metres")),
    ("omega", make_pattern("Arg perigee", r"!\s+semi-c")),
    ("OMEGAdot", make_pattern("Right asc rate", r"semi-c/s")),
    ("IODE_SF3", make_pattern("Issue of data eph 3")),
    ("idot", make_pattern("Inclination rate", r"semi-c/s")),
]


FIELDS = [
    "PRN",
    "M_0",
    "delta_n",
    "ecc",
    "sqrtA",
    "OMEGA_0",
    "i_0",
    "omega",
    "OMEGAdot",
    "idot",
    "Cuc",
    "Cus",
    "Crc",
    "Crs",
    "Cic",
    "Cis",
    "toe",
    "toc",
    "af0",
    "af1",
    "af2",
    "WN",
    "tow",
    "satClkDrift",
    "dtr",
    "IODE_SF2",
    "IODE_SF3",
    "code_on_L2",
    "L2_P_data_flag",
    "SV_accuracy",
    "SV_health",
    "TGD",
    "IODC",
    "AODO",
    "fit_interval_flag",
    "spare1",
    "spare2",
    "integrity_status_flag",
    "alert_flag",
    "antispoofing_flag",
]

REQUIRED = {
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
    "toc",
    "WN",
}


def parse_navtxt(path, allowed_prns=None):
    current_prn = None
    records = {}

    for line in path.read_text(errors="replace").splitlines():
        match = re.search(r"Analysis is for SVID:\s+(\d+)", line)
        if match:
            current_prn = int(match.group(1))
            if allowed_prns is not None and current_prn not in allowed_prns:
                continue
            records.setdefault(current_prn, {"PRN": current_prn})
            continue
        if current_prn is None or (allowed_prns is not None and current_prn not in allowed_prns):
            continue

        record = records[current_prn]
        for key, pattern in PATTERNS:
            if key in record:
                continue
            match = pattern.search(line)
            if match:
                value = parse_numeric(match.group(1))
                if key in SEMICIRCLE_FIELDS or key in SEMICIRCLE_RATE_FIELDS:
                    value = float(value) * math.pi
                record[key] = value
                break

    ephemerides = []
    for prn, record in sorted(records.items()):
        if not REQUIRED.issubset(record):
            missing = ", ".join(sorted(REQUIRED.difference(record)))
            print(f"Skipping PRN {prn}: missing {missing}")
            continue

        eph = {field: 0 for field in FIELDS}
        eph.update(record)
        eph["tow"] = int(round(eph["toe"]))
        eph["toe"] = int(round(eph["toe"]))
        eph["toc"] = int(round(eph["toc"]))
        eph["satClkDrift"] = 0.0
        eph["dtr"] = 0.0
        eph["spare1"] = 0.0
        eph["spare2"] = 0.0
        eph["integrity_status_flag"] = 0
        eph["alert_flag"] = 0
        eph["antispoofing_flag"] = 0
        ephemerides.append(eph)

    return ephemerides


def normalize_angle(angle):
    return (angle + math.pi) % (2.0 * math.pi) - math.pi


def apply_frame_time_offsets(
    ephemerides,
    frame_phase_offset_rad=0.0,
    ephemeris_time_offset_s=0.0,
    mu=MARS_MU,
    rotation_rate_rad_s=MARS_ROTATION_RATE_RAD_S,
):
    """Apply a common Mars body-fixed frame/time correction to ICD-like elements.

    Spirent Mars GPS-like files may describe satellites in a SPICE IAU_MARS
    body-fixed frame whose prime-meridian phase is not exactly the one implied
    by the receiver's broadcast-orbit equation. These offsets are explicit
    diagnostics/conditioning knobs; their defaults are zero.
    """
    if frame_phase_offset_rad == 0.0 and ephemeris_time_offset_s == 0.0:
        return

    for eph in ephemerides:
        semi_major_axis = float(eph["sqrtA"]) ** 2
        mean_motion = math.sqrt(mu / (semi_major_axis ** 3)) + float(eph["delta_n"])

        eph["M_0"] = normalize_angle(float(eph["M_0"]) + mean_motion * ephemeris_time_offset_s)
        eph["OMEGA_0"] = normalize_angle(
            float(eph["OMEGA_0"]) +
            frame_phase_offset_rad +
            (float(eph["OMEGAdot"]) - rotation_rate_rad_s) * ephemeris_time_offset_s
        )
        eph["i_0"] = normalize_angle(float(eph["i_0"]) + float(eph["idot"]) * ephemeris_time_offset_s)


def format_value(value):
    if isinstance(value, float):
        return f"{value:.17e}"
    return str(value)


def write_ephemeris_xml(ephemerides, output_path):
    lines = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>',
        "<!DOCTYPE boost_serialization>",
        '<boost_serialization signature="serialization::archive" version="19">',
        '<GNSS-SDR_ephemeris_map class_id="0" tracking_level="0" version="0">',
        f"\t<count>{len(ephemerides)}</count>",
        "\t<item_version>0</item_version>",
    ]

    for index, eph in enumerate(ephemerides):
        if index == 0:
            lines.append('\t<item class_id="1" tracking_level="0" version="0">')
            lines.append(f"\t\t<first>{eph['PRN']}</first>")
            lines.append('\t\t<second class_id="2" tracking_level="0" version="0">')
        else:
            lines.append("\t<item>")
            lines.append(f"\t\t<first>{eph['PRN']}</first>")
            lines.append("\t\t<second>")
        for field in FIELDS:
            lines.append(f"\t\t\t<{field}>{format_value(eph[field])}</{field}>")
        lines.extend(["\t\t</second>", "\t</item>"])

    lines.extend(["</GNSS-SDR_ephemeris_map>", "</boost_serialization>", ""])
    output_path.write_text("\n".join(lines), encoding="utf-8")


def parse_nav_subframes(path, allowed_prns=None):
    current_prn = None
    words = {}
    subframes = []

    for line in path.read_text(errors="replace").splitlines():
        match = re.search(r"Analysis is for SVID:\s+(\d+)", line)
        if match:
            current_prn = int(match.group(1))
            continue
        if current_prn is None or (allowed_prns is not None and current_prn not in allowed_prns):
            continue

        match = re.search(r"SUBFRAME\s+(\d+)\s+WORD\s+(\d+)\s+=\s+([0-9A-Fa-f]+)", line)
        if match:
            subframe_id = int(match.group(1))
            word_index = int(match.group(2))
            word = int(match.group(3), 16) & 0x3FFFFFFF
            words[(current_prn, subframe_id, word_index)] = word
            continue

        match = re.search(r"Trunc time of week\s+(\d+)\s+\S+\s+(\d+)\s+none", line)
        if match:
            subframe_id = int(match.group(1))
            how_count = int(match.group(2))
            if all((current_prn, subframe_id, word_index) in words for word_index in range(1, 11)):
                bits = "".join(
                    f"{words[(current_prn, subframe_id, word_index)]:030b}"
                    for word_index in range(1, 11)
                )
                subframes.append(
                    {
                        "prn": current_prn,
                        "subframe_id": subframe_id,
                        "tow_at_current_symbol_ms": how_count * 6000,
                        "bits": bits,
                    }
                )

    return subframes


def write_nav_bits_csv(subframes, output_path):
    lines = ["# prn,subframe_id,tow_at_current_symbol_ms,bits"]
    for subframe in subframes:
        lines.append(
            f"{subframe['prn']},{subframe['subframe_id']},"
            f"{subframe['tow_at_current_symbol_ms']},{subframe['bits']}"
        )
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def check_xml(path):
    ET.parse(path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--prns",
        default="",
        help="Optional comma-separated PRN allowlist. By default, all complete PRNs are written.",
    )
    parser.add_argument(
        "--bits-output",
        type=Path,
        help="Optional CSV output with 300-bit LNAV subframes for assisted telemetry synchronization.",
    )
    parser.add_argument(
        "--mars-frame-phase-offset-s",
        type=float,
        default=0.0,
        help=(
            "Common IAU_MARS/body-fixed frame phase offset in Mars rotation seconds. "
            "Positive values rotate OMEGA_0 forward by omega_mars * seconds. Default: 0."
        ),
    )
    parser.add_argument(
        "--mars-frame-phase-offset-rad",
        type=float,
        default=0.0,
        help="Additional common body-fixed frame phase offset in radians. Default: 0.",
    )
    parser.add_argument(
        "--ephemeris-time-offset-s",
        type=float,
        default=0.0,
        help=(
            "Small propagation-time offset applied to M_0, OMEGA_0, and i_0 while leaving "
            "toe/toc unchanged. Use for SPICE/GPS-time alignment sweeps. Default: 0."
        ),
    )
    parser.add_argument(
        "--planetary-mu",
        type=float,
        default=MARS_MU,
        help=f"Planetary gravitational parameter for the time-offset propagation. Default: {MARS_MU}.",
    )
    parser.add_argument(
        "--planetary-rotation-rate-rad-s",
        type=float,
        default=MARS_ROTATION_RATE_RAD_S,
        help=(
            "Body rotation rate used to convert frame seconds to radians and propagate OMEGA_0. "
            f"Default: {MARS_ROTATION_RATE_RAD_S}."
        ),
    )
    args = parser.parse_args()

    allowed = None
    if args.prns:
        allowed = {int(item.strip()) for item in args.prns.split(",") if item.strip()}
    ephemerides = parse_navtxt(args.input, allowed)
    frame_phase_offset_rad = (
        args.mars_frame_phase_offset_rad +
        args.mars_frame_phase_offset_s * args.planetary_rotation_rate_rad_s
    )
    apply_frame_time_offsets(
        ephemerides,
        frame_phase_offset_rad=frame_phase_offset_rad,
        ephemeris_time_offset_s=args.ephemeris_time_offset_s,
        mu=args.planetary_mu,
        rotation_rate_rad_s=args.planetary_rotation_rate_rad_s,
    )

    write_ephemeris_xml(ephemerides, args.output)
    check_xml(args.output)
    print(f"Wrote {len(ephemerides)} GPS LNAV ephemerides to {args.output}")
    if frame_phase_offset_rad != 0.0 or args.ephemeris_time_offset_s != 0.0:
        print(
            "Applied frame/time offsets: "
            f"frame_phase_rad={frame_phase_offset_rad:.17e}, "
            f"frame_phase_s={frame_phase_offset_rad / args.planetary_rotation_rate_rad_s:.6f}, "
            f"ephemeris_time_offset_s={args.ephemeris_time_offset_s:.6f}"
        )
    if args.bits_output:
        subframes = parse_nav_subframes(args.input, allowed)
        write_nav_bits_csv(subframes, args.bits_output)
        print(f"Wrote {len(subframes)} GPS LNAV subframes to {args.bits_output}")


if __name__ == "__main__":
    main()
