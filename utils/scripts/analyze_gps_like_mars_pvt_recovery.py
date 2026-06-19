#!/usr/bin/env python3
"""Summarize Mars GPS-like NAV/PVT recovery diagnostics from GNSS-SDR logs."""

import argparse
import csv
import re
from collections import Counter, defaultdict
from pathlib import Path


KEY_VALUE_RE = re.compile(r"(\w+)=([^\s]+)")
SUBFRAME_BITS = 300
PREAMBLE_BITS = 8


def parse_key_values(line):
    return dict(KEY_VALUE_RE.findall(line))


def load_nav_bits(path):
    by_prn = defaultdict(list)
    with path.open(newline="", errors="replace") as stream:
        reader = csv.reader(stream)
        for row in reader:
            if not row or row[0].startswith("#"):
                continue
            if len(row) < 4:
                continue
            prn = int(row[0])
            by_prn[prn].append(
                {
                    "subframe_id": int(row[1]),
                    "tow_ms": int(row[2]),
                    "bits": row[3].strip(),
                }
            )
    for frames in by_prn.values():
        frames.sort(key=lambda item: item["tow_ms"])
    return by_prn


def load_visible_sat_data(path):
    rows = []
    with path.open(newline="", errors="replace") as stream:
        for _ in range(4):
            next(stream, None)
        reader = csv.DictReader(stream)
        for row in reader:
            try:
                prn = int(float(row["Sat_PRN"]))
                tow_ms = int(float(row["TOW_ms"]))
            except (KeyError, TypeError, ValueError):
                continue
            signal_text = row.get("Signal_dB Group A", "")
            if signal_text == "":
                continue
            try:
                signal_db = float(signal_text)
            except ValueError:
                continue
            if signal_db <= 0:
                continue
            rows.append(
                {
                    "tow_ms": tow_ms,
                    "channel": row.get("Channel", ""),
                    "prn": prn,
                    "elevation_deg": parse_float(row.get("Elevation")),
                    "azimuth_deg": parse_float(row.get("Azimuth")),
                    "doppler_hz": parse_float(row.get("Doppler_shift Group A")),
                    "range_m": parse_float(row.get("Range")),
                    "pseudorange_m": parse_float(row.get("P-Range Group A")),
                    "signal_db": signal_db,
                }
            )
    by_prn = defaultdict(list)
    for row in rows:
        by_prn[row["prn"]].append(row)
    for prn_rows in by_prn.values():
        prn_rows.sort(key=lambda item: item["tow_ms"])
    return by_prn


def parse_float(text):
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def best_score(bits, frames, start_bit=0):
    best = {"score": -1, "tow_ms": None, "subframe_id": None, "inverted": False}
    if not bits:
        return best
    inverted_bits = "".join("1" if bit == "0" else "0" for bit in bits)
    for frame in frames:
        truth = frame["bits"][start_bit : start_bit + len(bits)]
        if len(truth) != len(bits):
            continue
        normal_score = sum(a == b for a, b in zip(bits, truth))
        inverted_score = sum(a == b for a, b in zip(inverted_bits, truth))
        if normal_score > best["score"]:
            best = {
                "score": normal_score,
                "tow_ms": frame["tow_ms"],
                "subframe_id": frame["subframe_id"],
                "inverted": False,
            }
        if inverted_score > best["score"]:
            best = {
                "score": inverted_score,
                "tow_ms": frame["tow_ms"],
                "subframe_id": frame["subframe_id"],
                "inverted": True,
            }
    return best


def best_stream_offset(bits, frames):
    best = {"score": -1, "tow_ms": None, "bit_offset": None, "inverted": False}
    if not bits or not frames:
        return best
    stream = "".join(frame["bits"] for frame in frames)
    inverted_bits = "".join("1" if bit == "0" else "0" for bit in bits)
    if len(stream) < len(bits):
        return best
    for offset in range(0, len(stream) - len(bits) + 1):
        truth = stream[offset : offset + len(bits)]
        normal_score = sum(a == b for a, b in zip(bits, truth))
        inverted_score = sum(a == b for a, b in zip(inverted_bits, truth))
        frame_index = offset // SUBFRAME_BITS
        bit_offset = offset % SUBFRAME_BITS
        tow_ms = frames[frame_index]["tow_ms"] if frame_index < len(frames) else None
        if normal_score > best["score"]:
            best = {
                "score": normal_score,
                "tow_ms": tow_ms,
                "bit_offset": bit_offset,
                "inverted": False,
            }
        if inverted_score > best["score"]:
            best = {
                "score": inverted_score,
                "tow_ms": tow_ms,
                "bit_offset": bit_offset,
                "inverted": True,
            }
    return best


def load_crc_stats(prefix):
    stats = {}
    if not prefix:
        return stats
    for path in sorted(Path(prefix).parent.glob(Path(prefix).name + "_ch*.txt")):
        match = re.search(r"_ch(\d+)\.txt$", path.name)
        if not match:
            continue
        channel = int(match.group(1))
        lines = [line.strip() for line in path.read_text(errors="replace").splitlines() if line.strip()]
        if len(lines) < 2:
            continue
        numbers = [part.strip() for part in lines[-1].split("|")]
        if len(numbers) < 3:
            continue
        try:
            stats[channel] = {
                "tests": int(numbers[0]),
                "success": int(numbers[1]),
                "rate": float(numbers[2]),
            }
        except ValueError:
            continue
    return stats


def analyze_log(path, nav_bits):
    result = {
        "first_acq": {},
        "best_lock_candidate": {},
        "handoff": {},
        "subframe_attempt": {},
        "truth_rejects": defaultdict(list),
        "truth_accepts": defaultdict(list),
        "nav_messages": Counter(),
        "emit_symbols": defaultdict(dict),
    }
    with path.open(errors="replace") as stream:
        for line in stream:
            if "MARS_SYNC_DIAG" not in line and "New GPS NAV message received" not in line:
                continue

            if "New GPS NAV message received" in line:
                match = re.search(r"satellite GPS PRN (\d+)", line)
                if match:
                    result["nav_messages"][int(match.group(1))] += 1
                continue

            values = parse_key_values(line)
            stage = values.get("stage")
            if not stage or "prn" not in values:
                continue
            try:
                prn = int(values["prn"])
            except ValueError:
                continue

            if stage == "tracking_bit_candidate":
                if prn not in result["first_acq"]:
                    result["first_acq"][prn] = values.copy()
                score = parse_int(values.get("score_abs"), -1)
                current = result["best_lock_candidate"].get(prn)
                if current is None or score > parse_int(current.get("score_abs"), -1):
                    result["best_lock_candidate"][prn] = values.copy()
            elif stage == "tracking_preamble_lock_handoff":
                result["handoff"].setdefault(prn, values.copy())
            elif stage == "tracking_emit_symbol":
                index = parse_int(values.get("emitted_bit_count"), -1)
                if 0 <= index < SUBFRAME_BITS - PREAMBLE_BITS:
                    result["emit_symbols"][prn].setdefault(index, values.copy())
            elif stage == "tlm_subframe_attempt":
                result["subframe_attempt"].setdefault(prn, values.copy())
            elif stage == "assisted_nav_truth_reject":
                result["truth_rejects"][prn].append(values.copy())
            elif stage == "assisted_nav_truth_accept":
                result["truth_accepts"][prn].append(values.copy())

    result["axis_scores"] = compute_axis_scores(result["emit_symbols"], nav_bits)
    result["subframe_scores"] = compute_subframe_scores(result["subframe_attempt"], nav_bits)
    return result


def parse_int(text, default=0):
    try:
        return int(text)
    except (TypeError, ValueError):
        return default


def bits_from_emit(symbols, axis_name):
    bits = []
    for index in range(SUBFRAME_BITS - PREAMBLE_BITS):
        values = symbols.get(index)
        if values is None:
            return ""
        prompt_i = parse_float(values.get("prompt_i"))
        prompt_q = parse_float(values.get("prompt_q"))
        pll180 = parse_int(values.get("pll180"), 0) != 0
        if prompt_i is None or prompt_q is None:
            return ""
        if axis_name == "I_raw":
            bit = prompt_i > 0.0
        elif axis_name == "I_decoder":
            bit = (prompt_i > 0.0) ^ pll180
        elif axis_name == "Q_raw":
            bit = prompt_q > 0.0
        elif axis_name == "Q_decoder":
            bit = (prompt_q > 0.0) ^ pll180
        else:
            raise ValueError(axis_name)
        bits.append("1" if bit else "0")
    return "".join(bits)


def compute_axis_scores(emit_symbols, nav_bits):
    axis_scores = defaultdict(dict)
    for prn, symbols in emit_symbols.items():
        frames = nav_bits.get(prn, [])
        for axis_name in ("I_raw", "I_decoder", "Q_raw", "Q_decoder"):
            bits = bits_from_emit(symbols, axis_name)
            if not bits:
                continue
            boundary_score = best_score(bits, frames, start_bit=PREAMBLE_BITS)
            stream_score = best_stream_offset(bits, frames)
            axis_scores[prn][axis_name] = {
                "boundary": boundary_score,
                "stream": stream_score,
            }
    return axis_scores


def compute_subframe_scores(attempts, nav_bits):
    scores = {}
    for prn, values in attempts.items():
        bits = values.get("raw_recovered_bits") or values.get("recovered_bits") or ""
        frames = nav_bits.get(prn, [])
        scores[prn] = {
            "own_boundary": best_score(bits, frames, start_bit=0),
            "own_stream": best_stream_offset(bits, frames),
            "any_boundary": best_any_prn(bits, nav_bits),
        }
    return scores


def best_any_prn(bits, nav_bits):
    best = {"score": -1, "prn": None, "tow_ms": None, "subframe_id": None, "inverted": False}
    for prn, frames in nav_bits.items():
        score = best_score(bits, frames, start_bit=0)
        if score["score"] > best["score"]:
            best = dict(score)
            best["prn"] = prn
    return best


def nearest_sat_row(rows, tow_ms):
    if not rows:
        return None
    if tow_ms is None:
        return rows[0]
    return min(rows, key=lambda row: abs(row["tow_ms"] - tow_ms))


def format_float(value, digits=1):
    if value is None:
        return "n/a"
    return f"{value:.{digits}f}"


def print_report(visible, nav_bits, analysis, crc_stats):
    prns = sorted(set(visible) | set(nav_bits) | set(analysis["first_acq"]) | set(analysis["handoff"]))
    first_tow = min((rows[0]["tow_ms"] for rows in visible.values() if rows), default=None)
    print("Mars GPS-like PVT recovery diagnostic")
    if first_tow is not None:
        print(f"Visible PRNs at first sat-data epoch {first_tow} ms: {', '.join(map(str, sorted(visible)))}")
    print(f"NAV truth PRNs: {', '.join(map(str, sorted(nav_bits)))}")
    print()
    header = (
        "PRN  acq_dopp  truth_dopp  diff   lock  bitMajor  crc_ok/tests  "
        "nav_msgs  subfrm  axis  stream  conclusion"
    )
    print(header)
    print("-" * len(header))
    for prn in prns:
        acq = analysis["first_acq"].get(prn, {})
        handoff = analysis["handoff"].get(prn, {})
        lock = analysis["best_lock_candidate"].get(prn, {})
        acq_dopp = parse_float(acq.get("acq_doppler_hz"))
        handoff_tow = None
        row = nearest_sat_row(visible.get(prn, []), handoff_tow)
        truth_dopp = row["doppler_hz"] if row else None
        diff = acq_dopp - truth_dopp if acq_dopp is not None and truth_dopp is not None else None
        channel = parse_int(acq.get("channel"), parse_int(handoff.get("channel"), -1))
        crc = crc_stats.get(channel, {})
        crc_text = "n/a"
        if crc:
            crc_text = f"{crc['success']}/{crc['tests']}"
        lock_score = lock.get("score_abs", "n/a")
        bit_major = lock.get("bit_majority_lock", "n/a")
        subframe_score = analysis["subframe_scores"].get(prn, {}).get("own_boundary", {})
        subframe_text = score_text(subframe_score, SUBFRAME_BITS)
        best_axis_name, best_axis_score = best_axis(analysis["axis_scores"].get(prn, {}), "boundary")
        axis_text = "n/a" if best_axis_score is None else f"{best_axis_name}:{score_text(best_axis_score, SUBFRAME_BITS - PREAMBLE_BITS)}"
        best_stream_name, best_stream_score = best_axis(analysis["axis_scores"].get(prn, {}), "stream")
        stream_text = "n/a" if best_stream_score is None else f"{best_stream_name}:{score_text(best_stream_score, SUBFRAME_BITS - PREAMBLE_BITS)}"
        conclusion = classify_prn(prn, analysis, crc_stats, channel)
        print(
            f"{prn:>3}  {format_float(acq_dopp, 1):>8}  {format_float(truth_dopp, 1):>10}  "
            f"{format_float(diff, 1):>5}  {str(lock_score):>4}  {str(bit_major):>8}  "
            f"{crc_text:>12}  {analysis['nav_messages'][prn]:>8}  {subframe_text:>6}  "
            f"{axis_text:>10}  {stream_text:>10}  {conclusion}"
        )
    print()
    print("Legend: subfrm compares the first recovered 300-bit telemetry window to own-PRN NAV truth.")
    print("Axis compares emitted post-preamble prompt bits against own-PRN truth at the subframe boundary.")
    print("Stream compares the same prompt bits against every offset in the own-PRN NAV truth stream.")


def score_text(score, total):
    if not score or score.get("score", -1) < 0:
        return "n/a"
    suffix = "i" if score.get("inverted") else ""
    if score.get("bit_offset") is not None:
        return f"{score['score']}/{total}@{score['bit_offset']}{suffix}"
    return f"{score['score']}/{total}{suffix}"


def best_axis(axis_scores, key):
    best_name = None
    best_score = None
    for axis_name, scores in axis_scores.items():
        score = scores.get(key)
        if score is None:
            continue
        if best_score is None or score.get("score", -1) > best_score.get("score", -1):
            best_name = axis_name
            best_score = score
    return best_name, best_score


def classify_prn(prn, analysis, crc_stats, channel):
    if analysis["nav_messages"][prn] > 0:
        return "accepted NAV"
    crc = crc_stats.get(channel, {})
    if crc and crc.get("rate", 0.0) > 0.5:
        return "parity mostly OK, no NAV message observed"
    subframe = analysis["subframe_scores"].get(prn, {}).get("own_boundary", {})
    if subframe.get("score", -1) >= 295:
        return "truth match available, check TOW acceptance"
    axis_name, axis_score = best_axis(analysis["axis_scores"].get(prn, {}), "boundary")
    if axis_score and axis_score.get("score", -1) >= 295:
        return f"prompt axis rescue via {axis_name}"
    stream_name, stream_score = best_axis(analysis["axis_scores"].get(prn, {}), "stream")
    if stream_score and stream_score.get("score", -1) >= 295:
        return f"NAV bits correct but boundary shifted via {stream_name}"
    if prn in analysis["handoff"]:
        return "prompt-sign stream inconsistent with NAV truth"
    if prn in analysis["first_acq"]:
        return "acquired but no preamble handoff"
    return "not observed"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", required=True, type=Path, help="GNSS-SDR debug log")
    parser.add_argument("--navbits", required=True, type=Path, help="NAV truth CSV")
    parser.add_argument("--sat-data", required=True, type=Path, help="Spirent sat_data CSV")
    parser.add_argument("--crc-prefix", type=Path, help="CRC stats filename prefix")
    args = parser.parse_args()

    nav_bits = load_nav_bits(args.navbits)
    visible = load_visible_sat_data(args.sat_data)
    analysis = analyze_log(args.log, nav_bits)
    crc_stats = load_crc_stats(args.crc_prefix) if args.crc_prefix else {}
    print_report(visible, nav_bits, analysis, crc_stats)


if __name__ == "__main__":
    main()
