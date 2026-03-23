#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import shutil
from pathlib import Path


DEFAULT_SOURCE_ROOT = Path("/Users/aburkard/fun/madness_pyro")
APP_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = APP_ROOT / "data"
SEASON = 2026
LOGO_URL = "https://a.espncdn.com/combiner/i?img=/i/teamlogos/ncaa/500/{espn_id}.png&h=40&w=40"

TEAM_ALIASES = {
    "M": {
        "Utah State": "Utah St",
        "Iowa State": "Iowa St",
        "North Dakota State": "N Dakota St",
        "Prairie View A&M": "Prairie View",
        "Prairie View AM": "Prairie View",
        "Saint Louis": "St Louis",
        "Saint Mary's": "St Mary's CA",
        "Saint Mary's CA": "St Mary's CA",
    },
    "W": {
        "Iowa State": "Iowa St",
        "Michigan State": "Michigan St",
        "Oklahoma State": "Oklahoma St",
        "Ohio State": "Ohio St",
        "Missouri State": "Missouri St",
        "Southern": "Southern Univ",
        "UTSA": "UT San Antonio",
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", default=str(DEFAULT_SOURCE_ROOT))
    parser.add_argument("--season", type=int, default=SEASON)
    return parser.parse_args()


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def normalize_name(name: str) -> str:
    return name.strip().lower().replace(".", "").replace("&", "and")


def resolve_team_id(raw_name: str, team_id_by_name: dict[str, int], gender: str) -> int:
    canonical = TEAM_ALIASES.get(gender, {}).get(raw_name, raw_name)
    if canonical in team_id_by_name:
        return int(team_id_by_name[canonical])
    norm = normalize_name(canonical)
    normalized = {normalize_name(name): team_id for name, team_id in team_id_by_name.items()}
    if norm in normalized:
        return int(normalized[norm])
    contains = [
        team_id
        for name, team_id in team_id_by_name.items()
        if norm in normalize_name(name) or normalize_name(name) in norm
    ]
    if len(contains) == 1:
        return int(contains[0])
    raise KeyError(f"Could not resolve team name: {raw_name}")


def filter_prediction_csv(src: Path, dst: Path, season: int, valid_team_ids: set[int]) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    with src.open(newline="", encoding="utf-8") as f_in, dst.open("w", newline="", encoding="utf-8") as f_out:
        reader = csv.DictReader(f_in)
        writer = csv.DictWriter(f_out, fieldnames=["ID", "Pred"])
        writer.writeheader()
        for row in reader:
            season_s, a_s, b_s = row["ID"].split("_")
            if int(season_s) != season:
                continue
            a = int(a_s)
            b = int(b_s)
            if a in valid_team_ids and b in valid_team_ids:
                writer.writerow({"ID": row["ID"], "Pred": row["Pred"]})


def load_logo_crosswalk(source_root: Path, gender: str) -> dict[int, str]:
    rows = read_csv_rows(source_root / "data" / "kaggle_espn_id_crosswalk.csv")
    out: dict[int, str] = {}
    for row in rows:
        if row["gender"].strip().upper() != gender:
            continue
        kaggle_id = int(row["kaggle_id"])
        espn_raw = row["espn_id"].strip()
        if not espn_raw:
            continue
        espn_id = int(espn_raw)
        if espn_id <= 0:
            continue
        out[kaggle_id] = LOGO_URL.format(espn_id=espn_id)
    return out


def build_gender_bundle(source_root: Path, season: int, gender: str) -> dict[str, object]:
    data_2026 = source_root / "data" / "2026"
    team_rows = [r for r in read_csv_rows(data_2026 / f"{gender}Teams.csv")]
    seed_rows = [r for r in read_csv_rows(data_2026 / f"{gender}NCAATourneySeeds.csv") if int(r["Season"]) == season]
    slot_rows = [r for r in read_csv_rows(data_2026 / f"{gender}NCAATourneySlots.csv") if int(r["Season"]) == season]

    logos = load_logo_crosswalk(source_root, gender)
    teams = [
        {
            "id": int(r["TeamID"]),
            "name": r["TeamName"],
            "logoUrl": logos.get(int(r["TeamID"])),
        }
        for r in team_rows
    ]
    valid_ids = {t["id"] for t in teams}
    team_id_by_name = {t["name"]: t["id"] for t in teams}

    resolved_path = source_root / "tmp" / f"resolved_results_{gender.lower()}_20260322.csv"
    resolved_rows = read_csv_rows(resolved_path)
    resolved = {
        row["Slot"]: resolve_team_id(row["WinnerTeam"], team_id_by_name, gender)
        for row in resolved_rows
    }

    return {
        "gender": gender,
        "season": season,
        "teams": teams,
        "teamIds": sorted(valid_ids),
        "seeds": [{"seed": r["Seed"], "teamId": int(r["TeamID"])} for r in seed_rows],
        "slots": [{"slot": r["Slot"], "strong": r["StrongSeed"], "weak": r["WeakSeed"]} for r in slot_rows],
        "resolvedSlots": resolved,
    }


def main() -> None:
    args = parse_args()
    source_root = Path(args.source_root)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    manifest: dict[str, object] = {"season": args.season, "sourceRoot": str(source_root)}
    for gender, label in [("M", "men"), ("W", "women")]:
        bundle = build_gender_bundle(source_root, args.season, gender)
        write_json(DATA_DIR / f"{label}-meta.json", bundle)
        valid_ids = set(bundle["teamIds"])
        filter_prediction_csv(
            source_root / "submissions" / "2026_final_espn_futures_v3" / "submission.csv",
            DATA_DIR / f"{label}-our-default.csv",
            args.season,
            valid_ids,
        )
        filter_prediction_csv(
            source_root / "tmp" / "experts2026_median_submission.csv",
            DATA_DIR / f"{label}-benchmark-default.csv",
            args.season,
            valid_ids,
        )
        manifest[label] = {
            "meta": f"data/{label}-meta.json",
            "ourDefault": f"data/{label}-our-default.csv",
            "benchmarkDefault": f"data/{label}-benchmark-default.csv",
        }

    write_json(DATA_DIR / "manifest.json", manifest)


if __name__ == "__main__":
    main()
