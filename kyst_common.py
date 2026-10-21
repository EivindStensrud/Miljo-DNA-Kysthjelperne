"""
kyst_common.py - shared helpers for the main scripts (do not run directly).

A PROJECT is any sub-directory of the home directory that contains a project.json file.
You can name the directories as you like (Kysthjelperne_2022, MyStudent_Fish, ...).
Directories whose name starts with "_" or "." (for example _template) are ignored.
"""
import json
import sys
from pathlib import Path

HOME_DIR = Path(__file__).resolve().parent          # the directory that holds the main scripts
DOCS_DIR = HOME_DIR / "docs"                        # everything in here is published on the website
PRIVATE_DIR = HOME_DIR / "private"                  # names + secret keys: NEVER published
PROJECT_FILE = "project.json"

TOP_KEYS = {"project", "description", "prepare", "sampling_log", "edna"}
SAMPLING_KEYS = {"raw", "output", "date_from", "date_to", "no_comments"}
EDNA_KEYS = {"metadata", "env", "species", "year", "extra_areas", "totp_one_means_below", "coord_decimals",
             "title", "author", "target_group", "description", "meta_columns", "env_columns"}


def _warn_unknown(found, allowed, where):
    bad = sorted(k for k in found if k not in allowed and not k.startswith("_"))
    if bad:
        print(f"WARNING: unknown setting(s) {bad} in {where} (typo? they are ignored)", file=sys.stderr)


def load_config(project_dir):
    path = Path(project_dir) / PROJECT_FILE
    try:
        cfg = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        sys.exit(f"ERROR: {path} not found")
    except json.JSONDecodeError as e:
        sys.exit(f"ERROR: {path} is not valid JSON ({e}). Check commas and quotation marks.")
    _warn_unknown(cfg, TOP_KEYS, str(path))
    if "remove_names" in (cfg.get("sampling_log") or {}):
        sys.exit(f"ERROR: remove \"remove_names\" from {path}. project.json is committed to git, so it must never contain "
                 f"personal names. Put them in private/names_to_remove.txt (or names_to_remove.txt in the project folder) - both are git-ignored.")
    _warn_unknown(cfg.get("sampling_log") or {}, SAMPLING_KEYS, f"{path} -> sampling_log")
    _warn_unknown(cfg.get("edna") or {}, EDNA_KEYS, f"{path} -> edna")
    cfg["_dir"] = Path(project_dir).resolve()
    cfg["project"] = cfg.get("project") or Path(project_dir).resolve().name
    return cfg


def resolve_project_dir(arg):
    """Accepts 'Kysthjelperne_2022' (relative to the home directory or to where you are) or a full path."""
    for cand in (Path(arg), HOME_DIR / arg):
        if (cand / PROJECT_FILE).exists():
            return cand.resolve()
    names = ", ".join(p.name for p, _ in find_projects()) or "none found"
    sys.exit(f"ERROR: no project '{arg}' (a project directory must contain {PROJECT_FILE}). Projects: {names}")


def find_projects():
    """All projects, sorted by directory name. Returns [(path, config)]."""
    out, codes = [], {}
    for d in sorted(HOME_DIR.iterdir(), key=lambda p: p.name.lower()):
        if not d.is_dir() or d.name.startswith(("_", ".")) or not (d / PROJECT_FILE).exists():
            continue
        cfg = load_config(d)
        if cfg["project"] in codes:
            sys.exit(f"ERROR: the project code '{cfg['project']}' is used by both {codes[cfg['project']]} and {d.name}. "
                     f"Codes must be unique ('project' in {PROJECT_FILE}).")
        codes[cfg["project"]] = d.name
        out.append((d, cfg))
    return out


def in_project(cfg, relative):
    """Resolve a path from project.json relative to the project directory."""
    p = Path(relative)
    return p if p.is_absolute() else (cfg["_dir"] / p).resolve()
