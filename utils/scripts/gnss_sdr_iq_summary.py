#!/usr/bin/env python3
"""Build a compact prompt I/Q summary from GNSS-SDR MARS_SYNC_DIAG logs."""

from __future__ import annotations

import argparse
import json
import math
import re
from collections import defaultdict
from pathlib import Path


FIELD_RE = re.compile(r"([A-Za-z0-9_]+)=([^\s]+)")
SUPPORTED_STAGES = {
    "tracking_emit_symbol",
    "tracking_post_lock_ms",
    "tracking_prompt_1ms",
}


def empty_stats() -> dict[str, float]:
    return {
        "samples": 0,
        "sumAbsI": 0.0,
        "sumAbsQ": 0.0,
        "sumPowerI": 0.0,
        "sumPowerQ": 0.0,
        "maxAbsI": 0.0,
        "maxAbsQ": 0.0,
    }


def parse_fields(line: str) -> dict[str, str]:
    return {key: value for key, value in FIELD_RE.findall(line)}


def add_sample(stats: dict[str, float], prompt_i: float, prompt_q: float) -> None:
    abs_i = abs(prompt_i)
    abs_q = abs(prompt_q)
    stats["samples"] += 1
    stats["sumAbsI"] += abs_i
    stats["sumAbsQ"] += abs_q
    stats["sumPowerI"] += prompt_i * prompt_i
    stats["sumPowerQ"] += prompt_q * prompt_q
    stats["maxAbsI"] = max(stats["maxAbsI"], abs_i)
    stats["maxAbsQ"] = max(stats["maxAbsQ"], abs_q)


def finite_float(value: str) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def build_summary(log_path: Path) -> dict[str, object]:
    channels: dict[tuple[int, int], dict[str, object]] = {}
    stage_totals: dict[str, int] = defaultdict(int)

    with log_path.open("r", encoding="utf-8", errors="replace") as source:
        for line in source:
            if "MARS_SYNC_DIAG" not in line or "prompt_i=" not in line or "prompt_q=" not in line:
                continue
            fields = parse_fields(line)
            stage = fields.get("stage", "")
            if stage not in SUPPORTED_STAGES:
                continue
            try:
                channel = int(fields["channel"])
                prn = int(fields["prn"])
            except (KeyError, ValueError):
                continue
            prompt_i = finite_float(fields.get("prompt_i", ""))
            prompt_q = finite_float(fields.get("prompt_q", ""))
            if prompt_i is None or prompt_q is None:
                continue

            key = (channel, prn)
            entry = channels.setdefault(
                key,
                {
                    "channel": channel,
                    "prn": prn,
                    "stages": {name: empty_stats() for name in sorted(SUPPORTED_STAGES)},
                },
            )
            add_sample(entry["stages"][stage], prompt_i, prompt_q)  # type: ignore[index]
            stage_totals[stage] += 1

    compact_channels = []
    for entry in sorted(channels.values(), key=lambda item: (item["channel"], item["prn"])):
        stages = {
            stage: stats
            for stage, stats in entry["stages"].items()  # type: ignore[union-attr]
            if stats["samples"] > 0
        }
        if stages:
            compact_channels.append(
                {
                    "channel": entry["channel"],
                    "prn": entry["prn"],
                    "stages": stages,
                }
            )

    return {
        "source": str(log_path),
        "dominance_thresholds": {
            "q_dominant_min_q_over_i": 1.25,
            "i_dominant_max_q_over_i": 0.8,
        },
        "stage_totals": dict(sorted(stage_totals.items())),
        "channels": compact_channels,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    summary = build_summary(args.log)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(
        f"Wrote {len(summary['channels'])} channel summaries to {args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
