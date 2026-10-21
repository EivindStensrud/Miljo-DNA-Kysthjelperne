#!/usr/bin/env python3
"""
build_all.py  -  one command that (re)builds the whole website data from all project directories.
(MAIN script: lives in the home directory. See LAYOUT.txt.)

USAGE
    python build_all.py                          # every project
    python build_all.py Kysthjelperne_2025       # only this project (the merged files are still rebuilt)
    python build_all.py --list                   # show projects and what each one contains
    python build_all.py --lookup-names           # also ask Artsdatabanken for Norwegian species names (needs internet)
    python build_all.py --no-names               # skip the species-name step

WHAT IT DOES, per project (a sub-directory with a project.json):
    1. runs the project's own script, if project.json names one ("prepare": "prepare.py") - project-specific
       cleaning/conversion lives there, with the project directory as working directory
    2. "sampling_log" section -> sanitize_data.py   -> <project>/output/safe_sampling_data.csv
    3. "edna" section         -> build_edna_dataset.py -> docs/edna_*.csv  (rows of that project)
  then, once:
    4. merges every project's safe_sampling_data.csv into  docs/safe_sampling_data.csv
    5. makes sure every species in docs/edna_species_long.csv has a row in docs/taxon_names.csv
A project whose raw files are not there yet is skipped with a note (not an error).
"""
import argparse
import csv
import os
import subprocess
import sys
from collections import Counter
from pathlib import Path

import kyst_common as kc

PY = sys.executable
HOME = kc.HOME_DIR


def run(cmd, cwd=None, extra_env=None):
    env = dict(os.environ, **(extra_env or {}))
    print("   $", " ".join(str(c) for c in cmd))
    return subprocess.run([str(c) for c in cmd], cwd=cwd, env=env).returncode


def inputs_state(cfg, section, keys):
    """('ok' | 'none' | 'partial', [missing files]) for the raw files a section needs."""
    sec = cfg.get(section) or {}
    files = [kc.in_project(cfg, sec[k]) for k in keys if sec.get(k)]
    missing = [f for f in files if not f.exists()]
    if files and len(missing) == len(files):
        return "none", missing
    return ("partial" if missing else "ok"), missing


def sampling_input(cfg):
    return kc.in_project(cfg, (cfg.get("sampling_log") or {}).get("raw", "raw/raw_data.csv"))


def sampling_output(cfg):
    return kc.in_project(cfg, (cfg.get("sampling_log") or {}).get("output", "output/safe_sampling_data.csv"))


def describe(path, cfg):
    sl, ed = cfg.get("sampling_log"), cfg.get("edna")
    parts = []
    if sl:
        parts.append("sampling log " + ("(raw present)" if sampling_input(cfg).exists() else "(NO raw file yet)"))
    if ed:
        st, _ = inputs_state(cfg, "edna", ("metadata", "env", "species"))
        parts.append("eDNA " + {"ok": "(raw present)", "none": "(NO raw files yet)", "partial": "(SOME RAW FILES MISSING)"}[st])
    return f"{path.name:28} code={cfg['project']:26} " + (" + ".join(parts) or "nothing configured")


def merge_sampling_logs(projects):
    """docs/safe_sampling_data.csv = all projects' sanitized sampling logs, one header."""
    header, rows, per_project = None, [], {}
    for d, cfg in projects:
        if not cfg.get("sampling_log"):
            continue
        out = sampling_output(cfg)
        if not out.exists():
            continue
        with open(out, encoding="utf-8-sig", newline="") as f:
            reader = csv.reader(f, delimiter=";")
            h = next(reader, None)
            if h is None:
                continue
            if header is None:
                header = h
            elif h != header:
                sys.exit(f"ERROR: the columns of {out} differ from the other projects' sampling logs - they cannot be merged.\n"
                         f"  expected: {header}\n  found   : {h}")
            got = [r for r in reader if any(c.strip() for c in r)]
            per_project[d.name] = len(got)
            rows += got
    if header is None:
        return None
    dup = Counter(tuple(r) for r in rows)
    n_dup = sum(c - 1 for c in dup.values() if c > 1)
    kc.DOCS_DIR.mkdir(parents=True, exist_ok=True)
    target = kc.DOCS_DIR / "safe_sampling_data.csv"
    with open(target, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(header)
        w.writerows(rows)
    return target, per_project, n_dup


def main():
    ap = argparse.ArgumentParser(description="Rebuild the website data from all project directories.")
    ap.add_argument("projects", nargs="*", help="project directory names (default: all)")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--lookup-names", action="store_true", help="ask Artsdatabanken for Norwegian names (internet)")
    ap.add_argument("--no-names", action="store_true", help="skip the species-name step")
    args = ap.parse_args()

    projects = kc.find_projects()
    if not projects:
        sys.exit(f"No projects found. A project is a sub-directory of {HOME} that contains a project.json "
                 f"(copy _template/ to start one).")
    if args.list:
        for d, cfg in projects:
            print(describe(d, cfg))
        return
    if args.projects:
        wanted = {kc.resolve_project_dir(p).name for p in args.projects}
        selected = [(d, c) for d, c in projects if d.name in wanted]
    else:
        selected = projects

    summary, failed = [], []
    for d, cfg in selected:
        print(f"\n########## {d.name}  (code: {cfg['project']}) ##########")
        env = {"KYST_HOME": str(HOME), "KYST_PROJECT_DIR": str(d), "KYST_PROJECT": cfg["project"]}
        if cfg.get("prepare"):
            script = kc.in_project(cfg, cfg["prepare"])
            print(f" project script: {script.name}")
            if not script.exists():
                failed.append(d.name)
                print(f"!!! {script} not found")
                continue
            if run([PY, script], cwd=d, extra_env=env) != 0:
                failed.append(d.name)
                print("!!! project script failed - this project is skipped")
                continue

        did = []
        if cfg.get("sampling_log"):
            if sampling_input(cfg).exists():
                if run([PY, HOME / "sanitize_data.py", "--project-dir", d]) != 0:
                    failed.append(d.name + " (sampling log)")
                else:
                    did.append("sampling log")
            else:
                print(f" sampling log: no raw file yet ({sampling_input(cfg).relative_to(d) if d in sampling_input(cfg).parents else sampling_input(cfg)}) - skipped")
        if cfg.get("edna"):
            st, missing = inputs_state(cfg, "edna", ("metadata", "env", "species"))
            if st == "none":
                print(" eDNA: no raw files yet - skipped")
            elif st == "partial":
                failed.append(d.name + " (eDNA)")
                print("!!! eDNA: these files are missing: " + ", ".join(m.name for m in missing))
            elif run([PY, HOME / "build_edna_dataset.py", "--project-dir", d]) != 0:
                failed.append(d.name + " (eDNA)")
            else:
                did.append("eDNA")
        summary.append((d.name, did))

    print("\n########## merge ##########")
    merged = merge_sampling_logs(projects)
    if merged:
        target, per_project, n_dup = merged
        print(f" {target}: " + ", ".join(f"{k}: {v} rows" for k, v in per_project.items()) +
              f"  (total {sum(per_project.values())})")
        if n_dup:
            print(f" WARNING: {n_dup} identical rows appear more than once - do two projects overlap in time? "
                  f"(use date_from / date_to in project.json)")
    else:
        print(" no sampling logs to merge yet")

    if not args.no_names and (kc.DOCS_DIR / "edna_species_long.csv").exists():
        print("\n########## species names ##########")
        cmd = [PY, HOME / "fetch_taxon_names.py"] + ([] if args.lookup_names else ["--offline"])
        run(cmd)
        if not args.lookup_names:
            print(" (new species were only added to the list. Run  python fetch_taxon_names.py  to look up Norwegian names.)")

    print("\n================== SUMMARY ==================")
    for name, did in summary:
        print(f" {name:28} {', '.join(did) if did else 'nothing built'}")
    if failed:
        print("\n FAILED: " + "; ".join(failed))
    print(f"\n Website folder: {kc.DOCS_DIR}  (publish this folder; never publish private/ or any raw/ folder)")
    print("=============================================")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
