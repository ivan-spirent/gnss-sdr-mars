#!/usr/bin/env python3
"""Bake GPS LNAV ephemeris correction CSV values into a GNSS-SDR XML file."""

import argparse
import csv
import xml.etree.ElementTree as ET
from pathlib import Path


FIELD_MAP = {
    "delta_m0_rad": "M_0",
    "delta_omega0_rad": "OMEGA_0",
    "delta_i0_rad": "i_0",
    "delta_omega_rad": "omega",
    "delta_sqrtA": "sqrtA",
}


def parse_int(text):
    try:
        return int(float(text))
    except (TypeError, ValueError):
        return None


def load_corrections(path):
    corrections = {}
    with path.open(newline="", encoding="utf-8") as stream:
        rows = (line for line in stream if not line.lstrip().startswith("#"))
        reader = csv.DictReader(
            rows,
            fieldnames=[
                "prn",
                "delta_m0_rad",
                "delta_omega0_rad",
                "delta_i0_rad",
                "delta_omega_rad",
                "delta_sqrtA",
            ],
        )
        for row in reader:
            prn = parse_int(row.get("prn"))
            if prn is None:
                continue
            corrections[prn] = {
                key: float(row[key])
                for key in FIELD_MAP
                if row.get(key) not in (None, "")
            }
    return corrections


def format_float(value):
    return f"{value:.17e}"


def apply_corrections(input_xml, corrections, output_xml):
    tree = ET.parse(input_xml)
    root = tree.getroot()
    applied = []

    for item in root.findall(".//GNSS-SDR_ephemeris_map/item"):
        first = item.find("first")
        second = item.find("second")
        prn = parse_int(first.text if first is not None else None)
        if prn is None or second is None or prn not in corrections:
            continue

        for correction_key, eph_key in FIELD_MAP.items():
            element = second.find(eph_key)
            if element is None or element.text is None:
                continue
            element.text = format_float(float(element.text) + corrections[prn].get(correction_key, 0.0))
        applied.append(prn)

    output_xml.write_text(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n'
        "<!DOCTYPE boost_serialization>\n"
        + ET.tostring(root, encoding="unicode")
        + "\n",
        encoding="utf-8",
    )
    return applied


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_xml", type=Path)
    parser.add_argument("corrections_csv", type=Path)
    parser.add_argument("output_xml", type=Path)
    args = parser.parse_args()

    corrections = load_corrections(args.corrections_csv)
    applied = apply_corrections(args.input_xml, corrections, args.output_xml)
    print(f"Loaded {len(corrections)} correction rows from {args.corrections_csv}")
    print(f"Applied corrections to {len(applied)} ephemerides: {', '.join(str(prn) for prn in applied)}")
    print(f"Wrote corrected XML to {args.output_xml}")


if __name__ == "__main__":
    main()
