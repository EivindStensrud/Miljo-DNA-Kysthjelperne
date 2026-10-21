#!/usr/bin/env python3
"""
fetch_taxon_names.py  -  look up Norwegian names for the species in your eDNA data (Artsdatabanken)
                         and keep them in an editable CSV: taxon_names.csv

USAGE
    (MAIN script: lives in the home directory and serves all projects. See LAYOUT.txt.)

    python fetch_taxon_names.py                          # docs/edna_species_long.csv -> docs/taxon_names.csv
    python fetch_taxon_names.py --species other.csv --names other_names.csv
    python fetch_taxon_names.py --offline                # only add new taxa to the CSV (no internet needed)
    python fetch_taxon_names.py --retry                  # ask again for taxa marked not_found / error
    python fetch_taxon_names.py --recheck                # ask again for everything except your manual names
    python fetch_taxon_names.py --debug-dir debug        # save the raw answers (to see what the service returned)

HOW THE CSV WORKS  (open it in Excel / a text editor; separator is ;)
    taxon            name as it appears in the species table (Gadus_morhua)
    scientific_name  the same with a space (Gadus morhua)
    norwegian_name   bokmål name that the website shows
    norwegian_name_nn  nynorsk name if it differs
    status           artsdatabanken   found by this script
                     manual           YOU typed the name - never overwritten by this script
                     unverified       a starting suggestion that has not been checked yet
                     no_norwegian_name  the taxon exists but Artsdatabanken has no Norwegian name for it
                     not_found        Artsdatabanken does not know this name
                     error            network problem, will be tried again next time
    source / taxon_id / accepted_name / checked   information about the lookup

    To add a missing name: type it in norwegian_name. Leave status empty or write "manual".
    The file lives in docs/ (next to index.html). The website shows "Torsk (Gadus morhua)".

SERVICE
    Artsdatabanken Taxon API:  GET https://artsdatabanken.no/Api/Taxon?scientificName=<name>
    (documented at https://artsdatabanken.no/Pages/180034). The script reads the preferred Norwegian name and the
    bokmål / nynorsk names from the answer. Names are free to use (CC BY 4.0, credit Artsdatabanken).
"""
import argparse
import csv
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import date
from pathlib import Path

import kyst_common as kc

DELIM = ";"
COLS = ["taxon", "scientific_name", "norwegian_name", "norwegian_name_nn", "status", "source", "taxon_id",
        "accepted_name", "checked"]
DEFAULT_API = "https://artsdatabanken.no"
SKIP_TAXA = {"no identification", "no_identification", ""}
HEADERS = {"Accept": "application/json", "User-Agent": "kysthjelperne-dashboard/1.0 (taxon name lookup)"}


def nfc(s):
    return unicodedata.normalize("NFC", s or "")


def sci(taxon):
    return re.sub(r"\s+", " ", taxon.replace("_", " ")).strip()


# ----------------------------------------------------------------------------------------------
# reading the service answer - written defensively, the exact field names are not guaranteed
# ----------------------------------------------------------------------------------------------
def first(d, *keys):
    for k in keys:
        if isinstance(d, dict) and k in d and d[k] not in (None, ""):
            return d[k]
    return None


def lang_kind(entry):
    """'nb' (bokmål), 'nn' (nynorsk), 'unknown' (not stated) or 'other'."""
    lang = str(first(entry, "languageIsoCode", "LanguageIsoCode", "language", "Language", "languageCode",
                     "LanguageCode", "lang") or "").lower().replace("_", "-")
    if not lang:
        return "unknown"
    if lang.startswith(("nb", "nob", "no-bok", "bokm")) or lang in ("no", "nor", "no-no", "nb-no"):
        return "nb"
    if lang.startswith(("nn", "nno", "nynorsk")):
        return "nn"
    return "other"


def is_pref(entry):
    v = first(entry, "isPreferredName", "IsPreferredName", "preferred", "Preferred", "isPreferred")
    return v is True or str(v).lower() in ("true", "1", "yes")


def vern_name(entry):
    if isinstance(entry, str):
        return entry.strip()
    v = first(entry, "vernacularName", "VernacularName", "name", "Name", "scientificName")
    return str(v).strip() if v else ""


def pick_names(taxon):
    """Return (bokmål, nynorsk) from one taxon object."""
    entries = []
    for key in ("vernacularNames", "VernacularNames"):
        if isinstance(taxon.get(key), list):
            entries += [e for e in taxon[key] if e]
    pref = taxon.get("PreferredVernacularName") or taxon.get("preferredVernacularName")
    if isinstance(pref, (dict, str)) and vern_name(pref):
        entries.insert(0, pref if isinstance(pref, dict) else {"vernacularName": pref, "isPreferredName": True})
        if isinstance(pref, dict) and not is_pref(pref):
            pref["isPreferredName"] = True

    def best(kinds):
        cands = [(is_pref(e) if isinstance(e, dict) else False, vern_name(e)) for e in entries
                 if (lang_kind(e) if isinstance(e, dict) else "unknown") in kinds and vern_name(e)]
        cands.sort(key=lambda c: not c[0])
        return cands[0][1] if cands else ""

    nb = best(("nb",)) or best(("unknown",))
    nn = best(("nn",))
    if not nb and nn:
        nb, nn = nn, ""
    return nb, (nn if nn.lower() != nb.lower() else "")


def choose_taxon(results, query):
    """The API returns a list; take the taxon whose (accepted) scientific name equals the query."""
    if isinstance(results, dict):
        results = [results]
    results = [r for r in results if isinstance(r, dict)]
    q = query.lower()

    def names(t):
        out = set()
        acc = t.get("AcceptedName") or t.get("acceptedName")
        if isinstance(acc, dict):
            out.add(str(first(acc, "scientificName", "ScientificName") or "").lower())
        for n in (t.get("scientificNames") or t.get("ScientificNames") or []):
            if isinstance(n, dict):
                out.add(str(first(n, "scientificName", "ScientificName") or "").lower())
        return out

    exact = [t for t in results if q in names(t)]
    return (exact or results or [None])[0]


def accepted_name(t):
    acc = t.get("AcceptedName") or t.get("acceptedName")
    return str(first(acc, "scientificName", "ScientificName") or "") if isinstance(acc, dict) else ""


# ----------------------------------------------------------------------------------------------
# network
# ----------------------------------------------------------------------------------------------
def query_api(base, name, attempts=3, timeout=20):
    url = f"{base.rstrip('/')}/Api/Taxon?{urllib.parse.urlencode({'scientificName': name})}"
    last = None
    for i in range(attempts):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8")), None
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return [], None
            last = f"HTTP {e.code}"
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
            last = str(getattr(e, "reason", e))
        time.sleep(1.5 * (i + 1))
    return None, last


# ----------------------------------------------------------------------------------------------
# CSV
# ----------------------------------------------------------------------------------------------
def read_names(path):
    rows = {}
    if Path(path).exists():
        with open(path, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f, delimiter=DELIM):
                if r.get("taxon"):
                    rows[nfc(r["taxon"])] = {c: nfc(r.get(c, "")) for c in COLS}
    return rows


def write_names(path, rows):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS, delimiter=DELIM)
        w.writeheader()
        for k in sorted(rows, key=str.lower):
            w.writerow(rows[k])


def taxa_in(species_path):
    taxa = set()
    with open(species_path, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f, delimiter=DELIM):
            t = nfc(r.get("taxon", "")).strip()
            if t.lower() not in SKIP_TAXA:
                taxa.add(t)
    return taxa


def main():
    ap = argparse.ArgumentParser(description="Norwegian names for eDNA taxa from Artsdatabanken.")
    ap.add_argument("--species", default=str(kc.DOCS_DIR / "edna_species_long.csv"))
    ap.add_argument("--names", default=str(kc.DOCS_DIR / "taxon_names.csv"))
    ap.add_argument("--api-base", default=DEFAULT_API)
    ap.add_argument("--delay", type=float, default=0.3, help="seconds between requests (be polite)")
    ap.add_argument("--offline", action="store_true", help="only add new taxa, do not contact the service")
    ap.add_argument("--retry", action="store_true", help="ask again for not_found / error rows")
    ap.add_argument("--recheck", action="store_true", help="ask again for everything except manual names")
    ap.add_argument("--debug-dir", help="save raw answers here")
    args = ap.parse_args()

    if not Path(args.species).exists():
        sys.exit(f"ERROR: {args.species} not found (build it first with build_edna_dataset.py)")
    rows = read_names(args.names)
    new = 0
    for t in sorted(taxa_in(args.species)):
        if t not in rows:
            rows[t] = {c: "" for c in COLS}
            rows[t].update(taxon=t, scientific_name=sci(t))
            new += 1
    for r in rows.values():                                  # a name typed by hand is a manual name
        r["scientific_name"] = r["scientific_name"] or sci(r["taxon"])
        if r["norwegian_name"] and r["status"] in ("", "manual"):
            r["status"] = "manual"
            r["source"] = r["source"] or "manual"

    def needs_lookup(r):
        if r["status"] == "manual":
            return False
        if args.recheck:
            return True
        if r["status"] in ("", "unverified"):
            return True
        return args.retry and r["status"] in ("not_found", "error")

    todo = [r for r in rows.values() if needs_lookup(r)]
    counts = Counter()
    problems = []
    if args.offline:
        todo = []
    elif todo:
        print(f"Asking Artsdatabanken about {len(todo)} taxa ({new} new) ...")
    if args.debug_dir:
        Path(args.debug_dir).mkdir(parents=True, exist_ok=True)

    for i, r in enumerate(todo, 1):
        data, err = query_api(args.api_base, r["scientific_name"])
        today = date.today().isoformat()
        if err:
            if r["status"] != "unverified":
                r["status"] = "error"
            r["checked"] = today
            counts["error"] += 1
            problems.append(f"{r['scientific_name']}: {err}")
            continue
        if args.debug_dir:
            (Path(args.debug_dir) / (re.sub(r"\W+", "_", r["taxon"]) + ".json")).write_text(
                json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        t = choose_taxon(data, r["scientific_name"]) if data else None
        r["checked"] = today
        if t is None:
            if r["status"] != "unverified":
                r["status"] = "not_found"
            counts["not_found"] += 1
            continue
        nb, nn = pick_names(t)
        r["taxon_id"] = str(first(t, "taxonID", "TaxonID", "taxonId") or "")
        r["accepted_name"] = accepted_name(t) if accepted_name(t).lower() != r["scientific_name"].lower() else ""
        if nb:
            r.update(norwegian_name=nb, norwegian_name_nn=nn, status="artsdatabanken", source="Artsdatabanken Taxon API")
            counts["artsdatabanken"] += 1
        else:
            if r["status"] != "unverified":              # keep a starting suggestion, it is still flagged
                r["status"] = "no_norwegian_name"
            r["source"] = "Artsdatabanken Taxon API" if r["status"] == "no_norwegian_name" else r["source"]
            counts["no_norwegian_name"] += 1
            has_entries = bool(t.get("vernacularNames") or t.get("VernacularNames")
                               or t.get("PreferredVernacularName") or t.get("preferredVernacularName"))
            if has_entries:                              # names are there but could not be read -> schema differs
                problems.append(f"{r['scientific_name']}: the answer contains vernacular names that could not be read "
                                f"(run with --debug-dir debug and look at the file)")
        if args.delay and i < len(todo):
            time.sleep(args.delay)

    write_names(args.names, rows)
    st = Counter(r["status"] or "empty" for r in rows.values())
    print("\n================== TAXON NAMES ==================")
    print(f"File: {args.names}   ({len(rows)} taxa, {new} added this run)")
    for k, v in st.most_common():
        print(f"   {v:4d}  {k}")
    missing = sorted(r["scientific_name"] for r in rows.values() if not r["norwegian_name"])
    if missing:
        print(f"\nWithout a Norwegian name ({len(missing)}): " + ", ".join(missing[:40]) + (" ..." if len(missing) > 40 else ""))
        print("Type the name in the 'norwegian_name' column (status stays empty or 'manual') - it is kept on re-runs.")
    if problems:
        print("\nProblems:")
        for p in problems[:15]:
            print("   ", p)
        if len(problems) > 15:
            print(f"    ... and {len(problems) - 15} more")
    if args.offline:
        print("\n(offline mode: no lookup was done)")
    print("=================================================")


if __name__ == "__main__":
    main()
