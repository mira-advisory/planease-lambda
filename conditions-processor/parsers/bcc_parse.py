import json
import re
from typing import Any, Dict, List, Optional, Tuple
from bs4 import BeautifulSoup


# ------------------------
# Text helpers
# ------------------------

def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def _find_marker(soup: BeautifulSoup, pattern: str):
    s = soup.find(string=re.compile(pattern, re.I))
    if not s:
        return None
    return s.find_parent(["p", "center", "span", "body", "div", "td", "tr"]) or s


def _parse_2col_table(table) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not table:
        return out
    for tr in table.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) < 2:
            continue
        label = _clean(tds[0].get_text(" ", strip=True)).rstrip(":")
        value = _clean(tds[1].get_text(" ", strip=True))
        if label:
            out[label] = value
    return out


# ------------------------
# Project details extractors
# ------------------------

def _parse_application_details(soup: BeautifulSoup) -> Dict[str, str]:
    marker = _find_marker(soup, r"\bAPPLICATION DETAILS\b")
    if not marker:
        return {}

    table = marker.find_next("table")
    raw = _parse_2col_table(table)

    def get(*keys: str) -> str:
        for k in keys:
            v = raw.get(k)
            if v:
                return v
        return ""

    address = get("Address of Site")
    rpd = get("Real Property Description of Site")
    aspects = get("Aspects of development and type of approval")
    council_ref = get("Council File Reference")
    permit_refs = get("Permit Reference Number/s", "Permit Reference Numbers")
    status = get("Package Status")
    generated = get("Package Generated")

    # Fix common quirk where "Council File Reference" value contains Permit Reference inline
    if council_ref and "permit reference" in council_ref.lower() and not permit_refs:
        m = re.search(
            r"^(.*?)\s*Permit Reference Number/s:\s*(.+)$",
            council_ref,
            flags=re.I,
        )
        if m:
            council_ref = _clean(m.group(1))
            permit_refs = _clean(m.group(2))

    return {
        "addressOfSite": address,
        "realPropertyDescriptionOfSite": rpd,
        "aspectsOfDevelopmentAndTypeOfApproval": aspects,
        "councilFileReference": council_ref,
        "permitReferenceNumbers": permit_refs,
        "packageStatus": status,
        "packageGenerated": generated,
    }


def _parse_project_team(soup: BeautifulSoup) -> List[Dict[str, Any]]:
    marker = _find_marker(soup, r"\bPROJECT TEAM\b")
    if not marker:
        return []

    table = marker.find_next("table")
    if not table:
        return []

    people: List[Dict[str, Any]] = []
    for td in table.find_all("td"):
        raw_lines = td.get_text("\n", strip=True).split("\n")
        lines = [ln for ln in (_clean(x) for x in raw_lines) if ln]
        if not lines:
            continue

        person = {
            "name": lines[0],
            "role": lines[1] if len(lines) > 1 else "",
            "team": lines[2] if len(lines) > 2 else "",
            "email": "",
            "phone": "",
        }

        for ln in lines:
            if "@" in ln and "." in ln:
                person["email"] = ln
            if (
                re.search(r"\b(\+?61|0)\d", ln)
                or re.search(r"\b\d{2}\s?\d{4}\s?\d{4}\b", ln)
                or re.search(r"\(\d{2}\)\s*\d{4}\s*\d{4}\b", ln)
            ):
                person["phone"] = ln

        people.append(person)

    return people


def _parse_permit_info_from_approval_conditions_header(soup: BeautifulSoup) -> Dict[str, Any]:
    marker = _find_marker(soup, r"\bAPPROVAL CONDITIONS\b")
    if not marker:
        return {"permitToWhichTheseConditionsRelate": "", "activities": [], "stage": ""}

    header_table = marker.find_next("table")
    if not header_table:
        return {"permitToWhichTheseConditionsRelate": "", "activities": [], "stage": ""}

    permit = ""
    stage = ""
    activities: List[str] = []

    for tr in header_table.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) < 2:
            continue

        label = _clean(tds[0].get_text(" ", strip=True)).rstrip(":")
        value_lines = [
            ln.strip()
            for ln in (tds[1].get_text("\n", strip=True) or "").split("\n")
            if ln.strip()
        ]
        value_clean = _clean(" ".join(value_lines))

        ll = label.lower()
        if ll.startswith("permit to which"):
            permit = value_clean
        elif ll.startswith("stage"):
            stage = "" if value_clean in ("\xa0", "&nbsp;") else value_clean
        elif ll.startswith("activity"):
            # prefer real lines (often stacked)
            activities = value_lines if len(value_lines) > 1 else (
                [p.strip() for p in value_clean.split(",") if p.strip()] or ([value_clean] if value_clean else [])
            )

    return {
        "permitToWhichTheseConditionsRelate": permit,
        "activities": activities,
        "stage": stage,
    }


# ------------------------
# Documents parsing
# ------------------------

def _extract_revision_and_prepared_by(number_str: str) -> Tuple[str, str]:
    s = number_str or ""

    rev = ""
    m = re.search(
        r"\b(Rev\s+[A-Z0-9]+|Issue\s+[A-Z0-9]+|CO\s+Issue\s+[A-Z0-9]+)\b",
        s,
        flags=re.I,
    )
    if m:
        rev = _clean(m.group(1))

    prepared_by = ""
    if "|" in s:
        left = _clean(s.split("|", 1)[0])
        if left and len(left) <= 60:
            prepared_by = left

    return rev, prepared_by


def _parse_drawings_and_documents(soup: BeautifulSoup) -> List[Dict[str, str]]:
    marker = _find_marker(soup, r"\bDRAWINGS AND DOCUMENTS\b")
    if not marker:
        return []

    table = marker.find_next("table")
    if not table:
        return []

    docs: List[Dict[str, str]] = []
    rows = table.find_all("tr")
    for tr in rows[1:]:
        cells = tr.find_all(["td", "th"])
        if len(cells) < 3:
            continue

        title = _clean(cells[0].get_text(" ", strip=True))
        number = _clean(cells[1].get_text(" ", strip=True))
        plan_date = _clean(cells[2].get_text(" ", strip=True))

        if not (title or number or plan_date):
            continue

        rev, prepared_by = _extract_revision_and_prepared_by(number)

        docs.append(
            {
                "title": title,
                "number": number,
                "planDate": plan_date,
                "revision": rev,
                "preparedBy": prepared_by,
            }
        )

    return docs


# ------------------------
# Condition parsing
# ------------------------

def _extract_inline_timing(text: str) -> Tuple[str, str]:
    """
    Extracts inline 'Timing: ...' from the end of a block.
    Returns (clean_text_without_inline_timing, inline_timing or "")
    """
    if not text:
        return text, ""

    m = re.search(r"\bTiming:\s*(.+)$", text, flags=re.I | re.S)
    if not m:
        return text, ""

    inline_timing = _clean(m.group(1))
    clean_text = _clean(text[: m.start()])
    return clean_text, inline_timing


def _extract_proof_of_fulfilment(text: str) -> Tuple[str, Optional[Dict[str, Any]]]:
    """
    Extract 'PROOF OF FULFILMENT ...' block from description into material.
    Also extracts Timing: inside proof block into material.timing.
    """
    if not text:
        return text, None

    m = re.search(r"\bPROOF OF FULFILMENT\b\s*(.+)$", text, flags=re.I | re.S)
    if not m:
        return text, None

    proof_block = _clean(m.group(1))
    clean_desc = _clean(text[: m.start()])

    proof_desc, proof_timing = _extract_inline_timing(proof_block)

    material = {
        "required": True,
        "description": proof_desc,
        "timing": proof_timing,
    }
    return clean_desc, material


def _table_looks_like_timing_header(table) -> bool:
    if not table:
        return False
    t = _clean(table.get_text(" ", strip=True)).lower()
    return "timing" in t


def _extract_desc_excluding_header_bold(desc_cell) -> str:
    """
    In BCC HTML, the first <td> has:
      <b>8(a) Project Arborist</b>  + body text in other elements.
    We remove ONLY the first <b> inside this cell (the header), then read remaining text.
    """
    cell_copy = BeautifulSoup(str(desc_cell), "html.parser")
    first_b = cell_copy.find("b")
    if first_b:
        first_b.extract()
    return _clean(cell_copy.get_text(" ", strip=True))


def _parse_conditions(soup: BeautifulSoup) -> Tuple[List[Dict[str, Any]], int]:
    """
    Output requirement:
      - Parent conditions: "8"
      - Subconditions ONLY: "8(a)", "8(b)", ... (attached under parent)
      - NO extra levels like "8(a)(a)"
      - DO NOT split (i)(ii)(iii) into separate numbered conditions
    """
    root = _find_marker(soup, r"\bAPPROVAL CONDITIONS\b") or soup

    sections: List[Dict[str, Any]] = []
    current_section_title = "General"
    current_conditions: List[Dict[str, Any]] = []

    # base number -> parent dict
    condition_index: Dict[str, Dict[str, Any]] = {}
    total_conditions = 0  # includes subconditions (8(a), 8(b), ...)

    def flush():
        nonlocal current_conditions
        if current_conditions:
            sections.append({"title": current_section_title, "conditions": current_conditions})
            current_conditions = []

    for b in root.find_all_next("b"):
        text = _clean(b.get_text())
        if not text:
            continue

        # Match:
        #   8) Title
        #   8(a) Title   (often no extra trailing ')')
        cond_m = re.match(r"^(\d+)(\([a-z]\))?\s*\)?\s*(.+)$", text, flags=re.I)
        if cond_m:
            base_num = cond_m.group(1)
            suffix = (cond_m.group(2) or "").lower()
            number = f"{base_num}{suffix}"
            title = _clean(cond_m.group(3))

            row = b.find_parent("tr")
            if not row:
                continue

            cells = row.find_all("td")
            if len(cells) < 2:
                continue

            # IMPORTANT: description should be the body, not the header
            raw_desc = _extract_desc_excluding_header_bold(cells[0])
            timing_col = _clean(cells[1].get_text(" ", strip=True))

            # PROOF OF FULFILMENT -> material
            desc_wo_proof, material = _extract_proof_of_fulfilment(raw_desc)

            # Inline Timing: ... inside description (when timing column isn't explicit)
            clean_desc, inline_timing = _extract_inline_timing(desc_wo_proof)

            timing = timing_col
            timing_source = "column"
            if inline_timing and timing_col.lower() in ("as indicated", ""):
                timing = inline_timing
                timing_source = "inline"

            condition: Dict[str, Any] = {
                "number": number,
                "title": title,
                "description": clean_desc,
                "timing": timing,
                "timingSource": timing_source,
                "timingColumn": timing_col,
                "timingInline": inline_timing,
                "material": material,
                "children": [],
            }

            # Attach subconditions to their base parent
            if suffix:
                parent = condition_index.get(base_num)
                if parent:
                    condition["parentNumber"] = base_num
                    parent["children"].append(condition)
                else:
                    # If parent hasn't been seen yet, keep it as standalone (no data loss)
                    current_conditions.append(condition)
                total_conditions += 1
            else:
                current_conditions.append(condition)
                condition_index[base_num] = condition
                total_conditions += 1

            continue

        # Dynamic category headings
        nxt_table = b.find_next("table")
        if _table_looks_like_timing_header(nxt_table):
            flush()
            current_section_title = text
            continue

    flush()
    return sections, total_conditions


# ------------------------
# Public parser (router import target)
# ------------------------

def parse_bcc_conditions_html(file_bytes: bytes) -> Dict[str, Any]:
    soup = BeautifulSoup(file_bytes.decode("utf-8", errors="ignore"), "html.parser")

    application_details = _parse_application_details(soup)
    project_team = _parse_project_team(soup)
    permit_info = _parse_permit_info_from_approval_conditions_header(soup)
    documents = _parse_drawings_and_documents(soup)
    condition_sections, total_conditions = _parse_conditions(soup)

    return {
        "council": "BCC",
        "summary": {
            "numberOfConditions": total_conditions,
            "numberOfPlans": len(documents),
        },
        "permitInfo": permit_info,
        "applicationDetails": application_details,
        "projectTeam": project_team,
        "documents": documents,
        "conditions": {"sections": condition_sections},
    }


# Backwards-compatible alias (if anything still calls approval)
def parse_bcc_approval_html(file_bytes: bytes) -> Dict[str, Any]:
    return parse_bcc_conditions_html(file_bytes)


# ------------------------
# Optional direct Lambda handler (only if used standalone)
# ------------------------

def handler(event, context):
    try:
        method = (
            event.get("requestContext", {}).get("http", {}).get("method")
            or event.get("httpMethod")
            or "POST"
        )
        if method == "OPTIONS":
            return {
                "statusCode": 204,
                "headers": {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type,Authorization",
                    "Access-Control-Allow-Methods": "OPTIONS,POST",
                },
                "body": "",
            }

        body = event.get("body", "") or ""
        if event.get("isBase64Encoded"):
            import base64
            body_bytes = base64.b64decode(body)
        else:
            body_bytes = body.encode("utf-8") if isinstance(body, str) else body

        parsed = parse_bcc_conditions_html(body_bytes)

        return {
            "statusCode": 200,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type,Authorization",
                "Access-Control-Allow-Methods": "OPTIONS,POST",
            },
            "body": json.dumps(parsed),
        }

    except Exception as e:
        return {
            "statusCode": 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type,Authorization",
                "Access-Control-Allow-Methods": "OPTIONS,POST",
            },
            "body": json.dumps({"ok": False, "error": "BCC_PARSE_ERROR", "message": str(e)}),
        }
