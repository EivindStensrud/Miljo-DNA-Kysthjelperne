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

TWO KINDS OF SEQUENCE DATA  (set "species_format" / "metadata_format" in project.json)
    seq_files  rows named 10_S5_L001_R1_001 (sample 10), metadata table + chemistry table      [Kysthjelperne_2022]
    lca        rows named H-2013, R-2013, H-N2660, H-MOCK, H-PCR-neg; metadata = the survey export   [2025]
               * the number is the "Prøve ID" in the survey export; N-numbers are field blanks (negative controls)
               * H / R / M = sequencing run. The same sample in two runs is kept as two runs, NEVER added up; the
                 run listed first in "run_priority" (default H, R, M) is the one used for the sample's statistics
               * MOCK = positive control, PCR-neg = negative control (a number is added when a run has several)
               * names with spaces; "_" between species = the LCA could not separate them (kept as written)
               * only sequenced samples are published; date and position come from the survey export (all common
                 coordinate formats incl. UTM 33). An ID on several rows of the export is only used when the rows
                 agree - otherwise it is published without position and listed in the report ("id_resolution").

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
    "project", "sample_id", "sample_type", "date", "date_quality", "lat", "lon", "pos_source", "area", "push", "volume_ml",
    "tn_mgl", "toc_mgl", "totp_ugl", "totp_flag", "cond_mscm", "salinity_ppt", "nutrient_group", "qc",
    "has_meta", "has_chem", "has_species", "seq_variants", "main_run", "reads_total", "reads_identified", "richness",
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
    if (mt := re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?", s)):    # 2025-01-30T12:40
        y, m, d = int(mt[1]), int(mt[2]), int(mt[3])
    elif (mt := re.fullmatch(r"(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})", s)):
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


# ----------------------------------------------------------------------------------------------
# LCA TABLE + SAMPLING LOG  (Kysthjelperne 2025 and later)
# ----------------------------------------------------------------------------------------------
LCA_ROW = re.compile(r"^(?:(?P<run>[A-Za-z])-)?(?P<rest>.+)$")
LCA_ALT = re.compile(r"_(?=[^\d_])")       # '_' between alternative species; '_13B' inside a strain name is not a separator


def lca_alternatives(taxon):
    """'Acartia hudsonica_Acartia tonsa' -> two alternatives (the LCA could not tell them apart)."""
    return [a for a in LCA_ALT.split(taxon)] if " " in taxon else [taxon.replace("_", " ")]


def ctl_type(sid):
    """Controls are kept apart from samples. N / N2660 / PCR-neg-H = negative, P / MOCK-H = positive."""
    if sid == "N" or re.fullmatch(r"N\d+", sid) or sid.startswith("PCR-neg"):
        return "negative_control"
    if sid == "P" or sid.startswith("MOCK"):
        return "positive_control"
    return None


def norm_sample_id(v):
    """'2013', ' 2013 ', 'N 2666', 'N-2664', 'n2664' -> '2013' / 'N2666' ..."""
    v = (v or "").strip()
    if re.fullmatch(r"\d+", v):
        return str(int(v))
    m = re.fullmatch(r"[Nn][\s\-_#]*(\d+)", v)
    return f"N{int(m[1])}" if m else v.upper().replace(" ", "")


def read_lca(path, opts):
    """Rows are named  <run>-<id>:  H-2013 (run H, sample 2013), R-2013 (run R, same sample), H-N2660 (field blank),
    H-MOCK / H-PCR-neg (lab controls).  Returns (runs, main_run) in the same shape as read_species():
    runs[(sample, '')] = the main run, runs[(sample, 'R')] = another run of the same sample.  Runs are NEVER added up."""
    rows = read_csv_rows(path, ",")
    taxa = [t.strip() for t in rows[0][1:]]
    priority = [str(p).upper() for p in (getattr(opts, "run_priority", None) or ["H", "R", "M"])]
    per_sample, bad, ctl_seen = defaultdict(dict), [], Counter()
    for r in rows[1:]:
        if not r or not r[0].strip():
            continue
        name = r[0].strip()
        counts = {t: int(float(v)) for t, v in zip(taxa, r[1:]) if v not in ("", "0", "0.0")}
        m = LCA_ROW.match(name)
        run, rest = (m["run"] or "").upper(), m["rest"].strip()
        if re.fullmatch(r"(?i)mock", rest):
            ctl_seen[("MOCK", run)] += 1
            n = ctl_seen[("MOCK", run)]
            sid = f"MOCK-{run}" if run else "MOCK"
            sid, run = (sid if n == 1 else f"{sid}-{n}"), run
        elif re.fullmatch(r"(?i)pcr[-_ ]?neg(?:ative)?", rest):
            ctl_seen[("PCR-neg", run)] += 1
            n = ctl_seen[("PCR-neg", run)]
            sid = f"PCR-neg-{run}" if run else "PCR-neg"
            sid = sid if n == 1 else f"{sid}-{n}"
        elif re.fullmatch(r"(?i)n\s*-?\s*\d+", rest) or re.fullmatch(r"\d+", rest):
            sid = norm_sample_id(rest)
        else:
            bad.append(name)
            continue
        if run in per_sample[sid]:
            bad.append(f"duplicate {name}")
            continue
        per_sample[sid][run] = counts
    if bad:
        sys.exit("ERROR: could not understand these LCA row names: " + ", ".join(bad[:10]) +
                 "   (expected H-2013, R-2013, H-N2660, H-MOCK, H-PCR-neg)")
    runs, main_run = {}, {}
    for sid, by_run in per_sample.items():
        order = sorted(by_run, key=lambda x: (priority.index(x) if x in priority else len(priority), x))
        main_run[sid] = order[0]
        runs[(sid, "")] = by_run[order[0]]
        for other in order[1:]:
            runs[(sid, other or "x")] = by_run[other]
    return runs, main_run


def region_fix(lat, lng):
    if lat is None or lng is None:
        return None, None
    if REGION["lat"][0] <= lat <= REGION["lat"][1] and REGION["lng"][0] <= lng <= REGION["lng"][1]:
        return lat, lng
    if REGION["lat"][0] <= lng <= REGION["lat"][1] and REGION["lng"][0] <= lat <= REGION["lng"][1]:
        return lng, lat                                   # swapped
    return None, None


DMS = re.compile(r"(\d{1,3})\s*[°º]\s*(\d{1,2})?\s*['′’]?\s*(\d{1,2}(?:[.,]\d+)?)?\s*(?:[\"″”]|'')?\s*([NSEWØO])?", re.I)
DEG = re.compile(r"(\d{1,3}(?:[.,]\d+)?)\s*[°º]\s*([NSEWØO])?", re.I)
NUM = re.compile(r"-?\d+(?:[.,]\d+)?")
UTM_N = re.compile(r"(?<![A-Za-z])N\s*:?\s*(\d{6,7}(?:[.,]\d+)?)", re.I)
UTM_E = re.compile(r"(?<![A-Za-z])[ØEO]\s*:?\s*(\d{5,6}(?:[.,]\d+)?)", re.I)
UTM_ZONE = 33                                    # Norwegian standard (EUREF89 / UTM 33); checked against REGION below


def utm_to_latlon(easting, northing, zone=UTM_ZONE):
    """Inverse transverse Mercator (Krüger series, GRS80/WGS84), northern hemisphere. Good to millimetres."""
    from math import asin, atan2, cosh, cos, degrees, radians, sin, sinh
    a, f, k0 = 6378137.0, 1 / 298.257222101, 0.9996
    n = f / (2 - f)
    A = a / (1 + n) * (1 + n ** 2 / 4 + n ** 4 / 64)
    beta = [n / 2 - 2 * n ** 2 / 3 + 37 * n ** 3 / 96, n ** 2 / 48 + n ** 3 / 15, 17 * n ** 3 / 480]
    delta = [2 * n - 2 * n ** 2 / 3 - 2 * n ** 3, 7 * n ** 2 / 3 - 8 * n ** 3 / 5, 56 * n ** 3 / 15]
    xi, eta = northing / (k0 * A), (easting - 500000.0) / (k0 * A)
    xi2 = xi - sum(b * sin(2 * (j + 1) * xi) * cosh(2 * (j + 1) * eta) for j, b in enumerate(beta))
    eta2 = eta - sum(b * cos(2 * (j + 1) * xi) * sinh(2 * (j + 1) * eta) for j, b in enumerate(beta))
    chi = asin(sin(xi2) / cosh(eta2))
    lat = chi + sum(d * sin(2 * (j + 1) * chi) for j, d in enumerate(delta))
    lon = radians(zone * 6 - 183) + atan2(sinh(eta2), cos(xi2))
    return degrees(lat), degrees(lon)


def parse_coords(text):
    """Understands '59.38, 10.47' | '(59,46, 10,35)' | '59,90947° N, 10,64277° Ø' | '59°53'21"N 10°35'36"E' |
    'N6642685.93 Ø258538.41' (UTM 33) | '599095149 106429034' | a map link.  Anything else -> (None, None).
    The result must lie in the project region, otherwise it is rejected (typos are never published)."""
    t = (text or "").strip()
    if not t:
        return None, None
    sign = lambda h: -1 if (h or "").upper() in ("S", "W") else 1
    if re.match(r"(?i)https?://|www\.", t):
        at = re.search(r"@(-?\d+\.\d+),(-?\d+\.\d+)", t) or re.search(r"[?&]q=(-?\d+\.\d+)[,+%2C]+(-?\d+\.\d+)", t)
        return region_fix(float(at[1]), float(at[2])) if at else (None, None)
    un, ue = UTM_N.search(t), UTM_E.search(t)
    if un and ue:
        lat, lon = utm_to_latlon(float(ue[1].replace(",", ".")), float(un[1].replace(",", ".")))
        return region_fix(lat, lon)
    if re.search(r"[°º]", t):
        dms = [m for m in DMS.finditer(t) if m[1] and (m[2] or m[3])]
        if len(dms) >= 2:
            v = [(int(m[1]) + (int(m[2]) / 60 if m[2] else 0) + (float(m[3].replace(",", ".")) / 3600 if m[3] else 0))
                 * sign(m[4]) for m in dms[:2]]
            return region_fix(*v)
        deg = DEG.findall(t)
        if len(deg) >= 2:
            return region_fix(*[float(d.replace(",", ".")) * sign(h) for d, h in deg[:2]])
        return None, None
    nums = NUM.findall(t)
    if len(nums) == 2:
        if all(re.fullmatch(r"\d{7,10}", n) for n in nums):                    # decimal point lost: 599095149 106429034
            lat = float(nums[0][:2] + "." + nums[0][2:])
            for cut in (2, 1):
                lon = float(nums[1][:cut] + "." + nums[1][cut:])
                if region_fix(lat, lon) != (None, None):
                    return lat, lon
            return None, None
        return region_fix(*[float(n.replace(",", ".")) for n in nums])
    return None, None


def parse_volume(text, regular_sample):
    """Rules of the project: empty -> 1200 mL (samples only); a number <= 20 = that many passes of 60 mL."""
    t = (text or "").strip()
    m = re.search(r"\d+(?:[.,]\d+)?", t)
    if not m:
        return (None, 1200) if regular_sample else (None, None)
    n = float(m[0].replace(",", "."))
    if n <= 20 and not re.search(r"(?i)\b\d+(?:[.,]\d+)?\s*(ml|l)\b", t):
        return int(n), int(round(n * 60))
    if re.search(r"(?i)\d\s*l\b", t) and n < 10:
        return None, int(round(n * 1000))
    return None, int(round(n))


def log_col(header, prefix):
    low = [h.strip().lower() for h in header]
    for i, h in enumerate(low):
        if h.startswith(prefix):
            return i
    return None


def read_sampling_log_meta(path, opts, wanted, hints=None):
    """The survey export (Prøve ID, date, area, coordinates, volume, name) -> the same dict as the metadata table.
    An ID that occurs on several rows is only used when the rows agree or project.json 'id_resolution' picks one."""
    rows = read_csv_rows(path, ";")
    header = rows[0]
    col = {k: log_col(header, p) for k, p in (("id", "prøve id"), ("date", "tid og dato for prøvetakning"),
                                              ("area", "prøvetakningsområde"), ("locale", "prøvetakningslokale"),
                                              ("coords", "koordinater"), ("volume", "antall ml"),
                                              ("name", "navn"), ("note", "om annet"))}
    if col["id"] is None:
        sys.exit(f"ERROR: sampling log lacks a 'Prøve ID' column. Headers: {header}")
    get = lambda r, k: r[col[k]] if col[k] is not None and col[k] < len(r) else ""
    def area_text(r):
        """Area cell (or the station name when the area is empty), without trailing station numbers: 'Sætre 3' -> 'Sætre'."""
        t = (get(r, "area") or get(r, "locale") or "").strip()
        return re.sub(r"[\s_\-]*\d+\s*$", "", t).strip(" ,;:.")

    area_of = clean_areas([area_text(r) for r in rows[1:]], opts.extra_area)
    cands, from_comment = defaultdict(list), []
    for r in rows[1:]:
        sid = norm_sample_id(get(r, "id"))
        if not sid:                                    # empty ID cell: "Prøvenr 2013" written in the comment
            m = re.search(r"(?i)pr[øo]ve\s*-?\s*(?:nr|nummer|id)\.?\s*[:#]?\s*(N?\s*\d{1,4})\b", get(r, "note"))
            sid = norm_sample_id(m[1]) if m else ""
            if sid and sid in wanted:
                from_comment.append(sid)
        if sid and sid in wanted:
            cands[sid].append(r)
    resolution = {norm_sample_id(k): str(v) for k, v in (getattr(opts, "id_resolution", None) or {}).items()}
    meta, owner, ambiguous, date_notes = {}, {}, {}, Counter()

    def make(r, sid):
        iso, q = parse_date(get(r, "date"), opts.year)
        lat, lng = parse_coords(get(r, "coords"))
        push, vol = parse_volume(get(r, "volume"), ctl_type(sid) is None)
        return {"date": iso, "date_quality": q, "pos_source": "log" if lat is not None else "",
                "lat": round(lat, opts.coord_decimals) if lat is not None else None,
                "lon": round(lng, opts.coord_decimals) if lng is not None else None,
                "area": area_of(area_text(r)), "push": push, "volume_ml": vol}

    for sid, rs in cands.items():
        chosen = None
        if sid in resolution:
            hit = [r for r in rs if (get(r, "date") or "").startswith(resolution[sid])
                   or resolution[sid].lower() in (get(r, "locale") or "").lower()]
            chosen = hit[0] if len(hit) == 1 else None
            if chosen is None:
                sys.exit(f"ERROR: id_resolution for {sid} ('{resolution[sid]}') matches {len(hit)} of {len(rs)} rows")
        elif len(rs) == 1:
            chosen = rs[0]
        elif hints and sid in hints:                        # the lab workbook says which station / day it was
            d, loc = hints[sid]
            hit = [r for r in rs if (d and (get(r, "date") or "")[:10] == d[:10]) and (not loc or norm_place(get(r, "locale")) == loc)]
            hit = hit or [r for r in rs if loc and norm_place(get(r, "locale")) == loc]
            if len(hit) == 1:
                chosen = hit[0]
        if chosen is None and len(rs) > 1 and sid not in resolution:
            made = [make(r, sid) for r in rs]
            key = lambda m: (m["date"], m["lat"], m["lon"], m["area"])
            if all(key(m) == key(made[0]) for m in made):
                chosen = rs[0]                                  # duplicates that say the same thing
        if chosen is None:
            ambiguous[sid] = [(get(r, "date")[:16], get(r, "locale")[:30]) for r in rs]
            continue
        meta[sid] = make(chosen, sid)
        date_notes[meta[sid]["date_quality"]] += 1
        if col["name"] is not None and get(chosen, "name").strip():
            owner[sid] = get(chosen, "name")
    opts.from_comment = sorted(set(from_comment) & set(meta))
    return meta, owner, ambiguous, date_notes


# ----------------------------------------------------------------------------------------------
# LAB WORKBOOK (.xlsx): date, position and water chemistry per Sample_Name  (Kysthjelperne 2025)
# ----------------------------------------------------------------------------------------------
WB_COLUMNS = {   # field: (exact headers, header prefixes)   - ONLY these columns are read; names, e-mails, comments never
    "id":       (["sample_name"], []),
    "date":     (["collection_date_time"], []),
    "coords":   (["coordinates"], []),
    "location": (["sample_location"], []),
    "area":     (["sample_area"], []),
    "tn":       (["tn (mg/l)"], ["tn"]),
    "toc":      (["npoc (mg/l)", "toc (mg/l)"], ["npoc", "toc"]),
    "totp":     (["totp (µg/l)"], ["elementalip", "tot-p", "totp"]),
}


def read_xlsx(path, sheet=None):
    """Minimal .xlsx reader (standard library only). Returns the rows of one sheet as lists of strings / None."""
    import zipfile
    import xml.etree.ElementTree as ET
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
          "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
    try:
        z = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as e:
        sys.exit(f"ERROR: cannot open {path} as an .xlsx file ({e})")
    with z:
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
        sheets = [(sh.get("name"), rels[sh.get("{%s}id" % ns["r"])]) for sh in wb.find("m:sheets", ns)]
        if sheet is None:
            sheet = sheets[0][0]
        target = next((t for n, t in sheets if n == sheet), None)
        if target is None:
            sys.exit(f"ERROR: no sheet '{sheet}' in {Path(path).name}. Sheets: {[n for n, _ in sheets]}")
        target = target.lstrip("/")
        target = target if target.startswith("xl/") else "xl/" + target
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns):
                shared.append("".join(t.text or "" for t in si.iter("{%s}t" % ns["m"])))
        out = []
        for row in ET.fromstring(z.read(target)).find("m:sheetData", ns).findall("m:row", ns):
            cells = {}
            for c in row.findall("m:c", ns):
                ref = re.match(r"([A-Z]+)", c.get("r")).group(1)
                col = 0
                for ch in ref:
                    col = col * 26 + ord(ch) - 64
                t, v = c.get("t"), c.find("m:v", ns)
                if t == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter("{%s}t" % ns["m"]))
                elif v is None or v.text is None:
                    continue
                elif t == "s":
                    val = shared[int(v.text)]
                elif t in ("str", "e"):
                    val = v.text
                elif t == "b":
                    val = "TRUE" if v.text == "1" else "FALSE"
                else:
                    try:
                        val = f"{float(v.text):.12g}"
                    except ValueError:
                        val = v.text
                cells[col - 1] = nfc(val)
            width = max(cells) + 1 if cells else 0
            out.append([cells.get(i) for i in range(width)])
    return out


def norm_place(s):
    return re.sub(r"[\s_\-]+", "", nfc(s or "").casefold())


def wb_clean(v):
    v = (v or "").strip()
    return "" if v.upper() in ("", "NA", "N/A", "X", "NONE", "#N/A", "#REF!") else v


def km_between(a, b):
    from math import asin, cos, radians, sin, sqrt
    (la1, lo1), (la2, lo2) = a, b
    h = sin(radians(la2 - la1) / 2) ** 2 + cos(radians(la1)) * cos(radians(la2)) * sin(radians(lo2 - lo1) / 2) ** 2
    return 12742 * asin(sqrt(h))


def read_workbook(opts, wanted):
    """-> (info, chem, stations, notes).  info[sid] = date/coords/location/area text (cleaned), chem[sid] = values.
    An ID on several rows is merged when the rows agree (empty cells filled), otherwise skipped and reported."""
    rows = read_xlsx(opts.workbook, opts.workbook_sheet)
    header = [(h or "").strip().lower() for h in rows[0]]
    over = {k: str(v).strip().lower() for k, v in (getattr(opts, "workbook_columns", None) or {}).items()}
    col = {}
    for k, (exact, pref) in WB_COLUMNS.items():
        cands = ([over[k]] if k in over else []) + exact
        i = next((header.index(c) for c in cands if c in header), None)
        if i is None:
            i = next((n for n, h in enumerate(header) for p in pref if h.startswith(p)), None)
        col[k] = i
    if col["id"] is None:
        sys.exit(f"ERROR: workbook sheet '{opts.workbook_sheet}' lacks a Sample_Name column. Headers: {rows[0]}")
    notes = {"missing_columns": [k for k, v in col.items() if v is None], "ambiguous": [], "rows": 0, "chem_total": 0}
    per, chem_ids = defaultdict(list), set()
    for r in rows[1:]:
        g = lambda k: (r[col[k]] if col[k] is not None and col[k] < len(r) else None)
        sid = norm_sample_id(g("id") or "")
        if not sid:
            continue
        notes["rows"] += 1
        if any(col[k] is not None and col[k] < len(r) and to_float(r[col[k]]) is not None for k in ("tn", "toc", "totp")):
            chem_ids.add(sid)
        if sid in wanted:
            per[sid].append({k: (g(k) or "").strip() for k in col if k != "id"})
    notes["chem_total"] = len(chem_ids)
    info, chem = {}, {}
    for sid, rs in per.items():
        merged, clash = {}, False
        for k in col:
            if k == "id":
                continue
            vals = {wb_clean(r[k]) for r in rs} - {""}
            if len(vals) > 1 and k in ("date", "coords", "location"):
                clash = True
            merged[k] = sorted(vals)[0] if vals else ""
            if k in ("tn", "toc", "totp"):
                nums = {to_float(r[k]) for r in rs} - {None}
                merged[k] = sorted(nums)[0] if len(nums) == 1 else None
                if len(nums) > 1:
                    clash = True
        if clash:
            notes["ambiguous"].append(sid)
            continue
        info[sid] = merged
        if any(merged[k] is not None for k in ("tn", "toc", "totp")):
            chem[sid] = {"tn": merged["tn"], "toc": merged["toc"], "totp": merged["totp"], "cond": None,
                         "salinity": None, "group": ""}
    stations = {}
    if getattr(opts, "station_sheet", None):
        try:
            srows = read_xlsx(opts.workbook, opts.station_sheet)
        except SystemExit:
            srows = []
        if srows:
            sh = [(h or "").strip().lower() for h in srows[0]]
            ci, ni = (sh.index("coordinates") if "coordinates" in sh else None), (sh.index("name") if "name" in sh else None)
            gi = sh.index("location") if "location" in sh else None
            if ci is not None and ni is not None:
                for r in srows[1:]:
                    if len(r) > max(ci, ni) and r[ni]:
                        lat, lng = parse_coords(r[ci] or "")
                        if lat is not None:
                            stations[norm_place(r[ni])] = (lat, lng, r[ni].strip(),
                                                           (r[gi] or "").strip() if gi is not None and gi < len(r) else "")
    return info, chem, stations, notes


def merge_workbook(opts, meta, info, stations, wanted, area_vocab, date_notes):
    """Fill what the survey export lacks: date, position (own coordinates, else the station's nominal position), area.
    The export wins when both have a value; clear disagreements are listed."""
    fills, conflicts, station_used = Counter(), [], []
    areas = Counter(a for a in area_vocab if a)
    known = {a for a, n in areas.items() if n >= 2}

    def area_from(text):
        t = re.sub(r"[\s_\-]*\d+\s*$", "", wb_clean(text)).strip(" ,;:.")
        if not t:
            return ""
        for k in sorted(known, key=len, reverse=True):
            if k.lower() in t.lower() or t.lower() in k.lower():
                return k
        return t if len(t) <= 25 else "Other"

    # distance between the station table and where samples of that station really were (finds table errors)
    per_station = defaultdict(list)
    for sid, w in info.items():
        m = meta.get(sid)
        key = norm_place(w["location"])
        if m and m["lat"] is not None and key in stations:
            per_station[key].append(km_between((m["lat"], m["lon"]), stations[key][:2]))
    bad_stations = sorted((stations[k][2], round(statistics.median(v), 1), len(v)) for k, v in per_station.items()
                          if len(v) >= 2 and statistics.median(v) > 3)

    for sid in sorted(wanted, key=lambda x: (not x.isdigit(), int(x) if x.isdigit() else 0, x)):
        w = info.get(sid)
        if w is None:
            continue
        m = meta.get(sid)
        iso, q = parse_date(re.sub(r"\(.*?\)", "", w["date"]).strip(), opts.year) if wb_clean(w["date"]) else ("", "missing")
        lat, lng = parse_coords(w["coords"]) if wb_clean(w["coords"]) else (None, None)
        src = "workbook"
        if lat is None and norm_place(w["location"]) in stations:
            lat, lng = stations[norm_place(w["location"])][:2]
            src = "station"
        if lat is not None:
            lat, lng = round(lat, opts.coord_decimals), round(lng, opts.coord_decimals)
        st_row = stations.get(norm_place(w["location"]))
        area_text = (st_row[3] if st_row else "") or w["area"] or w["location"]      # the station table has clean area names
        if m is None:
            if iso or lat is not None:
                meta[sid] = {"date": iso, "date_quality": q, "lat": lat, "lon": lng, "pos_source": src if lat is not None else "",
                             "area": area_from(area_text), "push": None, "volume_ml": None}
                fills["new sample (not in the survey export)"] += 1
                if src == "station":
                    station_used.append(sid)
                date_notes[q] += 1
            continue
        if not m["date"] and iso:
            m["date"], m["date_quality"] = iso, q
            fills["date"] += 1
        elif m["date"] and iso and m["date"] != iso:
            conflicts.append(f"{sid}: date {m['date']} (export) vs {iso} (workbook)")
        if m["lat"] is None and lat is not None:
            m["lat"], m["lon"], m["pos_source"] = lat, lng, src
            fills["position " + ("from own coordinates" if src == "workbook" else "from the station")] += 1
            if src == "station":
                station_used.append(sid)
        elif m["lat"] is not None and src == "workbook" and km_between((m["lat"], m["lon"]), (lat, lng)) > 1.0:
            conflicts.append(f"{sid}: position {km_between((m['lat'], m['lon']), (lat, lng)):.1f} km apart (export vs workbook)")
        if not m["area"]:
            a = area_from(area_text)
            if a:
                m["area"] = a
                fills["area"] += 1
    return fills, conflicts, station_used, bad_stations


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
    lim = {**QC_LIMITS, **(getattr(opts, "qc_limits", None) or {})}
    flags, totp_flag, totp = [], "", c["totp"]
    if opts.totp_one_means_below and totp is not None and totp == 1:
        totp, totp_flag = None, f"<{opts.totp_one_means_below:g}"
    if c["tn"] is not None and lim["tn_mgl_min"] is not None and c["tn"] < lim["tn_mgl_min"]:
        flags.append("tn")
    if c["toc"] is not None and lim["toc_mgl_max"] is not None and c["toc"] > lim["toc_mgl_max"]:
        flags.append("toc")
    if totp is not None and lim["totp_ugl_max"] is not None and totp > lim["totp_ugl_max"]:
        flags.append("totp")
    if (c["cond"] is not None and c["salinity"] is not None
            and c["cond"] < lim["cond_mscm_min"] and c["salinity"] >= lim["salinity_for_cond_check"]):
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

    lca = opts.species_format == "lca"
    ambiguous = {}
    if lca:
        # ---- LCA table first (it decides which samples exist), then the sampling log for date + position ----
        runs, main_run = read_lca(opts.species, opts)
        wanted = {k[0] for k in runs}
        wb_info, wb_chem, stations, wb_notes = {}, {}, {}, None
        if getattr(opts, "workbook", None):
            wb_info, wb_chem, stations, wb_notes = read_workbook(opts, wanted)
        hints = {}
        for sid, w in wb_info.items():
            d, _ = parse_date(re.sub(r"\(.*?\)", "", w["date"]).strip(), opts.year) if wb_clean(w["date"]) else ("", "")
            hints[sid] = (d, norm_place(w["location"]))
        if opts.metadata_format == "sampling_log":
            meta, meta_owner, ambiguous, date_notes = read_sampling_log_meta(opts.metadata, opts, wanted, hints)
        else:
            meta, meta_owner, date_notes = read_metadata_table(opts)
            meta = {k: v for k, v in meta.items() if k in wanted}
            meta_owner = {k: v for k, v in meta_owner.items() if k in wanted}
        chem, env_notes = (read_env(opts.env, opts) if opts.env else ({}, []))
        if wb_notes is not None:
            for sid in list(ambiguous):                    # the workbook may know the answer when the export does not
                if sid in wb_info and sid not in meta:
                    ambiguous.pop(sid)
            opts.wb_report = merge_workbook(opts, meta, wb_info, stations, wanted, [m["area"] for m in meta.values()], date_notes)
            for sid, c in wb_chem.items():
                chem.setdefault(sid, c)
            opts.wb_notes = wb_notes
    else:
        meta, meta_owner, date_notes = read_metadata_table(opts)
        chem, env_notes = read_env(opts.env, opts)
        runs = read_species(opts.species)
        main_run = {}
    opts.ambiguous = ambiguous
    opts.date_notes = date_notes
    opts.main_run = main_run
    return finish_build(opts, reg, meta, meta_owner, chem, env_notes, runs, date_notes)


def read_metadata_table(opts):
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
    return meta, meta_owner, date_notes


def finish_build(opts, reg, meta, meta_owner, chem, env_notes, runs, date_notes):
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
    seq_ids = {k[0] for k in runs}
    if opts.species_format == "lca":                 # only samples that were sequenced; the log also holds unsequenced ones
        ids = {s for s in seq_ids if not ctl_type(s)}
    else:
        ids = set(meta) | set(chem) | {s for s in seq_ids if not ctl_type(s)}
    ctl_ids = {s for s in seq_ids if ctl_type(s)}
    order = lambda x: (not x.isdigit(), int(x) if x.isdigit() else 0, x)
    sample_rows, long_rows = [], []
    for sid in sorted(ids, key=order) + sorted(ctl_ids, key=order):
        is_ctl = bool(ctl_type(sid))
        m, c = meta.get(sid), chem.get(sid)
        variants = sorted(v for (i, v) in runs if i == sid)
        prim = runs.get((sid, ""))
        row = {k: "" for k in PUBLIC_SAMPLE_COLS}
        row.update(project=opts.project, sample_id=sid,
                   sample_type=ctl_type(sid) or "sample",
                   has_meta=int(m is not None), has_chem=int(c is not None), has_species=int(bool(variants)),
                   seq_variants="|".join(v or "main" for v in variants), main_run=opts.main_run.get(sid, ""),
                   sampler_hash=sampler_of.get(sid, ""))
        if m:
            row.update(date=m["date"], date_quality=m["date_quality"], pos_source=m.get("pos_source", ""),
                       lat=fmt(m["lat"], opts.coord_decimals),
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


def approved_words():
    """Words from approved_words.txt (ordinary words / place names, never a person's name)."""
    out = set()
    f = Path(kc.HOME_DIR) / "approved_words.txt"
    if f.exists():
        for line in f.read_text(encoding="utf-8-sig").splitlines():
            line = nfc(line).strip().lower()
            if line and not line.startswith("#"):
                out.add(line)
    return out


def verify_public(paths, colsets, opts, skip_name_cols=()):
    problems = []
    tokens = private_name_tokens(opts.private_dir)
    letter = r"(?<![^\W\d_]){}(?![^\W\d_])"
    make_rx = lambda toks: re.compile(letter.format("(?:" + "|".join(re.escape(t) for t in sorted(toks, key=len, reverse=True)) + ")"),
                                      re.I) if toks else None
    rx = make_rx(tokens)
    # a place word that is also part of a registry name (e.g. a club called "Sandefjord ...") is allowed in the AREA
    # column only, and only when you approved it in approved_words.txt; everywhere else it is still blocked
    rx_area = make_rx(tokens - approved_words())
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
                    rxc = rx_area if col == "area" else rx
                    if rxc and col not in skip_name_cols and rxc.search(val):
                        problems.append(f"{path.name} line {i}, {col}: contains a name from the private registry ({rxc.search(val).group(0)!r})"
                                        + (" - if this is only a place name, add it to approved_words.txt" if col == "area" else ""))
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
    n_seq = len({k[0] for k in runs if not ctl_type(k[0])})
    print(f"Samples: {len(ids)}  (metadata {len(meta)}, chemistry {len(chem)}, species {n_seq})   "
          f"{'with date+position and sequences: ' + str(len([s for s in ids if s in meta and s in {k[0] for k in runs}])) if opts.species_format == 'lca' else 'in all three: ' + str(len(both))}")
    nometa = sorted((s for s in ids if s not in meta), key=lambda x: (not x.isdigit(), int(x) if x.isdigit() else 0))
    print(f"Without metadata (no date/position, kept for statistics): {len(nometa)}  {nometa}")
    print(f"Controls kept apart from samples: {sorted(k[0] for k in runs if ctl_type(k[0]))}")
    for sid, cand in sorted(getattr(opts, "ambiguous", {}).items()):
        print(f"   AMBIGUOUS ID {sid}: {len(cand)} rows in the sampling log {cand} -> published WITHOUT date/position. "
              f"Pick one with \"id_resolution\": {{\"{sid}\": \"<date or station>\"}} in project.json.")
    if getattr(opts, "wb_notes", None) is not None:
        fills, conflicts, station_used, bad_stations = opts.wb_report
        wn = opts.wb_notes
        print(f"\n--- Lab workbook ({Path(opts.workbook).name}, sheet {opts.workbook_sheet}) ---")
        print(f"Rows in the workbook: {wn['rows']};  chemistry for {len(chem)} of the {len(ids)} sequenced samples "
              f"(the workbook has chemistry for {wn['chem_total']} samples in all; the rest are not sequenced and not published)")
        if wn["missing_columns"]:
            print(f"   NOTE: columns not found in the workbook: {wn['missing_columns']}")
        print(f"Filled from the workbook: {dict(fills) or 'nothing'}")
        if station_used:
            print(f"   position = the station's nominal position (own coordinates missing) for: {sorted(station_used, key=lambda x: (not x.isdigit(), int(x) if x.isdigit() else 0))}")
        for t in wn["ambiguous"]:
            print(f"   AMBIGUOUS in the workbook: {t} has several rows that disagree -> not used from the workbook")
        for c in conflicts:
            print(f"   DISAGREEMENT export vs workbook: {c}  (the survey export was kept)")
        for name, km, n in bad_stations:
            print(f"   CHECK station table: '{name}' is on average {km} km from where its {n} samples were taken - wrong coordinates in the Location sheet?")
        lim = {**QC_LIMITS, **(getattr(opts, 'qc_limits', None) or {})}
        print(f"QC limits used: TOC/NPOC max {lim['toc_mgl_max']}, Tot-P max {lim['totp_ugl_max']}, TN min {lim['tn_mgl_min']}  (project.json 'qc_limits')")
    if getattr(opts, "from_comment", None):
        print(f"   ID cell was empty, number taken from the comment ('Prøvenr ...'): {opts.from_comment}  - check these.")
    if opts.species_format == "lca":
        mains = Counter(opts.main_run.get(i, "") for i in ids)
        print(f"Main run per sample (priority {opts.run_priority}): {dict(mains)}")
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
    o.species_format = args.species_format or e.get("species_format") or "seq_files"
    o.metadata_format = args.metadata_format or e.get("metadata_format") or "table"
    o.run_priority = e.get("run_priority") or ["H", "R", "M"]
    o.id_resolution = e.get("id_resolution") or {}
    o.workbook = str(kc.in_project(cfg, e["workbook"])) if e.get("workbook") else None
    o.workbook_sheet = e.get("workbook_sheet") or "Metadata"
    o.station_sheet = e.get("station_sheet")
    o.workbook_columns = e.get("workbook_columns") or {}
    o.qc_limits = e.get("qc_limits") or {}
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
    o.species_format = getattr(o, "species_format", None) or "seq_files"
    o.metadata_format = getattr(o, "metadata_format", None) or "table"
    o.run_priority = getattr(o, "run_priority", None) or ["H", "R", "M"]
    o.id_resolution = getattr(o, "id_resolution", None) or {}
    if o.species_format not in ("seq_files", "lca"):
        sys.exit("ERROR: species_format must be 'seq_files' or 'lca'")
    if o.metadata_format not in ("table", "sampling_log"):
        sys.exit("ERROR: metadata_format must be 'table' or 'sampling_log'")
    needed = ("project", "metadata", "species", "year") if o.species_format == "lca" else ("project", "metadata", "env", "species", "year")
    for need in needed:
        if getattr(o, need, None) in (None, ""):
            sys.exit(f"ERROR: '{need}' is missing - set it in project.json or with --{need.replace('_', '-')}")
    for f in (o.metadata, o.env, o.species, getattr(o, "workbook", None)):
        if f and not Path(f).exists():
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
    ap.add_argument("--species-format", choices=["seq_files", "lca"], default=None,
                    help="seq_files = rows named 10_S5_L001_R1_001 (2022);  lca = rows named H-2013 / R-2013 / H-N2660 / H-MOCK")
    ap.add_argument("--metadata-format", choices=["table", "sampling_log"], default=None,
                    help="table = cleaned metadata file;  sampling_log = the survey export with Prøve ID / Koordinater")
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

    for need in ("project", "metadata", "species", "year") + (() if args.species_format == "lca" else ("env",)):
        if getattr(args, need) is None:
            ap.error(f"--{need} is required (or use --project-dir / --all)")
    args.meta_columns, args.env_columns = {}, {}
    build(finalize(args))


if __name__ == "__main__":
    main()
