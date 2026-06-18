#!/usr/bin/env python3
"""Offline sync forensics for the Mars GPS L1 C/A scenario.

The script compares receiver tracking dumps against the simulator NAV text log.
It intentionally mirrors the GPS word assembly/parity path used by
gps_l1_ca_telemetry_decoder_gs.cc.
"""

from __future__ import annotations

import argparse
import glob
import os
import re
import statistics
import struct
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


GPS_PREAMBLE = "10001011"
TRACKING_RECORD = struct.Struct("<7fQ12fdI")


@dataclass
class TrackingDump:
    channel: int
    prn: int
    prompt_i: List[float]
    prompt_q: List[float]
    cn0: List[float]
    lock: List[float]
    doppler: List[float]
    code_freq: List[float]
    sample_counter: List[int]


@dataclass
class PreambleCandidate:
    ms_index: int
    corr: int


@dataclass
class DecodeTrial:
    prn: int
    start_ms: int
    polarity_inverted: bool
    ms_shift: int
    bit_shift: int
    parity_ok: int
    best_truth_matches: int
    best_truth_hamming: int
    best_truth_label: str
    words: List[int]
    parity: List[bool]
    bits: str


@dataclass
class TruthSubframe:
    time_text: str
    subframe_id: int
    words: List[int]


def rotl32(x: int, n: int) -> int:
    x &= 0xFFFFFFFF
    return ((x << n) & 0xFFFFFFFF) | (x >> (32 - n))


def gps_word_parity_check(gpsword: int) -> bool:
    d1 = gpsword & 0xFBFFBF00
    d2 = rotl32(gpsword, 1) & 0x07FFBF01
    d3 = rotl32(gpsword, 2) & 0xFC0F8100
    d4 = rotl32(gpsword, 3) & 0xF81FFE02
    d5 = rotl32(gpsword, 4) & 0xFC00000E
    d6 = rotl32(gpsword, 5) & 0x07F00001
    d7 = rotl32(gpsword, 6) & 0x00003000
    t = d1 ^ d2 ^ d3 ^ d4 ^ d5 ^ d6 ^ d7
    parity = t ^ rotl32(t, 6) ^ rotl32(t, 12) ^ rotl32(t, 18) ^ rotl32(t, 24)
    return (parity & 0x3F) == (gpsword & 0x3F)


def assemble_like_gnss_sdr(bits: Sequence[int]) -> Tuple[List[int], List[bool]]:
    words: List[int] = []
    parity: List[bool] = []
    prev = 0
    for word_start in range(0, len(bits) - 29, 30):
        raw = 0
        for bit in bits[word_start : word_start + 30]:
            raw = (raw << 1) | (1 if bit else 0)

        gps_word = raw
        if prev & 0x00000001:
            gps_word |= 0x40000000
        if prev & 0x00000002:
            gps_word |= 0x80000000
        if gps_word & 0x40000000:
            gps_word ^= 0x3FFFFFC0

        ok = gps_word_parity_check(gps_word)
        words.append(gps_word)
        parity.append(ok)
        prev = gps_word
    return words, parity


def word_bits(word: int) -> List[int]:
    return [(word >> shift) & 1 for shift in range(29, -1, -1)]


def truth_nav_bits(words: Sequence[int]) -> List[int]:
    bits: List[int] = []
    for word in words:
        bits.extend(word_bits(word & 0x3FFFFFFF))
    return bits


def truth_transmitted_bits(words: Sequence[int], initial_prev_word: int = 0) -> List[int]:
    """Reverse the decoder's previous-D30 data-bit inversion.

    The simulator log words are the GPS words after the D30* data-bit handling
    used by the decoder. The prompt signs see the transmitted 30-bit stream, so
    data bits 1..24 are inverted when the previous word's low bit would trigger
    GNSS-SDR's XOR mask.
    """

    bits: List[int] = []
    prev = initial_prev_word
    for word in words:
        raw = word & 0x3FFFFFFF
        if prev & 0x00000001:
            raw ^= 0x3FFFFFC0
        bits.extend(word_bits(raw))
        prev = word
    return bits


def parse_navtxt(path: str) -> Dict[int, List[Tuple[str, int, List[int]]]]:
    nav: Dict[int, List[Tuple[str, int, List[int]]]] = {}
    current_prn: Optional[int] = None
    current_key: Optional[Tuple[str, int]] = None
    current_words: List[int] = []

    prn_re = re.compile(r"Analysis is for SVID:\s+(\d+)")
    word_re = re.compile(r"\s*(\d+:\d+:\d+)\s+SUBFRAME\s+(\d+)\s+WORD\s+(\d+)\s+=\s+([0-9A-Fa-f]+)")

    def flush() -> None:
        nonlocal current_key, current_words
        if current_prn is not None and current_key is not None and len(current_words) == 10:
            nav.setdefault(current_prn, []).append((current_key[0], current_key[1], current_words[:]))
        current_key = None
        current_words = []

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            prn_match = prn_re.search(line)
            if prn_match:
                flush()
                current_prn = int(prn_match.group(1))
                continue

            word_match = word_re.match(line)
            if not word_match or current_prn is None:
                continue

            time_text = word_match.group(1)
            subframe_id = int(word_match.group(2))
            word_index = int(word_match.group(3))
            word = int(word_match.group(4), 16)
            key = (time_text, subframe_id)
            if current_key != key:
                flush()
                current_key = key
            if word_index == len(current_words) + 1:
                current_words.append(word)

    flush()
    return nav


def select_truth_subframe(
    truth: Sequence[Tuple[str, int, List[int]]],
    time_text: Optional[str],
    subframe_id: Optional[int],
) -> Optional[TruthSubframe]:
    if time_text is None and subframe_id is None:
        return None
    for item_time, item_subframe_id, words in truth:
        if time_text is not None and item_time != time_text:
            continue
        if subframe_id is not None and item_subframe_id != subframe_id:
            continue
        return TruthSubframe(item_time, item_subframe_id, words)
    return None


def previous_truth_word(
    truth: Sequence[Tuple[str, int, List[int]]],
    truth_choice: TruthSubframe,
) -> int:
    previous_word = 0
    for item_time, item_subframe_id, words in truth:
        if item_time == truth_choice.time_text and item_subframe_id == truth_choice.subframe_id:
            return previous_word
        if words:
            previous_word = words[-1]
    return 0


def read_tracking_dump(path: str) -> Optional[TrackingDump]:
    base = os.path.basename(path)
    channel_match = re.search(r"(\d+)\.dat$", base)
    channel = int(channel_match.group(1)) if channel_match else -1

    prompt_i: List[float] = []
    prompt_q: List[float] = []
    cn0: List[float] = []
    lock: List[float] = []
    doppler: List[float] = []
    code_freq: List[float] = []
    sample_counter: List[int] = []
    prn = -1

    with open(path, "rb") as f:
        data = f.read()
    usable = len(data) - (len(data) % TRACKING_RECORD.size)
    for off in range(0, usable, TRACKING_RECORD.size):
        rec = TRACKING_RECORD.unpack_from(data, off)
        prompt_i.append(rec[5])
        prompt_q.append(rec[6])
        sample_counter.append(rec[7])
        doppler.append(rec[9])
        code_freq.append(rec[11])
        cn0.append(rec[17])
        lock.append(rec[18])
        prn = rec[21]

    if not prompt_i:
        return None
    return TrackingDump(channel, prn, prompt_i, prompt_q, cn0, lock, doppler, code_freq, sample_counter)


def find_preamble_candidates(prompt_i: Sequence[float], threshold: int = 150) -> List[PreambleCandidate]:
    pattern: List[int] = []
    for bit_char in GPS_PREAMBLE:
        pattern.extend([1 if bit_char == "1" else 0] * 20)

    signs = [1 if x >= 0.0 else 0 for x in prompt_i]
    out: List[PreambleCandidate] = []
    for start in range(0, max(0, len(signs) - len(pattern) + 1)):
        matches = sum(1 for i, bit in enumerate(pattern) if signs[start + i] == bit)
        corr = 2 * matches - len(pattern)
        if abs(corr) >= threshold:
            out.append(PreambleCandidate(start, corr))
    return out


def nav_bits_from_prompt(prompt_i: Sequence[float], start_ms: int, bit_count: int, invert: bool) -> Optional[List[int]]:
    if start_ms < 0 or start_ms + bit_count * 20 > len(prompt_i):
        return None
    bits: List[int] = []
    for bit_index in range(bit_count):
        window = prompt_i[start_ms + bit_index * 20 : start_ms + (bit_index + 1) * 20]
        bit = 1 if sum(window) >= 0.0 else 0
        if invert:
            bit ^= 1
        bits.append(bit)
    return bits


def compare_truth(words: Sequence[int], truth: Sequence[Tuple[str, int, List[int]]]) -> Tuple[int, int, str]:
    best_matches = -1
    best_hamming = 999999
    best_label = "none"
    for time_text, subframe_id, truth_words in truth:
        usable = min(len(words), len(truth_words))
        matches = sum(1 for i in range(usable) if (words[i] & 0x3FFFFFFF) == truth_words[i])
        hamming = sum(((words[i] & 0x3FFFFFFF) ^ truth_words[i]).bit_count() for i in range(usable))
        if matches > best_matches or (matches == best_matches and hamming < best_hamming):
            best_matches = matches
            best_hamming = hamming
            best_label = f"{time_text}/sf{subframe_id}"
    return max(best_matches, 0), best_hamming, best_label


def sweep_trials(prn: int, dump: TrackingDump, truth: Sequence[Tuple[str, int, List[int]]]) -> List[DecodeTrial]:
    candidates = find_preamble_candidates(dump.prompt_i)
    if not candidates:
        candidates = [PreambleCandidate(ms_index=offset, corr=0) for offset in range(0, min(20, len(dump.prompt_i)))]

    trials: List[DecodeTrial] = []
    seen = set()
    for cand in candidates[:12]:
        for polarity_inverted in (False, True):
            for ms_shift in (-1, 0, 1):
                for bit_shift in (-1, 0, 1):
                    start_ms = cand.ms_index + ms_shift + bit_shift * 20
                    key = (start_ms, polarity_inverted)
                    if key in seen:
                        continue
                    seen.add(key)
                    bits = nav_bits_from_prompt(dump.prompt_i, start_ms, 500, polarity_inverted)
                    if bits is None:
                        continue
                    words, parity = assemble_like_gnss_sdr(bits[:300])
                    matches, hamming, label = compare_truth(words, truth)
                    trials.append(
                        DecodeTrial(
                            prn=prn,
                            start_ms=start_ms,
                            polarity_inverted=polarity_inverted,
                            ms_shift=ms_shift,
                            bit_shift=bit_shift,
                            parity_ok=sum(1 for ok in parity if ok),
                            best_truth_matches=matches,
                            best_truth_hamming=hamming,
                            best_truth_label=label,
                            words=words,
                            parity=parity,
                            bits="".join("1" if bit else "0" for bit in bits),
                        )
                    )
    trials.sort(key=lambda t: (t.parity_ok, t.best_truth_matches, -t.best_truth_hamming), reverse=True)
    return trials


def fmt_median(values: Sequence[float]) -> str:
    if not values:
        return "n/a"
    return f"{statistics.median(values):.3f}"


def parse_diag_log(path: str) -> List[str]:
    if not path or not os.path.exists(path):
        return []
    lines: List[str] = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if "MARS_SYNC_DIAG" in line:
                lines.append(line.strip())
    return lines


def write_report(
    report_path: str,
    prns: Iterable[int],
    dumps_by_prn: Dict[int, TrackingDump],
    nav: Dict[int, List[Tuple[str, int, List[int]]]],
    diag_lines: Sequence[str],
) -> None:
    os.makedirs(os.path.dirname(report_path) or ".", exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as out:
        out.write("Mars GPS L1 C/A telemetry sync analysis\n")
        out.write("========================================\n\n")
        if diag_lines:
            out.write("Instrumented receiver events\n")
            out.write("----------------------------\n")
            for line in diag_lines[:200]:
                out.write(line + "\n")
            if len(diag_lines) > 200:
                out.write(f"... {len(diag_lines) - 200} more MARS_SYNC_DIAG lines omitted from this section\n")
            out.write("\n")

        for prn in prns:
            dump = dumps_by_prn.get(prn)
            truth = nav.get(prn, [])
            out.write(f"PRN {prn}\n")
            out.write("-" * (4 + len(str(prn))) + "\n")
            if dump is None:
                out.write("No tracking dump found.\n\n")
                continue

            out.write(
                "Tracking summary: "
                f"channel={dump.channel}, samples={len(dump.prompt_i)}, "
                f"CN0_median={fmt_median(dump.cn0)} dB-Hz, "
                f"carrier_lock_median={fmt_median(dump.lock)}, "
                f"doppler_median={fmt_median(dump.doppler)} Hz\n"
            )

            candidates = find_preamble_candidates(dump.prompt_i)
            out.write("Tracking preamble candidates (first 12): ")
            if candidates:
                out.write(
                    ", ".join(
                        f"ms={cand.ms_index},corr={cand.corr},inverted={cand.corr < 0}"
                        for cand in candidates[:12]
                    )
                )
            else:
                out.write("none above |corr|>=150")
            out.write("\n")

            trials = sweep_trials(prn, dump, truth)
            if not trials:
                out.write("No decodable 500-bit windows available in the dump.\n\n")
                continue

            best = trials[0]
            out.write(
                "Best robustness sweep: "
                f"start_ms={best.start_ms}, polarity_inverted={best.polarity_inverted}, "
                f"ms_shift={best.ms_shift}, bit_shift_20ms={best.bit_shift}, "
                f"parity_ok={best.parity_ok}/10, "
                f"truth_match={best.best_truth_matches}/10, "
                f"truth_hamming={best.best_truth_hamming}, "
                f"truth={best.best_truth_label}\n"
            )

            out.write("Top correction trials:\n")
            for trial in trials[:8]:
                out.write(
                    f"  start_ms={trial.start_ms:6d} inv={int(trial.polarity_inverted)} "
                    f"ms_shift={trial.ms_shift:+d} bit_shift_20ms={trial.bit_shift:+d} "
                    f"parity={trial.parity_ok}/10 truth={trial.best_truth_matches}/10 "
                    f"hamming={trial.best_truth_hamming} label={trial.best_truth_label}\n"
                )

            out.write("Word assembly for best trial:\n")
            expected_words: List[int] = []
            for time_text, subframe_id, words in truth:
                if f"{time_text}/sf{subframe_id}" == best.best_truth_label:
                    expected_words = words
                    break
            for index, word in enumerate(best.words[:10], start=1):
                expected = expected_words[index - 1] if index - 1 < len(expected_words) else None
                if expected is None:
                    expected_text = "n/a"
                    bit_offset = "n/a"
                else:
                    expected_text = f"{expected:08X}"
                    bit_offset = "0" if (word & 0x3FFFFFFF) == expected else "mismatch"
                out.write(
                    f"  word={index:02d} recovered={word & 0x3FFFFFFF:08X} "
                    f"expected={expected_text} parity={int(best.parity[index - 1])} "
                    f"truth_bit_offset={bit_offset}\n"
                )

            out.write(f"First 500 recovered NAV bits after best preamble:\n{best.bits[:500]}\n\n")


def write_timeline(
    report_path: str,
    csv_path: str,
    prn: int,
    dump: TrackingDump,
    truth: Sequence[Tuple[str, int, List[int]]],
    truth_choice: Optional[TruthSubframe],
    start_ms: Optional[int],
    bits_to_show: int,
) -> None:
    candidates = find_preamble_candidates(dump.prompt_i)
    exact_candidates = [cand for cand in candidates if abs(cand.corr) == 160]
    selected = None
    if start_ms is not None:
        for cand in candidates:
            if cand.ms_index == start_ms:
                selected = cand
                break
        if selected is None:
            selected = PreambleCandidate(start_ms, 0)
    elif exact_candidates:
        selected = exact_candidates[0]
    elif candidates:
        selected = candidates[0]
    else:
        selected = PreambleCandidate(0, 0)

    polarity_inverted = selected.corr < 0
    rx_bits = nav_bits_from_prompt(dump.prompt_i, selected.ms_index, min(bits_to_show, 300), polarity_inverted)
    if rx_bits is None:
        raise ValueError(f"Not enough prompt samples after ms {selected.ms_index} for {bits_to_show} bits")

    if truth_choice is None:
        trials = sweep_trials(prn, dump, truth)
        if not trials:
            raise ValueError("Unable to infer truth epoch; pass --truth-time and --truth-subframe")
        label = trials[0].best_truth_label
        inferred_time, inferred_subframe = label.split("/sf")
        truth_choice = select_truth_subframe(truth, inferred_time, int(inferred_subframe))
        if truth_choice is None:
            raise ValueError(f"Unable to resolve inferred truth epoch {label}")

    expected_nav = truth_nav_bits(truth_choice.words)
    initial_prev_word = previous_truth_word(truth, truth_choice)
    expected_tx = truth_transmitted_bits(truth_choice.words, initial_prev_word)
    words, parity = assemble_like_gnss_sdr(rx_bits[:300])

    os.makedirs(os.path.dirname(report_path) or ".", exist_ok=True)
    os.makedirs(os.path.dirname(csv_path) or ".", exist_ok=True)

    with open(csv_path, "w", encoding="utf-8") as csv:
        csv.write(
            "bit_index,word_index,word_bit,start_ms,end_ms,prompt_signs,prompt_sum,"
            "raw_majority_bit,polarity_inverted,recovered_bit,truth_tx_bit,truth_nav_bit,match_tx\n"
        )
        for bit_index, rx_bit in enumerate(rx_bits):
            ms0 = selected.ms_index + bit_index * 20
            window = dump.prompt_i[ms0 : ms0 + 20]
            raw_bit = 1 if sum(window) >= 0.0 else 0
            signs = "".join("+" if value >= 0.0 else "-" for value in window)
            tx_bit = expected_tx[bit_index] if bit_index < len(expected_tx) else -1
            nav_bit = expected_nav[bit_index] if bit_index < len(expected_nav) else -1
            csv.write(
                f"{bit_index},{bit_index // 30 + 1},{bit_index % 30 + 1},"
                f"{ms0},{ms0 + 19},{signs},{sum(window):.3f},{raw_bit},"
                f"{int(polarity_inverted)},{rx_bit},{tx_bit},{nav_bit},{int(rx_bit == tx_bit)}\n"
            )

    first_mismatch = next((i for i, rx_bit in enumerate(rx_bits) if i < len(expected_tx) and rx_bit != expected_tx[i]), None)
    preamble_matches = sum(1 for i in range(min(8, len(rx_bits))) if rx_bits[i] == expected_tx[i])
    rows_in_markdown = min(bits_to_show, 90)

    with open(report_path, "w", encoding="utf-8") as out:
        out.write(f"Mars GPS L1 C/A PRN {prn} timeline\n")
        out.write("=" * (27 + len(str(prn))) + "\n\n")
        out.write(f"Tracking dump channel: {dump.channel}\n")
        out.write(f"Selected preamble ms index: {selected.ms_index}\n")
        out.write(f"Selected preamble correlation: {selected.corr}\n")
        out.write(f"Polarity inverted by selected preamble: {polarity_inverted}\n")
        out.write(
            "Nearby preamble candidates: "
            + ", ".join(f"ms={cand.ms_index},corr={cand.corr}" for cand in candidates[:12])
            + "\n"
        )
        out.write(
            f"Simulator truth epoch: {truth_choice.time_text} subframe {truth_choice.subframe_id}\n"
        )
        out.write(f"Simulator previous word seed: {initial_prev_word:08X}\n")
        out.write(f"Recovered word parity in selected 300-bit window: {sum(parity)}/{len(parity)}\n")
        if first_mismatch is None:
            out.write("First mismatch against transmitted truth: none in displayed range\n")
        else:
            out.write(
                "First mismatch against transmitted truth: "
                f"bit {first_mismatch} (word {first_mismatch // 30 + 1}, bit {first_mismatch % 30 + 1})\n"
            )
        out.write(f"Preamble bits matching transmitted truth: {preamble_matches}/8\n\n")

        out.write("Word Summary\n")
        out.write("------------\n")
        out.write("| Word | Recovered | Expected NAV | Parity | Bit matches tx |\n")
        out.write("|---:|---:|---:|---:|---:|\n")
        for word_index, word in enumerate(words[:10]):
            bit0 = word_index * 30
            bit1 = min(bit0 + 30, len(rx_bits), len(expected_tx))
            matches = sum(1 for i in range(bit0, bit1) if rx_bits[i] == expected_tx[i])
            expected_word = truth_choice.words[word_index] if word_index < len(truth_choice.words) else 0
            out.write(
                f"| {word_index + 1} | `{word & 0x3FFFFFFF:08X}` | `{expected_word:08X}` | "
                f"{int(parity[word_index]) if word_index < len(parity) else 0} | {matches}/{bit1 - bit0} |\n"
            )

        out.write("\nBit Timeline\n")
        out.write("------------\n")
        out.write("| Bit | Word.Bit | ms | 1 ms prompt signs | Rx | Truth tx | Truth NAV | Match |\n")
        out.write("|---:|---:|---:|---|---:|---:|---:|---:|\n")
        for bit_index, rx_bit in enumerate(rx_bits[:rows_in_markdown]):
            ms0 = selected.ms_index + bit_index * 20
            window = dump.prompt_i[ms0 : ms0 + 20]
            signs = "".join("+" if value >= 0.0 else "-" for value in window)
            tx_bit = expected_tx[bit_index] if bit_index < len(expected_tx) else -1
            nav_bit = expected_nav[bit_index] if bit_index < len(expected_nav) else -1
            out.write(
                f"| {bit_index} | {bit_index // 30 + 1}.{bit_index % 30 + 1} | "
                f"{ms0}-{ms0 + 19} | `{signs}` | {rx_bit} | {tx_bit} | {nav_bit} | "
                f"{int(rx_bit == tx_bit)} |\n"
            )

        out.write(f"\nFull CSV timeline: {csv_path}\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--navtxt", default="Scenario Data/GPS_L1_ca.navtxt")
    parser.add_argument("--tracking-glob", default="build/diag_tracking*.dat")
    parser.add_argument("--diag-log", default="")
    parser.add_argument("--report", default="build/mars_l1ca_sync_analysis.txt")
    parser.add_argument("--prns", nargs="+", type=int, default=[2, 16, 21])
    parser.add_argument("--timeline-prn", type=int)
    parser.add_argument("--timeline-start-ms", type=int)
    parser.add_argument("--truth-time")
    parser.add_argument("--truth-subframe", type=int)
    parser.add_argument("--timeline-bits", type=int, default=300)
    parser.add_argument("--timeline-report", default="build/mars_l1ca_timeline.md")
    parser.add_argument("--timeline-csv", default="build/mars_l1ca_timeline.csv")
    args = parser.parse_args()

    nav = parse_navtxt(args.navtxt)
    dumps: Dict[int, TrackingDump] = {}
    for path in sorted(glob.glob(args.tracking_glob)):
        dump = read_tracking_dump(path)
        if dump is not None and dump.prn in args.prns:
            dumps[dump.prn] = dump

    if args.timeline_prn is not None:
        if args.timeline_prn not in dumps:
            for path in sorted(glob.glob(args.tracking_glob)):
                dump = read_tracking_dump(path)
                if dump is not None and dump.prn == args.timeline_prn:
                    dumps[dump.prn] = dump
                    break
        dump = dumps.get(args.timeline_prn)
        if dump is None:
            raise SystemExit(f"No tracking dump found for PRN {args.timeline_prn}")
        truth_choice = select_truth_subframe(nav.get(args.timeline_prn, []), args.truth_time, args.truth_subframe)
        write_timeline(
            args.timeline_report,
            args.timeline_csv,
            args.timeline_prn,
            dump,
            nav.get(args.timeline_prn, []),
            truth_choice,
            args.timeline_start_ms,
            args.timeline_bits,
        )
        print(f"Wrote {args.timeline_report}")
        print(f"Wrote {args.timeline_csv}")

    diag_lines = parse_diag_log(args.diag_log)
    write_report(args.report, args.prns, dumps, nav, diag_lines)
    print(f"Wrote {args.report}")
    for prn in args.prns:
        if prn in dumps:
            trials = sweep_trials(prn, dumps[prn], nav.get(prn, []))
            best = trials[0] if trials else None
            if best:
                print(
                    f"PRN {prn}: best parity {best.parity_ok}/10, "
                    f"truth {best.best_truth_matches}/10 at {best.best_truth_label}, "
                    f"start_ms={best.start_ms}, inv={best.polarity_inverted}, "
                    f"ms_shift={best.ms_shift}, bit_shift_20ms={best.bit_shift}"
                )
        else:
            print(f"PRN {prn}: no tracking dump")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
