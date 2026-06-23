#!/usr/bin/env python3
"""Convert a Spirent .gps scenario file to GNSS-SDR GPS ephemeris XML."""

import argparse
import math
import xml.etree.ElementTree as ET
from pathlib import Path


MARS_MU = 4.282837e13


def text_of(node, name, default="0"):
    child = node.find(name)
    if child is None or child.text is None:
        return default
    return child.text.strip()


def float_of(node, name, default=0.0):
    return float(text_of(node, name, str(default)))


def int_of(node, name, default=0):
    return int(float(text_of(node, name, str(default))))


def bool_text(value):
    return "1" if value else "0"


def normalize_angle(rad):
    return (rad + math.pi) % (2.0 * math.pi) - math.pi


def get_upload_value(satellite, name, default="0"):
    upload = satellite.find("upload")
    if upload is None:
        return default
    return text_of(upload, name, default)


def ephemeris_from_satellite(satellite, target_toe):
    prn = int_of(satellite, "PRN")
    source_toe = float_of(satellite, "Time_of_Applicability_s")
    sqrt_a = float_of(satellite, "SQRT_A")
    semi_major_axis = sqrt_a * sqrt_a
    mean_motion = math.sqrt(MARS_MU / (semi_major_axis * semi_major_axis * semi_major_axis))
    mean_anomaly = float_of(satellite, "Mean_Anom_rad")
    toe = source_toe if target_toe is None else target_toe
    mean_anomaly = normalize_angle(mean_anomaly + mean_motion * (toe - source_toe))

    nav_health = get_upload_value(satellite, "nav_data_health", "000")
    sv_health = int(nav_health, 2) if set(nav_health) <= {"0", "1"} else 0

    return {
        "PRN": prn,
        "M_0": mean_anomaly,
        "delta_n": float_of(satellite, "Mean_motion_err"),
        "ecc": float_of(satellite, "Eccentricity"),
        "sqrtA": sqrt_a,
        "OMEGA_0": float_of(satellite, "Right_Ascen_at_TOA_rad"),
        "i_0": float_of(satellite, "Orbital_Inclination_rad"),
        "omega": float_of(satellite, "Argument_of_Perigee_rad"),
        "OMEGAdot": float_of(satellite, "Rate_of_Right_Ascen_r_s"),
        "idot": float_of(satellite, "Orbital_Inclin_Rate_r_s"),
        "Cuc": float_of(satellite, "perturbation_Cuc"),
        "Cus": float_of(satellite, "perturbation_Cus"),
        "Crc": float_of(satellite, "perturbation_Crc"),
        "Crs": float_of(satellite, "perturbation_Crs"),
        "Cic": float_of(satellite, "perturbation_Cic"),
        "Cis": float_of(satellite, "perturbation_Cis"),
        "toe": int(round(toe)),
        "toc": int(round(toe)),
        "af0": float_of(satellite, "Af0_clock_corr"),
        "af1": float_of(satellite, "Af1_clock_corr"),
        "af2": float_of(satellite, "Af2_clock_corr"),
        "WN": int_of(satellite, "week"),
        "tow": int(round(toe)),
        "satClkDrift": 0.0,
        "dtr": 0.0,
        "IODE_SF2": int_of(satellite, "iodc"),
        "IODE_SF3": int_of(satellite, "iodc"),
        "code_on_L2": int(get_upload_value(satellite, "L2_chan_code", "1")),
        "L2_P_data_flag": int(get_upload_value(satellite, "L2_chan_flag", "0")),
        "SV_accuracy": int(get_upload_value(satellite, "URA", "0")),
        "SV_health": sv_health,
        "TGD": float_of(satellite, "group_delay_Tgd"),
        "IODC": int_of(satellite, "iodc"),
        "AODO": 0,
        "fit_interval_flag": bool_text(False),
        "spare1": 0.0,
        "spare2": 0.0,
        "integrity_status_flag": int(get_upload_value(satellite, "integrity_status", "0")),
        "alert_flag": int(get_upload_value(satellite, "alert_bit", "0")),
        "antispoofing_flag": int(get_upload_value(satellite, "anti_spoof_bit", "0")),
    }


def format_value(value):
    if isinstance(value, float):
        return f"{value:.17e}"
    return str(value)


def write_ephemeris_xml(ephemerides, output_path):
    fields = [
        "PRN", "M_0", "delta_n", "ecc", "sqrtA", "OMEGA_0", "i_0", "omega",
        "OMEGAdot", "idot", "Cuc", "Cus", "Crc", "Crs", "Cic", "Cis", "toe",
        "toc", "af0", "af1", "af2", "WN", "tow", "satClkDrift", "dtr",
        "IODE_SF2", "IODE_SF3", "code_on_L2", "L2_P_data_flag", "SV_accuracy",
        "SV_health", "TGD", "IODC", "AODO", "fit_interval_flag", "spare1",
        "spare2", "integrity_status_flag", "alert_flag", "antispoofing_flag",
    ]

    lines = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>',
        '<!DOCTYPE boost_serialization>',
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
        for field in fields:
            lines.append(f"\t\t\t<{field}>{format_value(eph[field])}</{field}>")
        lines.extend(["\t\t</second>", "\t</item>"])

    lines.extend(["</GNSS-SDR_ephemeris_map>", "</boost_serialization>", ""])
    output_path.write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--target-toe",
        type=float,
        default=None,
        help="Optional TOE/TOW to write after advancing M0 from the scenario TOA. By default, keep each satellite's source TOA.",
    )
    parser.add_argument(
        "--max-sqrt-a",
        type=float,
        default=0.0,
        help="Optional maximum SQRT_A filter. Values <= 0 disable filtering.",
    )
    args = parser.parse_args()

    root = ET.parse(args.input).getroot()
    ephemerides = []
    for satellite in root.findall("satellite"):
        if text_of(satellite, "enabled", "no").lower() != "yes":
            continue
        sqrt_a = float_of(satellite, "SQRT_A")
        if args.max_sqrt_a > 0.0 and sqrt_a >= args.max_sqrt_a:
            continue
        ephemerides.append(ephemeris_from_satellite(satellite, args.target_toe))

    ephemerides.sort(key=lambda eph: eph["PRN"])
    write_ephemeris_xml(ephemerides, args.output)
    print(f"Wrote {len(ephemerides)} Mars GPS ephemerides to {args.output}")


if __name__ == "__main__":
    main()
