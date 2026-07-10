#!/usr/bin/env python3
"""
Scan a Facebook data export for messages YOU sent that match a word list,
and write tasks.json — the queue the unsend tool works through.

Everything is driven by config.json + your own words.txt. Nothing is hardcoded.

Usage:
  python3 scan.py                    # uses ./config.json
  python3 scan.py --config my.json   # custom config path

Config (config.json):
  {
    "your_name":  "Jane Doe",                       // exactly as it appears in Messenger
    "export_dir": "./export/your_facebook_activity",// unzipped Facebook export
    "e2ee_zip":   "./messages.zip",                 // optional; see README
    "words_file": "./words.txt"
  }
"""

import argparse
import json
import re
import sys
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


def load_config(path):
    if not path.exists():
        sys.exit(f"No config found at {path}. Copy config.example.json → config.json and edit it.")
    cfg = json.loads(path.read_text())
    for key in ("your_name", "export_dir", "words_file"):
        if not cfg.get(key):
            sys.exit(f"config.json is missing required key: {key}")
    return cfg


def load_words(path):
    """One entry per line. Blank lines and #-comments ignored.
    Plain lines are matched as whole words, case-insensitively.
    Prefix a line with 're:' to supply your own regex fragment."""
    if not path.exists():
        sys.exit(f"No word list at {path}. Copy words.example.txt → words.txt and edit it.")
    patterns = []
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("re:"):
            patterns.append(line[3:].strip())
        else:
            patterns.append(r"\b" + re.escape(line) + r"\b")
    if not patterns:
        sys.exit(f"{path} has no usable entries.")
    return re.compile("|".join(patterns), re.I)


def decode_fb(text):
    """Facebook exports text as mojibake (latin-1 bytes of utf-8). Fix it."""
    if text is None:
        return None
    try:
        return text.encode("latin-1").decode("utf-8")
    except (UnicodeDecodeError, UnicodeEncodeError):
        return text


def find_hits(pattern, text):
    if not text:
        return []
    return [m.group(0) for m in pattern.finditer(text)]


def pick_search_word(hits):
    """Search term = shortest matched string (short terms still match longer
    variants / typos when searching inside the conversation)."""
    return min(hits, key=len).lower()


def fmt_utc(ts_ms):
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.json")
    args = ap.parse_args()

    here = Path(__file__).resolve().parent
    cfg = load_config(Path(args.config) if Path(args.config).is_absolute() else here / args.config)

    me = cfg["your_name"]
    export = (here / cfg["export_dir"]).resolve() if not Path(cfg["export_dir"]).is_absolute() else Path(cfg["export_dir"])
    words_path = (here / cfg["words_file"]) if not Path(cfg["words_file"]).is_absolute() else Path(cfg["words_file"])
    pattern = load_words(words_path)

    threads = {}

    def add_hit(thread_key, thread_id, title, participants, source, text, ts_ms):
        hits = find_hits(pattern, text)
        if not hits:
            return
        rec = threads.setdefault(thread_key, {
            "thread_id": thread_id, "thread_dir": thread_key, "source": source,
            "title": title, "participants": participants, "messages": [],
        })
        rec["messages"].append({
            "text": text, "timestamp_ms": ts_ms, "date_utc": fmt_utc(ts_ms),
            "search_word": pick_search_word(hits),
        })

    # ── Standard export threads ───────────────────────────────
    msg_root = export / "messages"
    if not msg_root.exists():
        sys.exit(f"No messages folder under {export}. Point export_dir at the unzipped "
                 f"'your_facebook_activity' folder.")
    for sub in ["inbox", "archived_threads", "filtered_threads", "e2ee_cutover"]:
        d = msg_root / sub
        if not d.exists():
            continue
        for convo in sorted(d.iterdir()):
            if not convo.is_dir():
                continue
            tid = convo.name.rsplit("_", 1)[-1]
            thread_id = tid if tid.isdigit() else None
            for mf in sorted(convo.glob("message_*.json")):
                try:
                    data = json.loads(mf.read_text())
                except (json.JSONDecodeError, OSError):
                    continue
                title = decode_fb(data.get("title", convo.name))
                participants = [decode_fb(p.get("name", "?")) for p in data.get("participants", [])]
                others = [p for p in participants if p != me]
                for m in data.get("messages", []):
                    if decode_fb(m.get("sender_name")) != me:
                        continue
                    content = decode_fb(m.get("content", ""))
                    ts = m.get("timestamp_ms")
                    if content and ts:
                        add_hit(convo.name, thread_id, title, others, sub, content, ts)

    # ── Optional E2EE Messenger download (a zip of per-thread JSON) ──
    e2ee = cfg.get("e2ee_zip")
    if e2ee:
        e2ee_path = (here / e2ee) if not Path(e2ee).is_absolute() else Path(e2ee)
        if e2ee_path.exists():
            with zipfile.ZipFile(e2ee_path) as z:
                for name in z.namelist():
                    if not name.endswith(".json"):
                        continue
                    try:
                        data = json.loads(z.read(name))
                    except json.JSONDecodeError:
                        continue
                    title = data.get("threadName", Path(name).stem)
                    others = [p for p in data.get("participants", []) if p != me]
                    for m in data.get("messages", []):
                        if m.get("senderName") != me or m.get("isUnsent"):
                            continue
                        text, ts = m.get("text", ""), m.get("timestamp")
                        if text and ts:
                            add_hit("e2ee:" + title, None, title, others, "e2ee_download", text, ts)

    # ── Group by search word, write tasks.json ────────────────
    out_threads = []
    for rec in threads.values():
        rec["messages"].sort(key=lambda m: m["timestamp_ms"])
        groups = defaultdict(list)
        for m in rec["messages"]:
            groups[m["search_word"]].append(m)
        rec["groups"] = [{"search_word": w, "expected_matches": len(ms), "messages": ms}
                         for w, ms in sorted(groups.items())]
        rec["message_count"] = len(rec["messages"])
        del rec["messages"]
        out_threads.append(rec)
    out_threads.sort(key=lambda t: -t["message_count"])

    total = sum(t["message_count"] for t in out_threads)
    output = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "me": me,
        "total_threads": len(out_threads),
        "total_messages": total,
        "threads": out_threads,
    }
    (here / "tasks.json").write_text(json.dumps(output, indent=2, ensure_ascii=False))

    print(f"Wrote tasks.json")
    print(f"Threads: {len(out_threads)}   Messages to clean up: {total}")
    print("Top threads:")
    for t in out_threads[:10]:
        who = t["title"] or ", ".join(t["participants"][:3])
        print(f"  {t['message_count']:4d}  {who}")


if __name__ == "__main__":
    main()
