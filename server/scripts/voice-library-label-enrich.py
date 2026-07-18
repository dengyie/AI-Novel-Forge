#!/usr/bin/env python3
"""Enrich VoiceAsset tags: planner L1 + acoustic L2 (labeled-v2).

Safety:
  - tags + updatedAt only (never status / review / primaryFile / audio)
  - skip archived|deprecated and e2e fixtures
  - speaker-level cluster broadcast (role, not per-clip identity)
  - machine never assigns lead (lead is human/whitelist only)
  - acoustic failure → ac-fail, no fake L2 bands
  - registry file lock + .part atomic replace + timestamped backup

Usage (on pxed, novel-server host):
  python3 server/scripts/voice-library-label-enrich.py --dry-run
  python3 server/scripts/voice-library-label-enrich.py
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import struct
import sys
import time
import wave
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_REG = Path("/personal/pxed/ai-novel/server/storage/voice-refs/global/registry.json")
DEFAULT_ROOT = Path("/personal/pxed/ai-novel/server/storage/voice-refs")
LABEL_VERSION = "labeled-v2"

GENDER = {"male", "female", "unknown"}
CLUSTERS = {"lead", "cast", "extra", "narrator"}
PITCH = {"pitch-high", "pitch-mid", "pitch-low"}
TEXTURE = {
    "texture-bright",
    "texture-neutral",
    "texture-dark_raspy",
    "texture-airy",
}
ENERGY = {"energy-lively", "energy-even", "energy-heavy"}

MANAGED_EXACT = GENDER | CLUSTERS | PITCH | TEXTURE | ENERGY | {
    "q-clean",
    "q-noisy",
    "q-clip",
    "q-quiet",
    "ac-fail",
    "labeled-v1",
    "labeled-v2",
    "style-narration",
    "style-fast",
    "style-soft",
    "role-youth",
    "role-executor",
    "role-lead_f",
    "role-lead_m",
    "role-young_f",
    "role-accent",
    "role-general",
    "role-external_demo",
}

MANAGED_PREFIXES = (
    "pitch-",
    "texture-",
    "energy-",
    "q-",
    "cluster-",
    "labeled-v",
    "style-",
    "role-",
    "ac-",
)

# legacy free tags → planner cluster votes (lead never final from machine)
LEGACY_TO_CLUSTER = {
    "lead": "cast",  # demote auto-lead
    "lead_f": "cast",
    "lead_m": "cast",
    "cluster-lead_f": "cast",
    "cluster-lead_m": "cast",
    "cast": "cast",
    "cluster-cast": "cast",
    "executor": "cast",
    "cluster-executor": "cast",
    "young_f": "cast",
    "cluster-young_f": "cast",
    "youth": "cast",
    "cluster-youth": "cast",
    "narrator": "narrator",
    "cluster-narrator": "narrator",
    "extra": "extra",
    "cluster-extra": "extra",
    "general": "extra",
    "cluster-general": "extra",
    "accent": "extra",
    "cluster-accent": "extra",
    "external_demo": "extra",
    "cluster-external_demo": "extra",
}

LEGACY_ROLE_ALIAS = {
    "youth": "role-youth",
    "cluster-youth": "role-youth",
    "executor": "role-executor",
    "cluster-executor": "role-executor",
    "lead_f": "role-lead_f",
    "cluster-lead_f": "role-lead_f",
    "lead_m": "role-lead_m",
    "cluster-lead_m": "role-lead_m",
    "young_f": "role-young_f",
    "cluster-young_f": "role-young_f",
    "accent": "role-accent",
    "cluster-accent": "role-accent",
    "general": "role-general",
    "cluster-general": "role-general",
    "external_demo": "role-external_demo",
    "cluster-external_demo": "role-external_demo",
}

DISPLAY_NARR = re.compile(r"旁白|新闻|公文|narrator", re.I)
DISPLAY_CAST = re.compile(r"执行|少女|少年|清亮|温暖|导师|配|女主|男主|主角", re.I)
DISPLAY_FAST = re.compile(r"急促|快利落|rate-fast|快", re.I)
DISPLAY_SOFT = re.compile(r"轻声|偏软|冷静|慢暖", re.I)

# Optional human lead whitelist (slug). Empty = machine never emits lead.
LEAD_SLUG_WHITELIST: set[str] = set()

# Tie-break when speaker votes equal: cast > extra > narrator (never lead)
CLUSTER_TIE = {"cast": 3, "extra": 2, "narrator": 1, "lead": 0}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def should_skip_asset(asset: dict) -> str | None:
    status = (asset.get("status") or "").lower()
    if status in {"archived", "deprecated"}:
        return f"status={status}"
    slug = (asset.get("slug") or "").lower()
    if slug.startswith("e2e-") or slug.startswith("test-"):
        return "fixture-slug"
    pack = asset.get("packId")
    if pack in (None, "", "?") and slug.startswith("e2e"):
        return "fixture-pack"
    kind = asset.get("kind") or "clone_ref"
    if kind != "clone_ref":
        return f"kind={kind}"
    return None


def read_wav_mono(path: Path):
    with wave.open(str(path), "rb") as w:
        ch, sw, rate, nframes, comptype, _ = w.getparams()
        if sw != 2 or comptype != "NONE":
            return None
        raw = w.readframes(nframes)
    if not raw:
        return None
    n = len(raw) // 2
    samples = struct.unpack("<" + "h" * n, raw[: n * 2])
    if ch > 1:
        mono = []
        for i in range(0, len(samples), ch):
            mono.append(sum(samples[i : i + ch]) / ch)
        samples = mono
    xs = [s / 32768.0 for s in samples]
    return rate, xs


def acoustic_features(path: Path) -> dict[str, Any]:
    try:
        import numpy as np  # type: ignore
    except Exception:
        return {"ok": False, "reason": "numpy_missing"}

    data = read_wav_mono(path)
    if not data:
        return {"ok": False, "reason": "bad_wav"}
    rate, xs = data
    n = len(xs)
    if n < rate * 0.3:
        return {"ok": False, "reason": "too_short", "duration": round(n / rate, 3)}

    x = np.asarray(xs, dtype=np.float64)
    peak = float(np.max(np.abs(x)))
    rms = float(np.sqrt(np.mean(x * x)))
    silence = float(np.mean(np.abs(x) < (500 / 32768.0)))

    frame = max(1, int(rate * 0.02))
    sil_thr = 500 / 32768.0
    rms_frames = []
    speech_frames = []
    for i in range(0, n - frame, frame):
        seg = x[i : i + frame]
        fr = float(np.sqrt(np.mean(seg * seg)))
        rms_frames.append(fr)
        # dynamics on speech frames only; silence is quality, not energy band
        if float(np.mean(np.abs(seg))) >= sil_thr:
            speech_frames.append(fr)
    dyn_src = speech_frames if len(speech_frames) >= 5 else rms_frames
    rms_arr = np.asarray(dyn_src) if dyn_src else np.asarray([rms])
    energy_cv = float(np.std(rms_arr) / (np.mean(rms_arr) + 1e-9))

    mid = n // 2
    win = min(n, int(rate * 0.5))
    start = max(0, mid - win // 2)
    seg = x[start : start + win]
    if len(seg) < 256:
        seg = x
    w = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(len(seg)) / max(len(seg) - 1, 1))
    spec = np.abs(np.fft.rfft(seg * w))
    freqs = np.fft.rfftfreq(len(seg), d=1.0 / rate)
    denom = float(np.sum(spec) + 1e-12)
    centroid = float(np.sum(freqs * spec) / denom)
    zcr = float(np.mean(np.abs(np.diff(np.signbit(x).astype(np.int8)))))

    f0s = []
    fmin, fmax = 70.0, 350.0
    min_lag, max_lag = int(rate / fmax), int(rate / fmin)
    for i in range(0, n - frame * 4, frame * 4):
        seg = x[i : i + frame * 4]
        if float(np.sqrt(np.mean(seg * seg))) < 0.01:
            continue
        seg = seg - np.mean(seg)
        ac = np.correlate(seg, seg, mode="full")
        ac = ac[len(ac) // 2 :]
        if len(ac) <= max_lag:
            continue
        ac = ac / (ac[0] + 1e-12)
        region = ac[min_lag:max_lag]
        if len(region) == 0:
            continue
        j = int(np.argmax(region))
        if region[j] < 0.3:
            continue
        lag = min_lag + j
        f0s.append(rate / lag)
    f0_med = float(np.median(f0s)) if f0s else None

    if f0_med is None:
        pitch = "pitch-mid"
        pitch_src = "default"
    elif f0_med >= 210:
        pitch = "pitch-high"
        pitch_src = "f0"
    elif f0_med <= 140:
        pitch = "pitch-low"
        pitch_src = "f0"
    else:
        pitch = "pitch-mid"
        pitch_src = "f0"

    if centroid >= 2200 or zcr >= 0.12:
        texture = "texture-bright"
    elif centroid <= 1200 and zcr <= 0.06:
        texture = "texture-dark_raspy"
    elif centroid <= 1400 and silence > 0.45:
        texture = "texture-airy"
    else:
        texture = "texture-neutral"

    # Energy from speech-frame dynamics only (silence → quality tags).
    # Thresholds calibrated on production corpus speech-only CV (med≈0.41).
    if energy_cv >= 0.45:
        energy = "energy-lively"
    elif energy_cv <= 0.22:
        energy = "energy-heavy"
    else:
        energy = "energy-even"

    q: list[str] = []
    if peak >= 0.99:
        q.append("q-clip")
    if rms < 0.015:
        q.append("q-quiet")
    if silence > 0.75:
        q.append("q-noisy")
    if not q:
        q.append("q-clean")

    return {
        "ok": True,
        "duration": round(n / rate, 3),
        "rate": rate,
        "peak": round(peak, 4),
        "rms": round(rms, 4),
        "silence": round(silence, 4),
        "energy_cv": round(energy_cv, 4),
        "centroid": round(centroid, 1),
        "zcr": round(zcr, 4),
        "f0_med": None if f0_med is None else round(f0_med, 1),
        "pitch": pitch,
        "pitch_src": pitch_src,
        "texture": texture,
        "energy": energy,
        "quality": q,
    }


def infer_gender(tags: list[str], display: str, ac: dict) -> str:
    tset = {t.lower() for t in tags}
    for g in ("female", "male", "unknown"):
        if g in tset:
            return g
    if re.search(r"女|小姐|姑娘", display):
        return "female"
    if re.search(r"男|公子|少爷", display):
        return "male"
    f0 = ac.get("f0_med")
    if isinstance(f0, (int, float)):
        if f0 >= 180:
            return "female"
        if f0 <= 150:
            return "male"
    return "unknown"


def provisional_cluster_vote(tags: list[str], display: str, ac: dict) -> Counter:
    """Per-clip votes only. lead is remapped to cast (no machine lead)."""
    tset = {t.lower() for t in tags}
    votes: Counter = Counter()
    for t in tset:
        if t in LEGACY_TO_CLUSTER:
            votes[LEGACY_TO_CLUSTER[t]] += 2
    if DISPLAY_NARR.search(display):
        votes["narrator"] += 3
    if DISPLAY_CAST.search(display):
        votes["cast"] += 2
    # weak acoustic: long low steady → narrator hint only
    if (
        ac.get("ok")
        and ac.get("energy") == "energy-heavy"
        and ac.get("pitch") == "pitch-low"
        and float(ac.get("duration") or 0) >= 6
    ):
        votes["narrator"] += 1
    if ac.get("ok") and ac.get("pitch") == "pitch-high" and ac.get("texture") == "texture-bright":
        votes["cast"] += 1
    if not votes:
        votes["extra"] += 1
    # never keep lead in votes
    if votes.get("lead"):
        votes["cast"] += votes.pop("lead")
    return votes


def pick_cluster(votes: Counter) -> str:
    if not votes:
        return "extra"
    # drop lead if any
    if "lead" in votes:
        votes = Counter(votes)
        votes["cast"] += votes.pop("lead", 0)
    best = sorted(
        votes.items(),
        key=lambda kv: (kv[1], CLUSTER_TIE.get(kv[0], 0)),
        reverse=True,
    )[0][0]
    if best == "lead":
        return "cast"
    return best


def style_tags(display: str, tags: list[str]) -> list[str]:
    out = []
    tset = {t.lower() for t in tags}
    if DISPLAY_NARR.search(display) or "旁白" in display:
        out.append("style-narration")
    if DISPLAY_FAST.search(display) or "rate-fast" in tset:
        out.append("style-fast")
    if DISPLAY_SOFT.search(display):
        out.append("style-soft")
    return out


def role_aliases(tags: list[str]) -> list[str]:
    out = []
    for t in tags:
        tl = t.lower()
        if tl in LEGACY_ROLE_ALIAS:
            out.append(LEGACY_ROLE_ALIAS[tl])
    return out


def is_managed(tag: str) -> bool:
    t = tag.lower()
    if t in MANAGED_EXACT:
        return True
    for p in MANAGED_PREFIXES:
        if t.startswith(p):
            return True
    if t in LEGACY_TO_CLUSTER:
        return True
    return False


def speaker_key(tags: list[str], asset: dict) -> str:
    for t in tags:
        if t.lower().startswith("speaker:"):
            return t.lower()
    # fallback: slug stem so multi-clip still groups poorly but not collide all
    return f"asset:{asset.get('id')}"


def rebuild_tags(
    asset: dict,
    ac: dict,
    cluster: str,
    gender: str,
) -> list[str]:
    old = [str(t).strip() for t in (asset.get("tags") or []) if str(t).strip()]
    display = asset.get("displayName") or asset.get("slug") or ""
    slug = asset.get("slug") or ""

    # optional whitelist may force lead
    if slug in LEAD_SLUG_WHITELIST:
        cluster = "lead"
    elif cluster == "lead":
        cluster = "cast"

    preserved: list[str] = []
    seen: set[str] = set()
    for t in old:
        tl = t.lower()
        if is_managed(t):
            continue
        if tl not in seen:
            preserved.append(tl)
            seen.add(tl)

    for alias in role_aliases(old):
        if alias not in seen:
            preserved.append(alias)
            seen.add(alias)

    for st in style_tags(display, old):
        if st not in seen:
            preserved.append(st)
            seen.add(st)

    core = [gender, cluster, LABEL_VERSION]
    if ac.get("ok"):
        core += [ac["pitch"], ac["texture"], ac["energy"]]
        core += list(ac.get("quality") or [])
    else:
        core.append("ac-fail")

    if not any(t.startswith("scope-") for t in preserved):
        if any(t == "lang-en" or t.startswith("scope-en") for t in old):
            preserved.append("scope-en")
        elif any("mixed" in t.lower() for t in old):
            preserved.append("scope-mixed")
        else:
            preserved.append("scope-zh")
    if not any(t.startswith("lang-") for t in preserved):
        if "scope-en" in preserved:
            preserved.append("lang-en")
        elif "scope-mixed" in preserved:
            preserved.append("lang-mixed")
        else:
            preserved.append("lang-zh")

    for m in ("clone_ref", "candidate"):
        if m not in preserved and m in {t.lower() for t in old}:
            preserved.append(m)
    if asset.get("packId") == "zh-pilot-20260718" and "zh-pilot" not in preserved:
        preserved.append("zh-pilot")
    if asset.get("packId") == "external-expand-20260718" and "external" not in preserved:
        preserved.append("external")

    dur = None
    pf = asset.get("primaryFile") or {}
    if pf.get("durationSec") is not None:
        try:
            dur = float(pf["durationSec"])
        except Exception:
            dur = None
    if dur is None and ac.get("duration") is not None:
        try:
            dur = float(ac["duration"])
        except Exception:
            dur = None
    if dur is not None and not any(t.startswith("dur-") for t in preserved):
        preserved.append(f"dur-{dur:.1f}"[:16])

    ordered: list[str] = []
    for t in core + preserved:
        tl = t.lower().strip()
        if not tl or len(tl) > 40:
            continue
        if tl not in {x.lower() for x in ordered}:
            ordered.append(tl)
        if len(ordered) >= 32:
            break
    return ordered


def with_lock(lock_path: Path, fn, wait_s: float = 60.0):
    started = time.time()
    while True:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            try:
                os.write(fd, str(os.getpid()).encode())
                return fn()
            finally:
                os.close(fd)
                try:
                    lock_path.unlink()
                except FileNotFoundError:
                    pass
        except FileExistsError:
            try:
                st = lock_path.stat()
                if time.time() - st.st_mtime > 120:
                    lock_path.unlink()
                    continue
            except FileNotFoundError:
                continue
            if time.time() - started > wait_s:
                raise SystemExit("registry lock timeout")
            time.sleep(0.05)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--registry", type=Path, default=DEFAULT_REG)
    ap.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    ap.add_argument("--report", type=Path, default=Path("/tmp/voice-label-enrich-v2-report.json"))
    args = ap.parse_args()

    reg_path: Path = args.registry
    root: Path = args.root
    lock_path = Path(str(reg_path) + ".lock")

    reg = json.loads(reg_path.read_text(encoding="utf-8"))
    assets: list[dict] = list(reg.get("assets") or [])
    print(f"assets={len(assets)} dry={args.dry_run} label={LABEL_VERSION}", flush=True)

    ts = datetime.now().strftime("%Y%m%d%H%M%S")
    bak = reg_path.parent / f"registry.json.bak-label-v2-{ts}"
    bak.write_text(json.dumps(reg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("backup", bak, flush=True)

    report: dict[str, Any] = {
        "backup": str(bak),
        "dry": args.dry_run,
        "label": LABEL_VERSION,
        "skipped": 0,
        "changed": 0,
        "unchanged": 0,
        "ac_fail": 0,
        "cluster": Counter(),
        "gender": Counter(),
        "pitch": Counter(),
        "texture": Counter(),
        "energy": Counter(),
        "speaker_inconsistent_before_broadcast": 0,
        "samples": [],
        "errors": [],
        "skip_reasons": Counter(),
    }

    # Pass 1: features + provisional votes
    work: list[dict[str, Any]] = []
    speaker_votes: dict[str, Counter] = defaultdict(Counter)

    for i, a in enumerate(assets):
        reason = should_skip_asset(a)
        if reason:
            report["skipped"] += 1
            report["skip_reasons"][reason] += 1
            work.append({"asset": a, "skip": reason})
            continue

        old_tags = [str(t).strip() for t in (a.get("tags") or []) if str(t).strip()]
        display = a.get("displayName") or a.get("slug") or ""
        pf = a.get("primaryFile") or {}
        rel = pf.get("path")
        ac: dict[str, Any] = {"ok": False, "reason": "no_file"}
        if rel:
            path = root / rel
            if path.exists():
                try:
                    ac = acoustic_features(path)
                except Exception as e:
                    ac = {"ok": False, "reason": f"err:{e}"}
                    report["errors"].append({"id": a.get("id"), "err": str(e)})
            else:
                ac = {"ok": False, "reason": "missing_file"}
        if not ac.get("ok"):
            report["ac_fail"] += 1

        gender = infer_gender(old_tags, display, ac)
        votes = provisional_cluster_vote(old_tags, display, ac)
        sp = speaker_key(old_tags, a)
        speaker_votes[sp] += votes

        work.append(
            {
                "asset": a,
                "skip": None,
                "ac": ac,
                "gender": gender,
                "votes": votes,
                "speaker": sp,
                "old_tags": old_tags,
            }
        )
        if (i + 1) % 50 == 0:
            print(f"pass1 {i+1}/{len(assets)} ac_fail={report['ac_fail']}", flush=True)

    # Speaker final cluster
    speaker_cluster: dict[str, str] = {}
    for sp, votes in speaker_votes.items():
        speaker_cluster[sp] = pick_cluster(Counter(votes))

    # Measure pre-broadcast inconsistency from provisional top vote per clip
    by_sp_prev: dict[str, set[str]] = defaultdict(set)
    for w in work:
        if w.get("skip"):
            continue
        top = pick_cluster(Counter(w["votes"]))
        by_sp_prev[w["speaker"]].add(top)
    report["speaker_inconsistent_before_broadcast"] = sum(
        1 for s, v in by_sp_prev.items() if len(v) > 1
    )

    # Pass 2: rebuild tags with broadcast cluster
    tag_by_id: dict[str, list[str]] = {}
    for w in work:
        a = w["asset"]
        if w.get("skip"):
            continue
        cluster = speaker_cluster[w["speaker"]]
        tags = rebuild_tags(a, w["ac"], cluster, w["gender"])
        tag_by_id[a["id"]] = tags
        old_norm = [t.lower() for t in w["old_tags"]]
        changed = tags != old_norm
        if changed:
            report["changed"] += 1
        else:
            report["unchanged"] += 1
        tset = set(tags)
        for g in GENDER:
            if g in tset:
                report["gender"][g] += 1
        for c in CLUSTERS:
            if c in tset:
                report["cluster"][c] += 1
        for p in PITCH:
            if p in tset:
                report["pitch"][p] += 1
        for p in TEXTURE:
            if p in tset:
                report["texture"][p] += 1
        for p in ENERGY:
            if p in tset:
                report["energy"][p] += 1
        if len(report["samples"]) < 15 and changed:
            report["samples"].append(
                {
                    "id": a.get("id"),
                    "slug": a.get("slug"),
                    "status": a.get("status"),
                    "speaker": w["speaker"],
                    "cluster": cluster,
                    "old": old_norm,
                    "new": tags,
                    "ac": {
                        k: w["ac"].get(k)
                        for k in (
                            "ok",
                            "reason",
                            "f0_med",
                            "centroid",
                            "energy_cv",
                            "silence",
                            "pitch",
                            "texture",
                            "energy",
                        )
                    },
                }
            )

    for k in ("cluster", "gender", "pitch", "texture", "energy", "skip_reasons"):
        report[k] = dict(report[k])

    # Post-check speaker consistency on new tags
    by_sp_new: dict[str, set[str]] = defaultdict(set)
    for w in work:
        if w.get("skip"):
            continue
        tags = tag_by_id[w["asset"]["id"]]
        cl = next((t for t in ("lead", "cast", "extra", "narrator") if t in tags), None)
        if cl:
            by_sp_new[w["speaker"]].add(cl)
    inconsistent = [(sp, sorted(v)) for sp, v in by_sp_new.items() if len(v) > 1]
    report["speaker_inconsistent_after"] = len(inconsistent)
    report["speaker_inconsistent_after_sample"] = inconsistent[:20]
    report["lead_count"] = report["cluster"].get("lead", 0)

    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = {
        "changed": report["changed"],
        "unchanged": report["unchanged"],
        "skipped": report["skipped"],
        "ac_fail": report["ac_fail"],
        "cluster": report["cluster"],
        "gender": report["gender"],
        "pitch": report["pitch"],
        "energy": report["energy"],
        "speaker_inconsistent_after": report["speaker_inconsistent_after"],
        "lead_count": report["lead_count"],
    }
    print(("DRY " if args.dry_run else "READY ") + json.dumps(summary, ensure_ascii=False), flush=True)

    if args.dry_run:
        return 0

    def write():
        live = json.loads(reg_path.read_text(encoding="utf-8"))
        merged = []
        for a in live.get("assets") or []:
            aid = a.get("id")
            if aid in tag_by_id:
                b = dict(a)
                b["tags"] = tag_by_id[aid]
                b["updatedAt"] = now_iso()
                merged.append(b)
            else:
                merged.append(a)
        out = {"version": 1, "updatedAt": now_iso(), "assets": merged}
        tmp = Path(str(reg_path) + ".part")
        tmp.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, reg_path)

    with_lock(lock_path, write)
    print("WRITE DONE", json.dumps(summary, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except BrokenPipeError:
        sys.exit(0)
