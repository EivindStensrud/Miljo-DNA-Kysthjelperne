#!/usr/bin/env python3
"""
sanitize_data.py  –  turn the raw survey export into a CSV that is safe to publish.

USAGE
    python sanitize_data.py                      # raw_data.csv -> safe_sampling_data.csv
    python sanitize_data.py raw.csv safe.csv     # explicit file names
    python sanitize_data.py --no-comments        # also drop the free-text comment column
                                                 # (the only 100 % guarantee for comments)
    python sanitize_data.py --remove-name "Trine Flagstad" --remove-name "Øyvind Wistrøm"
                                                 # force-remove names that are not in the survey's name column
                                                 # (or list them, one per line, in names_to_remove.txt)
    python sanitize_data.py --scan safe_sampling_data.csv
                                                 # AUDIT a CSV that already exists / is already published

DESIGN – "fail closed"
    1. ALLOW-LIST, not block-list: only the columns the dashboard needs are written. Any other
       column (including new ones added to the survey later) is dropped automatically.
    2. Every kept column is validated by what it is supposed to contain
       (dates look like dates, coordinates look like coordinates, ...).
    3. Free-text columns are scrubbed for: e-mail, phone numbers, personal ID numbers, links,
       @handles, street addresses, sign-offs ("Mvh ...", "tatt av ..."), every name found in the
       raw file's name/e-mail columns, and any unknown Capitalised Word that looks like a name.
    4. The finished file is re-read and checked again. If ANYTHING suspicious is left, the output
       file is deleted and the script exits with an error. No file = nothing can be published by accident.

    No detector can recognise every possible name written in free text. Review the report, and use
    --no-comments if you need a guarantee.

KEEP OUT OF GIT
    raw_data.csv contains personal data. Add it to .gitignore and never commit it:
        raw_data.csv
        approved_words_local.txt   (optional)
"""
import argparse
import csv
import io
import os
import re
import subprocess
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

# ----------------------------------------------------------------------------------------------
# CONFIG
# ----------------------------------------------------------------------------------------------
DELIMITER = ";"

# (key, header-prefix in the raw file, kind)  – ONLY these columns are ever written.
#   kinds: date | coords | id | label | text | comment
KEEP_COLUMNS = [
    ("date",      "Tid og dato for prøvetakning", "date"),
    ("area",      "Prøvetakningsområde",          "label"),
    ("locale",    "Prøvetakningslokale",          "label"),
    ("sample_id", "Prøve ID",                     "id"),
    ("coords",    "Koordinater",                  "coords"),
    ("volume",    "Antall mL",                    "text"),
    ("note",      "Om annet",                     "comment"),
]

# Raw columns whose headers match this are treated as sources of personal names to remove from text.
NAME_HEADER_RE = re.compile(r"navn|name|e-?post|mail|tlf|telefon|mobil|phone", re.I)

# Words that are NOT names although they look like it (place names, products ...).
# Easiest: put them in approved_words.txt next to this script, one per line.
APPROVED_WORDS_FILE = "approved_words.txt"
BUILTIN_APPROVED = {"oslofjorden", "oslofjord", "norge", "norway"}

# ----------------------------------------------------------------------------------------------
# DETECTORS
# ----------------------------------------------------------------------------------------------
EMAIL = re.compile(r"[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+")
EMAIL_OBFUSCATED = re.compile(
    r"(?i)[\w.+\-]+\s*(?:\(at\)|\[at\]|\{at\}|\(snabel-a\))\s*[\w\-]+\s*(?:\(dot\)|\[dot\]|\bdot\b|\bpunktum\b)\s*\w+")
HANDLE = re.compile(r"(?<![\w@])@[\w.]{3,}")
URL = re.compile(r"(?i)\b(?:https?://|www\.)\S+|\b[\w\-]+\.(?:com|no|org|net|se|dk|io)\b\S*")

# 8-digit Norwegian numbers (also grouped 12 34 56 78 / 123 45 678), optional +47 / 0047 / other country code.
# The look-arounds stop it from eating decimals such as 59.12345678.
PHONE = re.compile(
    r"""(?<![\d.,])
        (?:(?:\+|00)\s?\d{1,3}[\s.\-]?)?
        (?:\d{8} | \d{3}[\s.\-]\d{2}[\s.\-]\d{3} | \d{2}(?P<s>[\s.\-])\d{2}(?P=s)\d{2}(?P=s)\d{2} | \d{4}[\s.\-]\d{4})
        (?!\d|[.,]\d)""", re.X)
INTL_PHONE = re.compile(r"(?<!\w)\+\d[\d\s.\-]{6,}\d")
NATIONAL_ID = re.compile(r"(?<![\d.,])\d{6}[\s\-]?\d{5}(?!\d)")

STREET = re.compile(
    r"(?i)\b[A-ZÆØÅ][\wæøåÆØÅ\-]*(?:veien|vegen|veg|vei|gata|gaten|gate|alle|allé|plassen|plass|stien|bakken|"
    r"svingen|lia|toppen|løkka|terrasse|torget|brygge)\s+\d+\s?[A-Za-z]?\b"
    r"(?:\s*,?\s*\d{4}\s+[A-ZÆØÅ][\wæøåÆØÅ]+)?")

# Everything from one of these phrases to the end of the cell is cut (signatures, "taken by ...", contact info).
SIGNOFF = re.compile(
    r"(?i)(?<!\w)(?:med\s+vennlig\s+hilsen|vennlig\s+hilsen|hilsen|hilsner|mvh|mvg|vh|best\s+regards|kind\s+regards|"
    r"regards|cheers|på\s+vegne\s+av|tatt\s+av|utført\s+av|gjort\s+av|sendt\s+av|innsamlet\s+av|samlet\s+inn\s+av|"
    r"prøvetaker|jeg\s+heter|mitt\s+navn|my\s+name|navn\s*:|kontaktperson|kontakt|tlf|tel|telefon|mobil|"
    r"e-?post\w*|mail\w*|adresse\w*|address)(?!\w)")

# Any run of >= 3 LETTERS in any alphabet (æøå, äöü, é, ë, ç, ł ...). \w would also match digits/underscore.
WORD = re.compile(r"(?<!\w)[^\W\d_]{3,}(?!\w)")


def is_capitalised(word):
    """Name-like: starts with a capital and contains lower-case letters (Åse, Zoë, Björn, McDonald; not NFR)."""
    return word[0].isupper() and any(c.islower() for c in word[1:])

DATE_OK = re.compile(r"^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$")
COORD_CHARS = re.compile(r"^[\d\s.,;:/()°'\"′″’\-+NSEWØOøwgs]*$", re.I)
COORD_URL = re.compile(
    r"^(https?://(?:maps\.app\.goo\.gl|goo\.gl/maps|www\.google\.[a-z.]+/maps|maps\.google\.[a-z.]+|"
    r"www\.openstreetmap\.org|norgeskart\.no|kart\.finn\.no)/[^\s?#]*)(?:[?#]\S*)?$", re.I)
ID_OK = re.compile(r"^[A-Za-z0-9._\-# ]{1,20}$")


def sentence_initial(text, pos):
    before = text[:pos].rstrip(" \"“«('-")
    return before == "" or before[-1] in ".!?:;/\n"


def nfc(text):
    """Unicode NFC: 'å' typed as a + combining ring (common from Mac/iOS) becomes the single character å.
    Without this the same name written two ways would not match."""
    return unicodedata.normalize("NFC", text)


def read_text(path):
    """Read the raw export whatever encoding Excel / the survey tool used. Returns (text, note)."""
    data = Path(path).read_bytes()
    note = ""
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = data.decode("cp1252")
        except UnicodeDecodeError:
            text = data.decode("latin-1")
        note = "input was NOT UTF-8 (Windows-1252 assumed) - converted to UTF-8"
    if re.search(r"Ã[\u0080-\u00bf\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2018-\u203a\u20ac\u2122]", text):
        try:                                           # text that was UTF-8 but decoded as Windows-1252 earlier
            text = text.encode("cp1252").decode("utf-8")
            note = "input looked double-encoded (Ã¸ instead of ø) - repaired"
        except (UnicodeEncodeError, UnicodeDecodeError):
            note = "WARNING: input contains 'Ã' sequences (broken æøå) that could not be repaired automatically"
    return text, note


# ----------------------------------------------------------------------------------------------
# NAME DICTIONARY
# ----------------------------------------------------------------------------------------------
def name_tokens(values):
    """Every word (>= 3 letters) from the raw name / e-mail / phone columns."""
    tokens = set()
    for v in values:
        if not v:
            continue
        v = v.split("@")[0] if "@" in v and " " not in v.strip() else v   # e-mail: use the local part only
        for t in WORD.findall(nfc(v)):
            tokens.add(t.lower())
    return tokens


def build_name_regex(tokens):
    if not tokens:
        return None
    alt = "|".join(sorted((re.escape(t) for t in tokens), key=len, reverse=True))
    return re.compile(rf"(?<!\w)(?:{alt})(?:s|'s)?(?!\w)", re.I)


# ----------------------------------------------------------------------------------------------
# SCRUBBING
# ----------------------------------------------------------------------------------------------
class Scrubber:
    def __init__(self, name_regex, approved, label_vocab, common_lower=None):
        self.name_regex = name_regex
        self.approved = approved
        self.label_vocab = label_vocab
        self.common_lower = common_lower or set()
        self.common_starters = set()            # capitalised words that start sentences in >= 2 different comments
        self.suspect_words = Counter()          # unknown capitalised words that were removed

    def word_ok(self, word, initial):
        """True if a Capitalised word is clearly NOT a name."""
        w = word.lower()
        if w in self.common_lower or w in self.approved or w in self.label_vocab:
            return True
        # A word that opens sentences in several different comments is an ordinary word ("Hei", "Ellers").
        # Names of submitters are removed through the name dictionary anyway.
        return initial and w in self.common_starters

    def basic(self, text, why):
        """Deterministic removals. Each step works on the RESULT of the previous one."""
        steps = [
            (EMAIL, "[REDACTED_EMAIL]", "e-mail"),
            (EMAIL_OBFUSCATED, "[REDACTED_EMAIL]", "e-mail"),
            (URL, "[REDACTED_LINK]", "link"),
            (HANDLE, "[REDACTED_HANDLE]", "handle"),
            (NATIONAL_ID, "[REDACTED_ID]", "national id"),
            (INTL_PHONE, "[REDACTED_PHONE]", "phone"),
            (PHONE, "[REDACTED_PHONE]", "phone"),
            (STREET, "[REDACTED_ADDRESS]", "address"),
        ]
        for rx, repl, label in steps:
            text, n = rx.subn(repl, text)
            if n:
                why[label] += n
        m = SIGNOFF.search(text)
        if m:
            text = text[:m.start()].rstrip(" ,.;:-") + " [REDACTED_SIGNATURE]"
            why["sign-off / contact phrase"] += 1
        if self.name_regex:
            text, n = self.name_regex.subn("[REDACTED_NAME]", text)
            if n:
                why["known name"] += n
        if "@" in text:                                    # paranoia: nothing with an @ survives
            text = re.sub(r"\S*@\S*", "[REDACTED_EMAIL]", text)
            why["e-mail"] += 1
        return text

    def unknown_names(self, text, why):
        """Capitalised words that are not ordinary words, place names or approved words -> removed."""
        def repl(m):
            if not is_capitalised(m.group(0)) or self.word_ok(m.group(0), sentence_initial(m.string, m.start())):
                return m.group(0)
            self.suspect_words[m.group(0)] += 1
            why["unknown capitalised word"] += 1
            return "[REDACTED_NAME]"
        return WORD.sub(repl, text)


def check_coords(value, why):
    v = value.strip()
    if not v:
        return value
    if COORD_URL.match(v):
        return value                                       # map link: kept exactly as written
    if COORD_CHARS.match(v) and not (PHONE.fullmatch(v) or INTL_PHONE.fullmatch(v)):   # a lone phone number is not a coordinate
        return value
    why["coordinates cell not a coordinate"] += 1
    return ""


# ----------------------------------------------------------------------------------------------
# MAIN
# ----------------------------------------------------------------------------------------------
def load_approved(script_dir):
    words = set(BUILTIN_APPROVED)
    for folder in {Path.cwd(), script_dir}:
        f = folder / APPROVED_WORDS_FILE
        if f.exists():
            for line in f.read_text(encoding="utf-8").splitlines():
                line = nfc(line.split("#")[0].strip().lower())
                if line:
                    words.add(line)
    return words


EXTRA_NAMES_FILE = "names_to_remove.txt"


def load_extra_names(cli_names):
    """Names you want removed no matter what (third parties, colleagues ...). Whole names or single words."""
    names = list(cli_names or [])
    for folder in {Path.cwd(), Path(__file__).resolve().parent}:
        f = folder / EXTRA_NAMES_FILE
        if f.exists():
            names += [ln.split("#")[0].strip() for ln in f.read_text(encoding="utf-8").splitlines()]
    return {t for n in names if n for t in name_tokens([n])}


def scan_file(path, cli_names):
    """Audit any CSV (for example the one that is live on the website). Prints what looks personal."""
    text, note = read_text(path)
    reader = csv.DictReader(io.StringIO(text, newline=""), delimiter=DELIMITER)
    rows = [{nfc(k): nfc(v or "") for k, v in r.items() if k is not None} for r in reader]
    headers = list(rows[0].keys()) if rows else []
    name_regex = build_name_regex(load_extra_names(cli_names))
    approved = load_approved(Path(__file__).resolve().parent)

    def kind_of(h):
        for key, prefix, kind in KEEP_COLUMNS:
            if h.startswith(nfc(prefix)):
                return kind
        return "text"                                   # unknown column: treat as free text

    kinds = {h: kind_of(h) for h in headers}
    vocab = Counter()
    for h in headers:
        if kinds[h] == "label":
            for r in rows:
                vocab.update(w.lower() for w in set(WORD.findall(r[h])))
    scrub = Scrubber(name_regex, approved, {w for w, n in vocab.items() if n >= 2})
    scrub.common_lower = {w for r in rows for h in headers if kinds[h] in ("comment", "text", "id")
                          for w in WORD.findall(r[h]) if w.islower()}
    starters = Counter()
    for r in rows:
        seen = set()
        for h in headers:
            if kinds[h] in ("comment", "text", "id"):
                seen |= {m.group(0).lower() for m in WORD.finditer(r[h])
                         if is_capitalised(m.group(0)) and sentence_initial(r[h], m.start())}
        starters.update(seen)
    scrub.common_starters = {w for w, n in starters.items() if n >= 2}

    findings = []
    for i, r in enumerate(rows, start=1):
        for h in headers:
            v = r[h]
            if not v or kinds[h] in ("date", "coords"):
                continue
            hits = []
            for rx, label in ((EMAIL, "e-mail"), (PHONE, "phone"), (INTL_PHONE, "phone"), (NATIONAL_ID, "national id"),
                              (URL, "link"), (STREET, "address"), (SIGNOFF, "sign-off / contact phrase")):
                hits += [(label, m.group(0)) for m in rx.finditer(v)]
            if name_regex:
                hits += [("listed name", m.group(0)) for m in name_regex.finditer(v)]
            if kinds[h] in ("comment", "text"):
                hits += [("possible name", m.group(0)) for m in WORD.finditer(v)
                         if is_capitalised(m.group(0)) and not scrub.word_ok(m.group(0), sentence_initial(v, m.start()))]
            for label, snippet in hits:
                findings.append((i, h[:28], label, snippet))
    print(f"\n=============== AUDIT of {path} ({len(rows)} rows) ===============")
    if note:
        print("Encoding:", note)
    if not findings:
        print("Nothing suspicious found.")
    else:
        print(f"{len(findings)} suspicious items (row = data row, 1 = first):")
        for i, h, label, snippet in findings[:200]:
            print(f"  row {i:4d} | {h:28s} | {label:26s} | {snippet[:50]}")
        if len(findings) > 200:
            print(f"  ... and {len(findings) - 200} more")
        print("\nThis file is NOT safe to publish. Re-create it with sanitize_data.py from the raw export.")
    print("=========================================================")
    return 1 if findings else 0


def git_warning(raw_path):
    try:
        cwd = raw_path.resolve().parent
        tracked = subprocess.run(["git", "ls-files", "--error-unmatch", raw_path.name], cwd=cwd,
                                 capture_output=True).returncode == 0
        ignored = subprocess.run(["git", "check-ignore", "-q", raw_path.name], cwd=cwd,
                                 capture_output=True).returncode == 0
        inside = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], cwd=cwd,
                                capture_output=True).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return
    if tracked:
        print("\n!!! DANGER: the RAW file is tracked by git. Remove it from the repository AND its history.")
    elif inside and not ignored:
        print(f"\n!!! WARNING: {raw_path.name} is inside a git repo and not in .gitignore. Add it now.")


def sanitize(input_path, output_path, drop_comments, extra_names=()):
    script_dir = Path(__file__).resolve().parent
    approved = load_approved(script_dir)

    text, encoding_note = read_text(input_path)
    reader = csv.DictReader(io.StringIO(text, newline=""), delimiter=DELIMITER)
    raw_headers = list(reader.fieldnames or [])
    headers = [nfc(h) for h in raw_headers]
    rows = [{nfc(k): nfc(v or "") for k, v in r.items() if k is not None} for r in reader]

    # --- resolve columns --------------------------------------------------------------------
    plan = []                                     # (key, raw header, kind)
    for key, prefix, kind in KEEP_COLUMNS:
        if kind == "comment" and drop_comments:
            continue
        raw = next((h for h in headers if h.strip().startswith(nfc(prefix))), None)
        if raw is None:
            sys.exit(f"ERROR: expected column starting with '{prefix}' not found. Headers: {headers}")
        plan.append((key, raw, kind))
    kept = {raw for _, raw, _ in plan}
    dropped = [h for h in headers if h not in kept]

    # --- name dictionary from every column that is not kept ---------------------------------
    name_cols = [h for h in dropped if NAME_HEADER_RE.search(h)]
    tokens = set()
    for h in name_cols:
        tokens |= name_tokens(r.get(h, "") for r in rows)
    tokens -= approved
    tokens |= load_extra_names(extra_names)       # explicitly listed names are removed even if "approved"
    name_regex = build_name_regex(tokens)

    # --- vocabulary of genuine station / area words (appear in >= 2 rows) --------------------
    vocab_counter = Counter()
    for key, raw, kind in plan:
        if kind == "label":
            for r in rows:
                for w in set(WORD.findall(r.get(raw, ""))):
                    vocab_counter[w.lower()] += 1
    label_vocab = {w for w, n in vocab_counter.items() if n >= 2}

    # --- pass 1: deterministic scrub, collect ordinary lowercase words ------------------------
    scrub = Scrubber(name_regex, approved, label_vocab)
    cellflags = defaultdict(Counter)              # (row number, column) -> reasons that cell was changed
    staged = []
    lower_words = set()
    for i, r in enumerate(rows, start=1):
        out = {}
        for key, raw, kind in plan:
            val = r.get(raw, "") or ""
            why = cellflags[(i, raw)]
            if kind == "date":
                if val.strip() and not DATE_OK.match(val.strip()):
                    why["date not in expected format"] += 1
                    out[raw] = ""
                else:
                    out[raw] = val
            elif kind == "coords":
                out[raw] = check_coords(val, why)
            elif kind == "id" and ID_OK.match(val.strip()):
                out[raw] = val
            else:                                 # label / text / comment / odd id
                out[raw] = scrub.basic(val, why)
                if kind in ("comment", "text", "id"):
                    lower_words.update(w for w in WORD.findall(out[raw]) if w.islower())
        staged.append(out)
    scrub.common_lower = lower_words
    starter_docs = Counter()
    for out in staged:
        seen = set()
        for key, raw, kind in plan:
            if kind in ("comment", "text", "id"):
                for m in WORD.finditer(out[raw]):
                    if is_capitalised(m.group(0)) and sentence_initial(out[raw], m.start()):
                        seen.add(m.group(0).lower())
        starter_docs.update(seen)
    scrub.common_starters = {w for w, n in starter_docs.items() if n >= 2}

    # --- pass 2: unknown capitalised words in free text --------------------------------------
    for i, out in enumerate(staged, start=1):
        for key, raw, kind in plan:
            if kind in ("comment", "text", "id") and out[raw]:
                out[raw] = scrub.unknown_names(out[raw], cellflags[(i, raw)])

    # --- guarantee: a cell is only ever different from the input if a redaction was recorded for it ---
    flags = defaultdict(Counter)                  # row number -> reasons (for the report)
    unchanged = changed = 0
    for i, out in enumerate(staged, start=1):
        for key, raw, kind in plan:
            original = rows[i - 1].get(raw, "") or ""
            why = cellflags[(i, raw)]
            if out[raw] == original:
                unchanged += 1
                continue
            changed += 1
            if not why:
                sys.exit(f"INTERNAL ERROR: row {i}, column '{raw}' was altered without a redaction. Nothing written.")
            flags[i].update(why)
    stats = (unchanged, changed)

    # --- write ---------------------------------------------------------------------------------
    fieldnames = [raw for _, raw, _ in plan]
    with open(output_path, "w", encoding="utf-8-sig", newline="") as f:   # BOM: Excel shows æøå correctly
        w = csv.DictWriter(f, fieldnames=fieldnames, delimiter=DELIMITER)
        w.writeheader()
        w.writerows(staged)

    # --- independent verification of the FILE THAT WAS WRITTEN --------------------------------
    problems = verify(output_path, fieldnames, plan, name_regex, scrub)
    if problems:
        os.remove(output_path)
        print("\n!!! VERIFICATION FAILED – output file deleted. Nothing was published.")
        for p in problems[:30]:
            print("   ", p)
        sys.exit(2)

    report(input_path, output_path, rows, dropped, name_cols, tokens, flags, scrub, drop_comments, encoding_note, stats)
    git_warning(Path(input_path))


def verify(path, fieldnames, plan, name_regex, scrub):
    problems = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f, delimiter=DELIMITER)
        if reader.fieldnames != fieldnames:
            problems.append(f"unexpected header: {reader.fieldnames}")
        kinds = {raw: kind for _, raw, kind in plan}
        for i, r in enumerate(reader, start=1):
            for col, val in r.items():
                val = val or ""
                kind = kinds.get(col)
                if "@" in val:
                    problems.append(f"row {i}, {col}: '@' present")
                if kind in (None, "date", "coords"):
                    if kind is None:
                        problems.append(f"row {i}: unexpected column {col}")
                    continue
                if EMAIL.search(val) or PHONE.search(val) or INTL_PHONE.search(val) or NATIONAL_ID.search(val):
                    problems.append(f"row {i}, {col}: e-mail/phone/id pattern left")
                if URL.search(val) or STREET.search(val) or SIGNOFF.search(val):
                    problems.append(f"row {i}, {col}: link/address/sign-off left")
                if name_regex and name_regex.search(val):
                    problems.append(f"row {i}, {col}: known name left")
                if kind in ("comment", "text"):
                    for m in WORD.finditer(val):
                        if is_capitalised(m.group(0)) and not scrub.word_ok(m.group(0), sentence_initial(val, m.start())):
                            problems.append(f"row {i}, {col}: unreviewed capitalised word")
                            break
    return problems


def report(input_path, output_path, rows, dropped, name_cols, tokens, flags, scrub, drop_comments, encoding_note="", stats=(0, 0)):
    touched = {i: c for i, c in flags.items() if c}
    totals = Counter()
    for c in touched.values():
        totals.update(c)
    print("\n================== SANITIZATION REPORT ==================")
    print(f"Input : {input_path}  ({len(rows)} rows)")
    print(f"Output: {output_path}   <- verified clean by a second pass (UTF-8 with BOM, NFC)")
    if encoding_note:
        print(f"Encoding: {encoding_note}")
    print(f"Cells           : {stats[0]} copied exactly as written, {stats[1]} changed (each one = a redaction below)")
    print(f"Columns written : {len(KEEP_COLUMNS) - (1 if drop_comments else 0)}"
          f"{'  (comment column removed: --no-comments)' if drop_comments else ''}")
    print(f"Columns dropped : {len(dropped)}  {dropped}")
    print(f"Name dictionary : {len(tokens)} words from {name_cols or 'NO name columns found (!)'}")
    if not name_cols:
        print("   WARNING: no name/e-mail column in the raw file, so known names could not be removed.")
    print(f"\nRows modified   : {len(touched)} of {len(rows)}")
    for reason, n in totals.most_common():
        print(f"   {n:4d} x {reason}")
    if touched:
        print("\nRow numbers per reason (row 1 = first data row):")
        by_reason = defaultdict(list)
        for i, c in touched.items():
            for reason in c:
                by_reason[reason].append(i)
        for reason, idx in by_reason.items():
            shown = ", ".join(map(str, idx[:25])) + (" ..." if len(idx) > 25 else "")
            print(f"   {reason}: {shown}")
    if scrub.suspect_words:
        print("\nCapitalised words that were REMOVED because they could be names:")
        print("   " + ", ".join(f"{w} ({n})" for w, n in scrub.suspect_words.most_common(60)))
        print(f"   If some are harmless (place names, equipment), add them – one per line – to {APPROVED_WORDS_FILE}\n"
              f"   and run again. Do NOT approve anything that is a person's name.")
    print("\nNot detectable by any script: a first name written in lower case in the middle of a sentence.")
    print("Skim the 'Om annet' column once before publishing, or run with --no-comments.")
    print("=========================================================")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Create a publishable, privacy-safe sampling CSV.")
    ap.add_argument("input", nargs="?", default="raw_data.csv")
    ap.add_argument("output", nargs="?", default="safe_sampling_data.csv")
    ap.add_argument("--no-comments", action="store_true", help="drop the free-text comment column completely")
    ap.add_argument("--remove-name", action="append", default=[], metavar="NAME",
                    help="force-remove this name (repeatable); also read from names_to_remove.txt")
    ap.add_argument("--scan", metavar="CSV", help="audit an existing CSV instead of creating one")
    args = ap.parse_args()
    if args.scan:
        sys.exit(scan_file(args.scan, args.remove_name))
    if Path(args.input).resolve() == Path(args.output).resolve():
        sys.exit("ERROR: input and output must be different files.")
    sanitize(args.input, args.output, args.no_comments, args.remove_name)
