import re
from typing import Any, Dict, List, Optional, Tuple

import fitz  # PyMuPDF


# -----------------------------
# Helpers
# -----------------------------

def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())


def _safe_join(a: str, b: str) -> str:
    a = _clean(a)
    b = _clean(b)
    if not a:
        return b
    if not b:
        return a
    return _clean(a + " " + b)


def _next_meaningful(lines: List[str], start: int) -> str:
    i = start
    while i < len(lines):
        t = _clean(lines[i])
        if t:
            return t
        i += 1
    return ""


def _find_value_after_label(lines: List[str], label_re: re.Pattern, scan_limit: int = 80) -> str:
    """
    Handle both:
      "APPLICANT: A MALHOTRA ..."
    and
      "APPLICANT:" (next token is value) OR "APPLICANT:" + value on same line.
    """
    for i, raw in enumerate(lines[:scan_limit]):
        line = _clean(raw)
        if not line:
            continue

        m = label_re.match(line)
        if not m:
            continue

        # If label_re captures a value group, return it.
        if m.lastindex and m.lastindex >= 1:
            val = _clean(m.group(1))
            if val:
                return val

        # Otherwise try after ':' on same line
        if ":" in line:
            after = _clean(line.split(":", 1)[1])
            if after:
                return after

        # Otherwise next meaningful line
        nxt = _next_meaningful(lines, i + 1)
        return _clean(nxt)

    return ""


# -----------------------------
# Regex
# -----------------------------

# Section header: "2. PROPERTY"
SECTION_LINE_RE = re.compile(r"^(\d+)\.\s+([A-Z][A-Z\s&/\-]+)\s*$")

# Common broken extraction forms:
# "2." on one line and "PROPERTY" next line
SECTION_NUM_ONLY_RE = re.compile(r"^(\d+)\.\s*$")
UPPER_TITLE_RE = re.compile(r"^[A-Z][A-Z\s&/\-]{2,}$")

# Condition like: "2.1. text..."
COND_INLINE_RE = re.compile(r"^(\d+(?:\.\d+)+)\.\s+(.*)$")

# Condition number only line: "2.1."
COND_NUM_ONLY_RE = re.compile(r"^(\d+(?:\.\d+)+)\.\s*$")

# Notes that must NOT become titles
NOTE_START_RE = re.compile(
    r"^(This condition is imposed under|Further Advice:|Advice Note:|Note:)\b",
    re.I
)

# Plans table header
PLANS_HEADER_RE = re.compile(r"\bTitle\b.*\bPlan\b.*\bNumber\b", re.I)

# Stop markers (we stop parsing conditions when we hit “FURTHER ADVICE…” section at end)
FURTHER_ADVICE_RE = re.compile(r"^FURTHER ADVICE\b", re.I)
FURTHER_ADVICE_TO_APPLICANT_RE = re.compile(r"^FURTHER ADVICE TO THE APPLICANT\b", re.I)


# -----------------------------
# Normalise extracted lines
# -----------------------------

def _normalise_lines(lines: List[str]) -> List[str]:
    """
    Fix PyMuPDF splitting:
      "2." + "PROPERTY" -> "2. PROPERTY"
    Also split inline section headers embedded in other lines:
      "... Titles Office. 2. PROPERTY Display Street Number"
    """
    out: List[str] = []
    i = 0

    inline_section = re.compile(r"(.*?)(\b\d+\.\s+[A-Z][A-Z\s&/\-]+\b)(.*)")

    while i < len(lines):
        l = _clean(lines[i])
        if not l:
            i += 1
            continue

        # Combine "2." + "PROPERTY"
        mnum = SECTION_NUM_ONLY_RE.match(l)
        if mnum:
            nxt = _next_meaningful(lines, i + 1)
            if nxt and UPPER_TITLE_RE.match(_clean(nxt)):
                out.append(f"{mnum.group(1)}. {_clean(nxt)}")
                i += 2
                continue

        # Split inline section occurrences inside other text
        m = inline_section.match(l)
        if m and SECTION_LINE_RE.match(_clean(m.group(2))):
            a = _clean(m.group(1))
            b = _clean(m.group(2))
            c = _clean(m.group(3))
            if a:
                out.append(a)
            out.append(b)
            if c:
                out.append(c)
            i += 1
            continue

        out.append(l)
        i += 1

    return out


# -----------------------------
# PDF extraction
# -----------------------------

def _extract_lines_from_pdf_bytes(pdf_bytes: bytes) -> List[str]:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    raw: List[str] = []
    for page in doc:
        text = page.get_text("text") or ""
        for line in text.splitlines():
            t = _clean(line)
            if t:
                raw.append(t)
    doc.close()
    return _normalise_lines(raw)


# -----------------------------
# Cover/header extraction (Logan specific)
# -----------------------------

def _extract_logan_application_details(lines: List[str]) -> Tuple[Dict[str, str], Dict[str, str]]:
    """
    Returns:
      (applicationDetails, extractedCoverHeadings)

    extractedCoverHeadings is a debug-friendly dict of what we actually found.
    """
    scan_limit = 120

    # Cover labels
    applicant = _find_value_after_label(
        lines, re.compile(r"^APPLICANT\s*:?\s*(.*)$", re.I), scan_limit
    )
    app_no = _find_value_after_label(
        lines, re.compile(r"^APPLICATION\s+NUMBER\s*:?\s*(.*)$", re.I), scan_limit
    )
    type_desc = _find_value_after_label(
        lines, re.compile(r"^(TYPE\s*&\s*DESCRIPTION|TYPE\s+&\s+DESCRIPTION)\s*:?\s*(.*)$", re.I), scan_limit
    )

    officer_name = _find_value_after_label(
        lines, re.compile(r"^Officer\s+Name\s*:?\s*(.*)$", re.I), scan_limit
    )
    contact_number = _find_value_after_label(
        lines, re.compile(r"^Contact\s+Number\s*:?\s*(.*)$", re.I), scan_limit
    )
    document_number = _find_value_after_label(
        lines, re.compile(r"^Document\s+Number\s*:?\s*(.*)$", re.I), scan_limit
    )

    street_address = _find_value_after_label(
        lines, re.compile(r"^Street\s+Address\s*:?\s*(.*)$", re.I), scan_limit
    )
    real_prop = _find_value_after_label(
        lines, re.compile(r"^Real\s+Property\s+Description\s*:?\s*(.*)$", re.I), scan_limit
    )

    # TYPE & DESCRIPTION regex returns group(2) when present; _find_value_after_label returns group(1) by default.
    # So if it looks like it returned the label itself, try to fix.
    if type_desc.lower().startswith("type"):
        # fallback: find line containing "TYPE & DESCRIPTION" and take rest of line after ':'
        for ln in lines[:scan_limit]:
            if re.search(r"TYPE\s*&\s*DESCRIPTION", ln, re.I):
                if ":" in ln:
                    type_desc = _clean(ln.split(":", 1)[1])
                break

    extracted = {
        "applicant": applicant,
        "applicationNumber": app_no,
        "typeAndDescription": type_desc,
        "officerName": officer_name,
        "contactNumber": contact_number,
        "documentNumber": document_number,
        "streetAddress": street_address,
        "realPropertyDescription": real_prop,
    }

    # Map into your “working” applicationDetails shape
    application_details = {
        "addressOfSite": street_address,
        "realPropertyDescriptionOfSite": real_prop,
        "aspectsOfDevelopmentAndTypeOfApproval": type_desc,
        "councilFileReference": app_no or "",
        "permitReferenceNumbers": document_number or "",
        "packageStatus": "",
        "packageGenerated": "",
        # (optional extras you may want later)
        "applicant": applicant,
        "officerName": officer_name,
        "contactNumber": contact_number,
        "documentNumber": document_number,
    }

    return application_details, extracted


# -----------------------------
# Plans/documents extraction (best-effort)
# -----------------------------

def _extract_plans_table_best_effort(pdf_bytes: bytes, search_pages: int = 6) -> List[Dict[str, Any]]:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    plans: List[Dict[str, Any]] = []

    def cluster_lines(words: List[Tuple[float, float, float, float, str]], y_tol: float = 2.5):
        words = sorted(words, key=lambda w: (w[1], w[0]))
        lines: List[List[Tuple[float, float, float, float, str]]] = []
        for w in words:
            if not lines:
                lines.append([w])
                continue
            if abs(w[1] - lines[-1][0][1]) <= y_tol:
                lines[-1].append(w)
            else:
                lines.append([w])
        for ln in lines:
            ln.sort(key=lambda w: w[0])
        return lines

    def line_text(ln):
        return _clean(" ".join(w[4] for w in ln))

    def looks_like_header_row(t: str) -> bool:
        tl = _clean(t).lower()
        return ("title" in tl and "plan" in tl and "number" in tl) or (
            tl in {"title", "document", "number", "date", "prepared by", "rev/amd’t", "rev/amdt"}
        )

    for p_idx, page in enumerate(doc):
        if p_idx >= search_pages:
            break

        words_raw = page.get_text("words")
        words = [(w[0], w[1], w[2], w[3], _clean(w[4])) for w in words_raw if _clean(w[4])]
        if not words:
            continue

        lines = cluster_lines(words)
        header_i = None
        for i, ln in enumerate(lines):
            if PLANS_HEADER_RE.search(line_text(ln)):
                header_i = i
                break
        if header_i is None:
            continue

        header_ln = lines[header_i]
        header_words = [(w[0], w[4].lower()) for w in header_ln]

        def find_x(substr: str) -> Optional[float]:
            for x, txt in header_words:
                if substr in txt:
                    return x
            return None

        x_title = find_x("title") or header_ln[0][0]
        x_plan = find_x("plan") or find_x("document")
        x_rev = find_x("rev")
        x_date = find_x("date")
        x_prep = find_x("prepared")

        cols = [("title", x_title), ("planNumber", x_plan), ("revision", x_rev), ("date", x_date), ("preparedBy", x_prep)]
        cols = [(k, x) for k, x in cols if x is not None]
        cols.sort(key=lambda t: t[1])

        def assign_row(ln):
            buckets = {k: [] for k, _ in cols}
            for x0, y0, x1, y1, txt in ln:
                chosen = None
                for k, sx in cols:
                    if x0 >= sx - 1.0:
                        chosen = k
                if chosen:
                    buckets[chosen].append(txt)
            return {k: _clean(" ".join(v)) for k, v in buckets.items()}

        rows: List[Dict[str, Any]] = []
        for ln in lines[header_i + 1:]:
            t = line_text(ln)
            if not t:
                continue
            if SECTION_LINE_RE.match(t):
                break
            if looks_like_header_row(t):
                continue

            row = assign_row(ln)
            if looks_like_header_row(row.get("title", "")) or looks_like_header_row(row.get("planNumber", "")):
                continue

            if row.get("title") or row.get("planNumber"):
                rows.append({
                    "title": row.get("title", ""),
                    "planNumber": row.get("planNumber", ""),
                    "revision": row.get("revision", ""),
                    "date": row.get("date", ""),
                    "preparedBy": row.get("preparedBy", ""),
                })

        if rows:
            plans = rows
            break

    doc.close()
    return plans


def _map_plans_to_working_documents(plans: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    docs: List[Dict[str, Any]] = []
    for p in plans:
        title = _clean(p.get("title", ""))
        number = _clean(p.get("planNumber", ""))
        revision = _clean(p.get("revision", ""))
        plan_date = _clean(p.get("date", ""))
        prepared_by = _clean(p.get("preparedBy", ""))

        if not title and not number:
            continue

        docs.append({
            "title": title,
            "number": number,
            "planDate": plan_date,
            "revision": revision,
            "preparedBy": prepared_by,
        })
    return docs


# -----------------------------
# Conditions parsing
# -----------------------------

def _new_condition(num: str, title: str, desc: str) -> Dict[str, Any]:
    return {
        "number": _clean(num),
        "title": _clean(title),
        "description": _clean(desc),
        "timing": "",
        "timingSource": "",
        "timingColumn": "",
        "timingInline": "",
        "material": None,
        "children": [],
    }


def _prev_topic_title(lines: List[str], idx: int) -> str:
    j = idx - 1
    while j >= 0:
        t = _clean(lines[j])
        if not t:
            j -= 1
            continue
        if SECTION_LINE_RE.match(t):
            j -= 1
            continue
        if COND_INLINE_RE.match(t) or COND_NUM_ONLY_RE.match(t):
            j -= 1
            continue
        if NOTE_START_RE.match(t):
            j -= 1
            continue
        if re.match(r"^\d", t):
            j -= 1
            continue
        if len(t) > 120 and (t.endswith(".") or t.endswith(";")):
            j -= 1
            continue
        return t
    return ""


def _parse_conditions(lines: List[str]) -> List[Dict[str, Any]]:
    sections: List[Dict[str, Any]] = []
    current_section: Optional[Dict[str, Any]] = None
    cond_index: Dict[str, Dict[str, Any]] = {}

    def ensure_section(title: str):
        nonlocal current_section
        current_section = {"title": _clean(title), "conditions": []}
        sections.append(current_section)

    def attach_condition(c: Dict[str, Any]):
        num = c["number"]
        if "." in num:
            parent = ".".join(num.split(".")[:-1])
            if parent in cond_index:
                cond_index[parent]["children"].append(c)
                return
        if not current_section:
            ensure_section("UNSORTED")
        current_section["conditions"].append(c)

    i = 0
    while i < len(lines):
        line = _clean(lines[i])
        if not line:
            i += 1
            continue

        if FURTHER_ADVICE_TO_APPLICANT_RE.match(line) or FURTHER_ADVICE_RE.match(line):
            break

        ms = SECTION_LINE_RE.match(line)
        if ms:
            ensure_section(f"{ms.group(1)}. {ms.group(2)}")
            i += 1
            continue

        mc = COND_INLINE_RE.match(line)
        if mc:
            num = mc.group(1)
            desc = mc.group(2)
            title = _prev_topic_title(lines, i)
            c = _new_condition(num, title, desc)
            cond_index[num] = c
            attach_condition(c)
            i += 1

            while i < len(lines):
                nxt = _clean(lines[i])
                if not nxt:
                    i += 1
                    continue
                if SECTION_LINE_RE.match(nxt) or COND_INLINE_RE.match(nxt) or COND_NUM_ONLY_RE.match(nxt):
                    break
                c["description"] = _safe_join(c["description"], nxt)
                i += 1
            continue

        mn = COND_NUM_ONLY_RE.match(line)
        if mn:
            num = mn.group(1)
            title = _prev_topic_title(lines, i)
            c = _new_condition(num, title, "")
            cond_index[num] = c
            attach_condition(c)
            i += 1

            while i < len(lines):
                nxt = _clean(lines[i])
                if not nxt:
                    i += 1
                    continue
                if SECTION_LINE_RE.match(nxt) or COND_INLINE_RE.match(nxt) or COND_NUM_ONLY_RE.match(nxt):
                    break
                c["description"] = _safe_join(c["description"], nxt)
                i += 1
            continue

        i += 1

    # Drop empty UNSORTED if we later found real sections
    if sections and sections[0]["title"] == "UNSORTED":
        has_real = any(s["title"] != "UNSORTED" for s in sections)
        if has_real and not sections[0]["conditions"]:
            sections = sections[1:]

    return sections


def _count_conditions(sections: List[Dict[str, Any]]) -> int:
    def walk(c: Dict[str, Any]) -> int:
        n = 1
        for ch in (c.get("children") or []):
            n += walk(ch)
        return n

    total = 0
    for s in sections:
        for c in s.get("conditions", []):
            total += walk(c)
    return total


def _collect_section_headings(sections: List[Dict[str, Any]]) -> List[str]:
    return [s.get("title", "") for s in sections if s.get("title")]


# -----------------------------
# Public entrypoint
# -----------------------------

def parse_logan_conditions_pdf(file_bytes: bytes) -> Dict[str, Any]:
    lines = _extract_lines_from_pdf_bytes(file_bytes)

    application_details, extracted_cover = _extract_logan_application_details(lines)

    plans_raw = _extract_plans_table_best_effort(file_bytes, search_pages=6)
    documents = _map_plans_to_working_documents(plans_raw)

    sections = _parse_conditions(lines)

    return {
        "council": "LOGAN",
        "applicationDetails": application_details,
        "projectTeam": [],
        "documents": documents,
        "conditions": {"sections": sections},
        "headingElements": {
            "extractedCoverHeadings": extracted_cover,
            "detectedConditionSectionHeadings": _collect_section_headings(sections),
        },
        "summary": {
            "numberOfPlans": len(documents),
            "numberOfConditions": _count_conditions(sections),
        },
    }
