#!/usr/bin/env python3
"""
build_edna_dataset.py  -  combine metadata + water chemistry + species table into GDPR-safe public files.
(MAIN script: lives in the home directory, serves all projects. See LAYOUT.txt.)

USAGE
    python build_edna_dataset.py --project-dir Kysthjelperne_2022     # settings come from that folder's project.json
    python build_edna_dataset.py --all                                # every project that has an "edna" section
    python build_edna_dataset.py --forget "Ola Nordmann"              # right to erasure: unlink a person everywhere

    (the old style with every option on the command line still works:
     --project X --metadata ... --env ... --species ... --year 2022 --title ... --target-group fish)
    Options given on the command line override project.json.

WHAT COMES OUT  (in docs/ in the home directory - the published website folder)
    docs/edna_samples.csv        one row per sample: date, rounded position, chemistry, species summary, sampler_hash
    docs/edna_species_long.csv   reads per sample and taxon (non-zero only)
    docs/edna_campaigns.csv      one row per campaign: title, target group, author, description (menu on the website)
    Re-running a project replaces only that project's rows; other projects are kept.

WHAT STAYS PRIVATE  (private/ in the home directory - never put it in git or on the website)
    private/sampler_registry.csv   person -> secret personal key (+ aliases for misspelt names)
    private/owners_<project>.csv   the dictionary: sample ID -> sampler name, one file per project
    private/forgotten.txt          one-way hashes of people who asked to be forgotten

HOW SAMPLERS ARE PSEUDONYMISED
    Every person gets a random secret key (e.g. K7QM-X2PD-9WTA) that you hand to them privately.
    The public data only contains  sampler_hash = PBKDF2-SHA256(key).  The website lets a visitor type
    their key; the browser computes the same hash and highlights the samples that match. Nothing is sent
    anywhere, and nobody can get from the public data back to a name. The same person has the same hash in
    every project, so sampler bias can be studied across projects.

    NOTE: pseudonymised data is still personal data under GDPR (the key holder can be identified).
    Use a legal basis + privacy notice, and keep position precision low (coord_decimals).
"""
import argparse
import csv
import difflib
import hashlib
import io
import os
import re
import secrets
import statistics
import subprocess
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import date
from math import log
from pathlib import Path

import kyst_common as kc

# ----------------------------------------------------------------------------------------------
# CONFIG
# ----------------------------------------------------------------------------------------------
DELIM = ";"
REGION = {"lat": (57.5, 61.5), "lng": (8.0, 13.0)}      # anything outside is treated as a typo

KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"        # 32 symbols, no I/O/0/1  ->  12 chars = 60 bits
PBKDF2_ITERATIONS = 100_000                              # must equal the value in script.js
HASH_SALT = b"kysthjelperne-sampler-v1"                  # must equal the value in script.js

LOW_READS = 500                                          # fewer reads: richness is not reliable
QC_LIMITS = {"toc_mgl_max": 20.0, "totp_ugl_max": 100.0, "tn_mgl_min": 0.0011, "cond_mscm_min": 5.0,
             "salinity_for_cond_check": 5.0}

PUBLIC_SAMPLE_COLS = [
    "project", "sample_id", "sample_type", "date", "date_quality", "lat", "lon", "area", "push", "volume_ml",
    "tn_mgl", "toc_mgl", "totp_ugl", "totp_flag", "cond_mscm", "salinity_ppt", "nutrient_group", "qc",
    "has_meta", "has_chem", "has_species", "seq_variants", "reads_total", "reads_identified", "richness",
    "shannon", "top_taxon", "top_share", "seq_flag", "sampler_hash",
]
PUBLIC_SPECIES_COLS = ["project", "sample_id", "variant", "taxon", "reads"]
CAMPAIGN_COLS = ["project", "title", "author", "target_group", "description"]

# header aliases (case-insensitive) so other projects with slightly different headers also work
META_ALIASES = {
    "id": ["id", "sample_id", "sample id", "prøve id", "prove id"],
    "name": ["navn", "name", "sampler", "innsamler"],
    "lat": ["lat", "latitude", "breddegrad"],
    "lon": ["lon", "long", "lng", "longitude", "lengdegrad"],
    "push": ["push", "pushes", "pass", "passes"],
    "volume": ["volum", "volume", "vol"],
    "date": ["dato", "date"],
    "area": ["område", "omrade", "area"],
}
ENV_ALIASES = {
    "id": ["id", "sample_id"],
    "tn": ["tn", "total nitrogen", "tot-n"],
    "toc": ["toc"],
    "totp": ["tot-p", "totp", "total phosphorus"],
    "cond": ["kond.", "kond", "conductivity", "cond"],
    "salinity": ["salinity", "salinitet"],
    "group": ["group", "gruppe"],
}
EXPECTED_UNITS = {"tn": "mg/l", "toc": "mg/l", "totp": "µg/l", "cond": "ms/cm", "salinity": "‰"}

MONTHS = {"jan": 1, "januar": 1, "feb": 2, "februar": 2, "mar": 3, "mars": 3, "march": 3, "apr": 4, "april": 4,
          "mai": 5, "may": 5, "jun": 6, "juni": 6, "june": 6, "jul": 7, "juli": 7, "july": 7, "aug": 8, "august": 8,
          "sep": 9, "sept": 9, "september": 9, "okt": 10, "oct": 10, "oktober": 10, "october": 10,
          "nov": 11, "november": 11, "des": 12, "dec": 12, "desember": 12, "december": 12}


def merge_aliases(base, override):
    """Per-project column names (project.json: meta_columns / env_columns) are tried first."""
    out = {k: list(v) for k, v in base.items()}
    for k, v in (override or {}).items():
        if k in out and v:
            out[k].insert(0, str(v).strip().lower())
    return out


# ----------------------------------------------------------------------------------------------
# SMALL HELPERS
# ----------------------------------------------------------------------------------------------
def nfc(s):
    return unicodedata.normalize("NFC", s or "")


def read_csv_rows(path, delimiter=None):
    if not Path(path).exists():
        sys.exit(f"ERROR: file not found: {path}")
    data = Path(path).read_bytes()
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("cp1252")
    text = nfc(text)
    if delimiter is None:
        first = text.splitlines()[0] if text else ""
        delimiter = max([",", ";", "\t"], key=first.count)
    return list(csv.reader(io.StringIO(text, newline=""), delimiter=delimiter))


def find_col(headers, aliases):
    low = [h.strip().lower() for h in headers]
    for a in aliases:
        if a in low:
            return low.index(a)
    return None


def to_float(v):
    v = (v or "").strip().replace(",", ".")
    if v in ("", "NA", "na", "NaN", "nan", "-"):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def norm_id(v):
    v = (v or "").strip()
    return str(int(v)) if re.fullmatch(r"\d+", v) else v


def fmt(v, nd=None):
    if v is None:
        return ""
    if isinstance(v, float):
        return f"{v:.{nd}f}" if nd is not None else f"{v:.6g}"
    return str(v)


# ----------------------------------------------------------------------------------------------
# SAMPLER REGISTRY  (private)
# ----------------------------------------------------------------------------------------------
def norm_name(s):
    s = nfc(s).casefold()
    s = re.sub(r"[^\w\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def norm_key(k):
    return re.sub(r"[^A-Z0-9]", "", (k or "").upper())


def sampler_hash(key):
    return hashlib.pbkdf2_hmac("sha256", norm_key(key).encode(), HASH_SALT, PBKDF2_ITERATIONS, dklen=16).hex()


def new_key():
    return "-".join("".join(secrets.choice(KEY_ALPHABET) for _ in range(4)) for _ in range(3))


def name_digest(name):
    return hashlib.sha256(b"forget:" + norm_name(name).encode()).hexdigest()


class Registry:
    FIELDS = ["person_id", "name", "aliases", "key", "created"]

    def __init__(self, private_dir):
        self.dir = Path(private_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / "sampler_registry.csv"
        self.forgotten_path = self.dir / "forgotten.txt"
        self.people = []
        if self.path.exists():
            with open(self.path, encoding="utf-8-sig", newline="") as f:
                self.people = list(csv.DictReader(f, delimiter=DELIM))
        self.forgotten = set(self.forgotten_path.read_text().split()) if self.forgotten_path.exists() else set()
        self.new_people = []

    def _names_of(self, p):
        return [p["name"]] + [a for a in (p.get("aliases") or "").split("|") if a.strip()]

    def lookup(self, name):
        n = norm_name(name)
        for p in self.people:
            if n in {norm_name(x) for x in self._names_of(p)}:
                return p
        return None

    def is_forgotten(self, name):
        return name_digest(name) in self.forgotten

    def ensure(self, name):
        p = self.lookup(name)
        if p:
            return p
        p = {"person_id": f"P{len(self.people) + 1:03d}", "name": nfc(name).strip(), "aliases": "",
             "key": new_key(), "created": date.today().isoformat()}
        self.people.append(p)
        self.new_people.append(p)
        return p

    def hash_for(self, name):
        p = self.lookup(name)
        return sampler_hash(p["key"]) if p else ""

    def similar_names(self):
        """Pairs that look like the same person written differently - they must be merged by hand."""
        out = []
        names = [(p["person_id"], p["name"]) for p in self.people]
        for i, (ida, a) in enumerate(names):
            for idb, b in names[i + 1:]:
                if difflib.SequenceMatcher(None, norm_name(a), norm_name(b)).ratio() >= 0.85:
                    out.append((a, b))
        return out

    def save(self):
        with open(self.path, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=self.FIELDS, delimiter=DELIM)
            w.writeheader()
            w.writerows(self.people)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    def forget(self, name, public_dir=None):
        p = self.lookup(name)
        old_hash = sampler_hash(p["key"]) if p else None
        digests = {name_digest(name)}
        if p:
            digests |= {name_digest(x) for x in self._names_of(p)}
            self.people.remove(p)
        self.forgotten |= digests
        self.forgotten_path.write_text("\n".join(sorted(self.forgotten)) + "\n")
        removed = 0
        for f in self.dir.glob("owners_*.csv"):
            rows = list(csv.reader(open(f, encoding="utf-8-sig", newline=""), delimiter=DELIM))
            keep = [rows[0]] + [r for r in rows[1:] if name_digest(r[1]) not in digests]
            removed += len(rows) - len(keep)
            csv.writer(open(f, "w", encoding="utf-8", newline=""), delimiter=DELIM).writerows(keep)
        self.save()
        # blank this person's hash in the public files of ALL projects (their raw files may not be at hand)
        unlinked = 0
        pub = Path(public_dir) / "edna_samples.csv" if public_dir else None
        if old_hash and pub and pub.exists():
            with open(pub, encoding="utf-8-sig", newline="") as f:
                reader = csv.DictReader(f, delimiter=DELIM)
                cols, rows = reader.fieldnames, list(reader)
            for r in rows:
                if r.get("sampler_hash") == old_hash:
                    r["sampler_hash"] = ""
                    unlinked += 1
            write_csv(pub, cols, rows)
        return p is not None, removed, unlinked


def load_owners(private_dir, project, meta_owner, is_forgotten=lambda name: False):
    """The per-project dictionary  sample ID -> name.  Created from the metadata, then edited by hand if needed."""
    path = Path(private_dir) / f"owners_{project}.csv"
    owners = {}
    if path.exists():
        for r in csv.reader(open(path, encoding="utf-8-sig", newline=""), delimiter=DELIM):
            if r and r[0] != "sample_id":
                owners[r[0]] = nfc(r[1])
    added = 0
    for sid, name in meta_owner.items():
        if sid not in owners and name.strip() and not is_forgotten(name):
            owners[sid] = nfc(name).strip()
            added += 1
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, delimiter=DELIM)
        w.writerow(["sample_id", "name"])
        for sid in sorted(owners, key=lambda x: (not x.isdigit(), int(x) if x.isdigit() else 0, x)):
            w.writerow([sid, owners[sid]])
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return owners, added


# ----------------------------------------------------------------------------------------------
# PARSERS
# ----------------------------------------------------------------------------------------------
def parse_date(s, year_hint):
    """Returns (iso date or '', quality).  Handles 27.09.22, 13/08/2022, 17 juli 2022, 14-Jun, 280722, 25082022, 70922."""
    s = (s or "").strip()
    if s.upper() in ("", "NA"):
        return "", "missing"
    d = m = y = None
    quality = "exact"
    if (mt := re.fullmatch(r"(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})", s)):
        d, m, y = int(mt[1]), int(mt[2]), int(mt[3])
    elif (mt := re.fullmatch(r"(\d{2})(\d{2})(\d{4})", s)):                    # 26082022
        d, m, y = int(mt[1]), int(mt[2]), int(mt[3])
    elif (mt := re.fullmatch(r"(\d{2})(\d{2})(\d{2})", s)):                    # 280722
        d, m, y = int(mt[1]), int(mt[2]), int(mt[3])
    elif (mt := re.fullmatch(r"(\d)(\d{2})(\d{2})", s)):                       # 70922  = 7.9.22
        d, m, y = int(mt[1]), int(mt[2]), int(mt[3])
    elif (mt := re.fullmatch(r"(\d{1,2})[\s\-./]+([A-Za-zæøåÆØÅ]+)\.?(?:[\s\-./]+(\d{2,4}))?", s)):
        d, m = int(mt[1]), MONTHS.get(mt[2].lower())
        if mt[3]:
            y = int(mt[3])
        else:
            y, quality = year_hint, "year_assumed"
    if d is None or m is None:
        return "", "unparsed"
    if y is not None and y < 100:
        y += 2000
    try:
        return date(y, m, d).isoformat(), quality
    except (ValueError, TypeError):
        return "", "unparsed"


def clean_areas(raw_values, extra):
    """Area is free text in the raw file (people typed comments in it) -> only keep a controlled vocabulary."""
    counts = Counter(v.strip() for v in raw_values if v and v.strip())
    known = {v for v, n in counts.items() if n >= 2 and len(v) <= 25} | set(extra)

    def f(v):
        v = (v or "").strip()
        if not v:
            return ""
        if v in known:
            return v
        for k in sorted(known, key=len, reverse=True):
            if k.lower() in v.lower():
                return k
        return "Other"
    return f


SEQ_NAME = re.compile(r"^(?P<id>\d+)(?P<variant>[A-Za-z]*)_S\d+(?:_L\d+)?(?:_R\d+)?(?:_\d+)?$")
CTL_NAME = re.compile(r"^(?P<ctl>[NP])_S\d+(?:_L\d+)?(?:_R\d+)?(?:_\d+)?$")


def read_species(path):
    """Row names are sequencing file names:  10_S5_L001_R1_001 -> sample 10.  1F_/1L_ = variants of sample 1."""
    rows = read_csv_rows(path, ",")
    header = rows[0]
    taxa = header[1:]
    runs, bad = {}, []
    for r in rows[1:]:
        if not r or not r[0]:
            continue
        counts = {t: int(float(v)) for t, v in zip(taxa, r[1:]) if v not in ("", "0", "0.0")}
        m = SEQ_NAME.match(r[0])
        c = CTL_NAME.match(r[0])
        if m:
            key = (str(int(m["id"])), m["variant"].upper())
        elif c:
            key = (c["ctl"], "")
        else:
            bad.append(r[0])
            continue
        if key in runs:
            bad.append(f"duplicate {r[0]} -> {key}")
            continue
        runs[key] = counts
    if bad:
        sys.exit("ERROR: could not understand these species-table row names: " + ", ".join(bad[:10]))
    return runs


def read_env(path, opts):
    rows = read_csv_rows(path)
    header = rows[0]
    idx = {k: find_col(header, v) for k, v in merge_aliases(ENV_ALIASES, getattr(opts, 'env_columns', None)).items()}
    missing = [k for k in ("id", "tn", "toc", "totp", "cond", "salinity") if idx[k] is None]
    if missing:
        sys.exit(f"ERROR: chemistry file lacks columns {missing}. Headers: {header}")
    # an optional unit row directly under the header (empty ID, text in the value columns)
    body = rows[1:]
    notes = []
    if body and not (body[0][idx["id"]] or "").strip():
        units = body[0]
        for k, exp in EXPECTED_UNITS.items():
            u = (units[idx[k]] if idx[k] < len(units) else "").strip().lower()
            if u and u != exp:
                notes.append(f"unit for {k} is '{u}', expected '{exp}'")
        body = body[1:]
    out = {}
    for r in body:
        if not r or not (r[idx["id"]] or "").strip():
            continue
        sid = norm_id(r[idx["id"]])
        if sid in out:
            sys.exit(f"ERROR: duplicate ID {sid} in chemistry file")
        g = lambda k: to_float(r[idx[k]]) if idx[k] is not None and idx[k] < len(r) else None
        grp = (r[idx["group"]].strip() if idx["group"] is not None and idx["group"] < len(r) else "")
        out[sid] = {"tn": g("tn"), "toc": g("toc"), "totp": g("totp"), "cond": g("cond"),
                    "salinity": g("salinity"), "group": grp}
    return out, notes


def chem_flags(c, opts):
    """Quality flags. Values are NEVER changed, only flagged - the website leaves flagged values out of statistics."""
    flags, totp_flag, totp = [], "", c["totp"]
    if opts.totp_one_means_below and totp is not None and totp == 1:
        totp, totp_flag = None, f"<{opts.totp_one_means_below:g}"
    if c["tn"] is not None and c["tn"] < QC_LIMITS["tn_mgl_min"]:
        flags.append("tn")
    if c["toc"] is not None and c["toc"] > QC_LIMITS["toc_mgl_max"]:
        flags.append("toc")
    if totp is not None and totp > QC_LIMITS["totp_ugl_max"]:
        flags.append("totp")
    if (c["cond"] is not None and c["salinity"] is not None
            and c["cond"] < QC_LIMITS["cond_mscm_min"] and c["salinity"] >= QC_LIMITS["salinity_for_cond_check"]):
        flags.append("cond")
    return totp, totp_flag, flags


def species_summary(counts):
    ident = {t: n for t, n in counts.items() if t != "no identification" and n > 0}
    total = sum(counts.values())
    ident_total = sum(ident.values())
    shannon = ""
    if ident_total > 0:
        shannon = round(-sum((n / ident_total) * log(n / ident_total) for n in ident.values()), 3)
    top = max(ident.items(), key=lambda kv: kv[1]) if ident else None
    flag = "no_reads" if total == 0 else ("low_reads" if total < LOW_READS else "")
    return {"reads_total": total, "reads_identified": ident_total, "richness": len(ident), "shannon": shannon,
            "top_taxon": top[0] if top else "", "top_share": round(top[1] / ident_total, 3) if top else "",
            "seq_flag": flag}


# ----------------------------------------------------------------------------------------------
# MAIN BUILD
# ----------------------------------------------------------------------------------------------
def build(opts):
    reg = Registry(opts.private_dir)

    # ---- metadata ---------------------------------------------------------------------------
    rows = read_csv_rows(opts.metadata)
    header = rows[0]
    mi = {k: find_col(header, v) for k, v in merge_aliases(META_ALIASES, getattr(opts, 'meta_columns', None)).items()}
    if mi["id"] is None:
        sys.exit(f"ERROR: metadata lacks an ID column. Headers: {header}")
    meta, meta_owner = {}, {}
    raw_areas = [r[mi["area"]] for r in rows[1:] if mi["area"] is not None and len(r) > mi["area"]]
    area_of = clean_areas(raw_areas, opts.extra_area)
    date_notes = Counter()
    for r in rows[1:]:
        if not r or not r[mi["id"]].strip():
            continue
        sid = norm_id(r[mi["id"]])
        get = lambda k: r[mi[k]] if mi[k] is not None and mi[k] < len(r) else ""
        iso, q = parse_date(get("date"), opts.year)
        date_notes[q] += 1
        lat, lng = to_float(get("lat")), to_float(get("lon"))
        if lat is not None and lng is not None and not (REGION["lat"][0] <= lat <= REGION["lat"][1]
                                                       and REGION["lng"][0] <= lng <= REGION["lng"][1]):
            if REGION["lat"][0] <= lng <= REGION["lat"][1] and REGION["lng"][0] <= lat <= REGION["lng"][1]:
                lat, lng = lng, lat                                # swapped
            else:
                lat = lng = None
        vol_l, push = to_float(get("volume")), to_float(get("push"))
        meta[sid] = {"date": iso, "date_quality": q,
                     "lat": round(lat, opts.coord_decimals) if lat is not None else None,
                     "lon": round(lng, opts.coord_decimals) if lng is not None else None,
                     "area": area_of(get("area")), "push": int(push) if push is not None else None,
                     "volume_ml": int(round(vol_l * 1000)) if vol_l is not None else None}
        if mi["name"] is not None:
            meta_owner[sid] = get("name")

    # ---- chemistry + species ----------------------------------------------------------------
    chem, env_notes = read_env(opts.env, opts)
    runs = read_species(opts.species)

    # ---- sampler dictionary + registry --------------------------------------------------------
    owners, owners_added = load_owners(opts.private_dir, opts.project, meta_owner, reg.is_forgotten)
    skipped_forgotten = 0
    sampler_of = {}
    for sid, name in owners.items():
        if reg.is_forgotten(name):
            skipped_forgotten += 1
            continue
        reg.ensure(name)
        sampler_of[sid] = sampler_hash(reg.lookup(name)["key"])
    reg.save()

    # ---- combine ------------------------------------------------------------------------------
    ids = set(meta) | set(chem) | {k[0] for k in runs if k[0] not in ("N", "P")}
    ctl_ids = {k[0] for k in runs if k[0] in ("N", "P")}
    order = lambda x: (not x.isdigit(), int(x) if x.isdigit() else 0, x)
    sample_rows, long_rows = [], []
    for sid in sorted(ids, key=order) + sorted(ctl_ids):
        is_ctl = sid in ("N", "P")
        m, c = meta.get(sid), chem.get(sid)
        variants = sorted(v for (i, v) in runs if i == sid)
        prim = runs.get((sid, ""))
        row = {k: "" for k in PUBLIC_SAMPLE_COLS}
        row.update(project=opts.project, sample_id=sid,
                   sample_type={"N": "negative_control", "P": "positive_control"}.get(sid, "sample"),
                   has_meta=int(m is not None), has_chem=int(c is not None), has_species=int(bool(variants)),
                   seq_variants="|".join(v or "main" for v in variants), sampler_hash=sampler_of.get(sid, ""))
        if m:
            row.update(date=m["date"], date_quality=m["date_quality"], lat=fmt(m["lat"], opts.coord_decimals),
                       lon=fmt(m["lon"], opts.coord_decimals), area=m["area"], push=fmt(m["push"]),
                       volume_ml=fmt(m["volume_ml"]))
        if c:
            totp, totp_flag, flags = chem_flags(c, opts)
            row.update(tn_mgl=fmt(c["tn"]), toc_mgl=fmt(c["toc"]), totp_ugl=fmt(totp), totp_flag=totp_flag,
                       cond_mscm=fmt(c["cond"]), salinity_ppt=fmt(c["salinity"]), nutrient_group=c["group"],
                       qc=";".join(flags))
        if prim is not None:
            row.update(species_summary(prim))
        elif variants and not is_ctl:
            row["seq_flag"] = "variants_only"
        sample_rows.append(row)
        for v in variants:
            for taxon, n in sorted(runs[(sid, v)].items()):
                long_rows.append({"project": opts.project, "sample_id": sid, "variant": v or "main",
                                  "taxon": taxon, "reads": n})

    write_public(opts, sample_rows, long_rows)
    report(opts, reg, meta, chem, runs, sample_rows, date_notes, env_notes, owners_added, skipped_forgotten)


# ----------------------------------------------------------------------------------------------
# WRITING + VERIFICATION (fail closed)
# ----------------------------------------------------------------------------------------------
def merge_existing(path, cols, new_rows, project):
    kept = []
    if path.exists():
        with open(path, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f, delimiter=DELIM):
                if r.get("project") != project:
                    kept.append({c: r.get(c, "") for c in cols})
    return kept + [{c: str(r.get(c, "")) for c in cols} for r in new_rows]


def write_csv(path, cols, rows):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, delimiter=DELIM)
        w.writeheader()
        w.writerows(rows)


def campaign_row(opts):
    """Keep what is already in edna_campaigns.csv (it may have been edited by hand); only overwrite what was passed."""
    path = Path(opts.public_dir) / "edna_campaigns.csv"
    row = {c: "" for c in CAMPAIGN_COLS}
    if path.exists():
        with open(path, encoding="utf-8-sig", newline="") as f:
            for r in csv.DictReader(f, delimiter=DELIM):
                if r.get("project") == opts.project:
                    row.update({c: r.get(c, "") for c in CAMPAIGN_COLS})
    row["project"] = opts.project
    for col, val in (("title", opts.title), ("author", opts.author), ("target_group", opts.target_group),
                     ("description", opts.description)):
        if val is not None:
            row[col] = nfc(val).strip()
    if not row["title"]:
        row["title"] = opts.project
    return row


def write_public(opts, sample_rows, long_rows):
    pub = Path(opts.public_dir)
    pub.mkdir(parents=True, exist_ok=True)
    targets = [(pub / "edna_samples.csv", PUBLIC_SAMPLE_COLS, sample_rows),
               (pub / "edna_species_long.csv", PUBLIC_SPECIES_COLS, long_rows),
               (pub / "edna_campaigns.csv", CAMPAIGN_COLS, [campaign_row(opts)])]
    tmp = []
    for path, cols, rows in targets:
        t = path.with_suffix(".csv.tmp")
        write_csv(t, cols, merge_existing(path, cols, rows, opts.project))
        tmp.append((t, path, cols))
    problems = verify_public([t for t, _, _ in tmp], [c for _, _, c in tmp], opts, skip_name_cols={"author"})
    if problems:
        for t, _, _ in tmp:
            t.unlink(missing_ok=True)
        print("\n!!! GDPR VERIFICATION FAILED - nothing was published (previous public files untouched):")
        for p in problems[:30]:
            print("   ", p)
        sys.exit(2)
    for t, path, _ in tmp:
        os.replace(t, path)


def private_name_tokens(private_dir):
    names = []
    reg = Path(private_dir) / "sampler_registry.csv"
    if reg.exists():
        for r in csv.DictReader(open(reg, encoding="utf-8-sig", newline=""), delimiter=DELIM):
            names += [r["name"]] + (r.get("aliases") or "").split("|")
    for f in Path(private_dir).glob("owners_*.csv"):
        for r in csv.reader(open(f, encoding="utf-8-sig", newline=""), delimiter=DELIM):
            if len(r) > 1 and r[0] != "sample_id":
                names.append(r[1])
    toks = set()
    for n in names:
        toks |= {t.lower() for t in re.findall(r"[^\W\d_]{3,}", nfc(n))}
    return toks


def verify_public(paths, colsets, opts, skip_name_cols=()):
    problems = []
    tokens = private_name_tokens(opts.private_dir)
    letter = r"(?<![^\W\d_]){}(?![^\W\d_])"
    rx = re.compile(letter.format("(?:" + "|".join(re.escape(t) for t in sorted(tokens, key=len, reverse=True)) + ")"),
                    re.I) if tokens else None
    for path, cols in zip(paths, colsets):
        with open(path, encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f, delimiter=DELIM)
            if reader.fieldnames != cols:
                problems.append(f"{path.name}: unexpected columns {reader.fieldnames}")
            for i, r in enumerate(reader, start=2):
                for col, val in r.items():
                    val = val or ""
                    if "@" in val:
                        problems.append(f"{path.name} line {i}, {col}: '@'")
                    if rx and col not in skip_name_cols and rx.search(val):
                        problems.append(f"{path.name} line {i}, {col}: contains a name from the private registry ({rx.search(val).group(0)!r})")
                    if col == "sampler_hash" and val and not re.fullmatch(r"[0-9a-f]{32}", val):
                        problems.append(f"{path.name} line {i}: sampler_hash has unexpected format")
                    if col in ("lat", "lon") and val and len(val.split(".")[-1]) > opts.coord_decimals:
                        problems.append(f"{path.name} line {i}: {col} more precise than {opts.coord_decimals} decimals")
                    if col == "area" and len(val) > 30:
                        problems.append(f"{path.name} line {i}: area looks like free text")
    return problems


# ----------------------------------------------------------------------------------------------
# REPORT
# ----------------------------------------------------------------------------------------------
def git_warning(path):
    try:
        cwd = Path(path).resolve()
        inside = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], cwd=cwd, capture_output=True).returncode == 0
        ignored = subprocess.run(["git", "check-ignore", "-q", "."], cwd=cwd, capture_output=True).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return
    if inside and not ignored:
        print(f"\n!!! WARNING: {path}/ is inside a git repo and NOT ignored. Add 'private/' to .gitignore NOW.")


def report(opts, reg, meta, chem, runs, rows, date_notes, env_notes, owners_added, skipped_forgotten):
    ids = {r["sample_id"] for r in rows if r["sample_type"] == "sample"}
    both = {s for s in ids if s in meta and s in chem and any(k[0] == s for k in runs)}
    print("\n================== EDNA DATASET REPORT ==================")
    print(f"Project: {opts.project}   ->  {Path(opts.public_dir) / 'edna_samples.csv'}")
    print(f"Samples: {len(ids)}  (metadata {len(meta)}, chemistry {len(chem)}, "
          f"species {len({k[0] for k in runs if k[0] not in ('N', 'P')})})   in all three: {len(both)}")
    nometa = sorted((s for s in ids if s not in meta), key=lambda x: (not x.isdigit(), int(x) if x.isdigit() else 0))
    print(f"Without metadata (no date/position, kept for statistics): {len(nometa)}  {nometa}")
    print(f"Controls kept apart from samples: {sorted(k[0] for k in runs if k[0] in ('N', 'P'))}")
    var = sorted(f"{i}{v}" for (i, v) in runs if v)
    print(f"Sequencing variants (kept separate, never merged): {var}")
    print(f"Dates: {dict(date_notes)}   (year_assumed = year missing in raw data, {opts.year} used)")
    qc = Counter(f for r in rows for f in r["qc"].split(";") if f)
    print(f"Chemistry values flagged (kept, but left out of statistics): {dict(qc)}")
    print(f"Sequencing flags: {dict(Counter(r['seq_flag'] for r in rows if r['seq_flag']))}")
    for n in env_notes:
        print("   NOTE:", n)
    print("\n--- Samplers (private) ---")
    print(f"Owner dictionary: {len(set(load_owner_count(opts)))} samples listed, {owners_added} added this run  "
          f"(private/owners_{opts.project}.csv)")
    print(f"People in registry: {len(reg.people)}   new this run: {len(reg.new_people)}")
    if reg.new_people:
        print("   New personal keys were created -> send each person THEIR key privately "
              "(private/sampler_registry.csv).")
    sim = reg.similar_names()
    if sim:
        print("   LOOKS LIKE THE SAME PERSON - merge by adding the misspelling to the 'aliases' column "
              "(separate with |) and delete the duplicate row, then re-run:")
        for a, b in sim:
            print(f"      '{a}'  <->  '{b}'")
    if skipped_forgotten:
        print(f"   {skipped_forgotten} samples belong to people who asked to be forgotten: left without sampler.")
    print("\nGDPR check of the public files passed: no names, no '@', rounded positions "
          f"({opts.coord_decimals} decimals ~ {111000 / 10 ** opts.coord_decimals:.0f} m), controlled area vocabulary.")
    print(f"Published files are in {Path(opts.public_dir)} (edna_samples.csv, edna_species_long.csv, edna_campaigns.csv).")
    print("Norwegian species names: run  python fetch_taxon_names.py  (checks Artsdatabanken, writes taxon_names.csv).")
    print("=========================================================")
    git_warning(opts.private_dir)


def load_owner_count(opts):
    p = Path(opts.private_dir) / f"owners_{opts.project}.csv"
    return [r[0] for r in csv.reader(open(p, encoding="utf-8-sig", newline=""), delimiter=DELIM)][1:] if p.exists() else []


def options_from_project(project_dir, args):
    """Fill the options from <project_dir>/project.json ('edna' section); command-line values win."""
    cfg = kc.load_config(project_dir)
    e = cfg.get("edna")
    if not e:
        sys.exit(f"ERROR: {Path(project_dir).name}/project.json has no \"edna\" section")
    path = lambda key: str(kc.in_project(cfg, e[key])) if e.get(key) else None
    o = argparse.Namespace(**vars(args))
    o.project = args.project or cfg["project"]
    o.metadata = args.metadata or path("metadata")
    o.env = args.env or path("env")
    o.species = args.species or path("species")
    o.year = args.year if args.year is not None else e.get("year")
    o.extra_area = args.extra_area or e.get("extra_areas") or []
    o.totp_one_means_below = args.totp_one_means_below if args.totp_one_means_below is not None else e.get("totp_one_means_below", 0)
    o.coord_decimals = args.coord_decimals if args.coord_decimals is not None else e.get("coord_decimals")
    for k in ("title", "author", "target_group", "description"):
        setattr(o, k, getattr(args, k) if getattr(args, k) is not None else e.get(k))
    o.meta_columns = e.get("meta_columns") or {}
    o.env_columns = e.get("env_columns") or {}
    return o


def finalize(o):
    """Defaults that do not depend on a project."""
    o.public_dir = o.public_dir or str(kc.DOCS_DIR)
    o.private_dir = o.private_dir or str(kc.PRIVATE_DIR)
    o.coord_decimals = 3 if o.coord_decimals is None else o.coord_decimals
    o.totp_one_means_below = o.totp_one_means_below or 0
    o.extra_area = o.extra_area or []
    for need in ("project", "metadata", "env", "species", "year"):
        if getattr(o, need, None) in (None, ""):
            sys.exit(f"ERROR: '{need}' is missing - set it in project.json or with --{need.replace('_', '-')}")
    for f in (o.metadata, o.env, o.species):
        if not Path(f).exists():
            sys.exit(f"ERROR: file not found: {f}")
    return o


def main():
    ap = argparse.ArgumentParser(description="Build GDPR-safe public eDNA files from raw project data.")
    ap.add_argument("--project-dir", help="project directory (name or path) with a project.json")
    ap.add_argument("--all", action="store_true", help="build every project that has an 'edna' section")
    ap.add_argument("--project", help="short unique project code, e.g. kysthjelperne_2022")
    ap.add_argument("--metadata")
    ap.add_argument("--env")
    ap.add_argument("--species")
    ap.add_argument("--year", type=int, help="year used when a date has no year (e.g. '14-Jun')")
    ap.add_argument("--public-dir", default=None, help="default: docs/ in the home directory")
    ap.add_argument("--private-dir", default=None, help="default: private/ in the home directory")
    ap.add_argument("--coord-decimals", type=int, default=None, help="3 = about 100 m")
    ap.add_argument("--extra-area", action="append", default=[], help="area names to keep even if rare (repeatable)")
    ap.add_argument("--totp-one-means-below", type=float, default=None,
                    help="in this project a Tot-P value of 1 means '<N' (below detection limit)")
    ap.add_argument("--title", help="campaign title shown in the website menu")
    ap.add_argument("--author", help="who ran the study (PUBLIC - only with their consent; leave out to hide)")
    ap.add_argument("--target-group", help="what the species table covers, e.g. fish, invertebrates, algae")
    ap.add_argument("--description", help="one or two sentences about the campaign")
    ap.add_argument("--forget", metavar="NAME", help="erase a person: remove registry entry and unlink their samples")
    args = ap.parse_args()

    if args.forget:
        found, removed, unlinked = Registry(args.private_dir or kc.PRIVATE_DIR).forget(args.forget, args.public_dir or kc.DOCS_DIR)
        print(f"{'Removed from registry' if found else 'Not in registry (blocked from being re-added anyway)'}; "
              f"{removed} owner rows deleted; sampler link removed from {unlinked} public samples "
              f"(the samples themselves stay).")
        return

    if args.all:
        projects = [(d, c) for d, c in kc.find_projects() if c.get("edna")]
        if not projects:
            sys.exit("No project with an 'edna' section found.")
        failed = []
        for d, _ in projects:
            print(f"\n########## {d.name} ##########")
            try:
                build(finalize(options_from_project(d, args)))
            except SystemExit as e:
                if e.code not in (0, None):
                    failed.append(d.name)
                    print(f"!!! {d.name} failed: {e.code}")
        if failed:
            sys.exit(f"Failed projects: {', '.join(failed)}")
        return

    if args.project_dir:
        build(finalize(options_from_project(kc.resolve_project_dir(args.project_dir), args)))
        return

    for need in ("project", "metadata", "env", "species", "year"):
        if getattr(args, need) is None:
            ap.error(f"--{need} is required (or use --project-dir / --all)")
    args.meta_columns, args.env_columns = {}, {}
    build(finalize(args))


if __name__ == "__main__":
    main()
