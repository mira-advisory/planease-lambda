#!/usr/bin/env python3
"""
Logan City Council – DA scraper (Lambda/JSON-friendly)

Primary entry point for Lambda router:
    scrape_logan_da_json(application_id: str) -> dict

Return shape:
{
  "success": true,
  "data": {
    "applicationId": "MCUERA/100/2006",
    "details": {...},        # ArcGIS attributes (address, description, etc.)
    "documents": [ ... ],    # Normalised documents list
    "metadata": {
      "totalDocuments": 0,
      "scrapedAt": "2025-12-08T01:23:45.000Z",
      "categories": ["Development Conditions", "Decision Notices", ...]
    }
  },
  "error": null
}
"""

import json
import math
import re
from datetime import datetime
from typing import Any, Dict, List, Optional

import requests
from urllib.parse import unquote

# ------------- HTTP helper -------------

def fetch_with_user_agent(
    url: str,
    additional_headers: Optional[Dict[str, str]] = None,
) -> requests.Response:
    default_headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/91.0.4472.124 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,"
                  "image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    }
    headers = {**default_headers, **(additional_headers or {})}
    return requests.get(url, headers=headers, timeout=60)

# ------------- Utility helpers -------------

def format_bytes(num_bytes: int) -> str:
    if not num_bytes:
        return "0 Bytes"
    k = 1024.0
    sizes = ["Bytes", "KB", "MB", "GB", "TB"]
    i = int(math.floor(math.log(num_bytes) / math.log(k)))
    return f"{num_bytes / (k ** i):.2f} {sizes[i]}"

def esri_date_to_au_string(value: Any) -> Optional[str]:
    """Convert ArcGIS date (epoch ms or ISO-ish) to dd/mm/yyyy."""
    if value is None:
        return None

    if isinstance(value, (int, float)):
        try:
            dt = datetime.utcfromtimestamp(value / 1000.0)
            return dt.strftime("%d/%m/%Y")
        except Exception:
            return None

    if isinstance(value, str):
        text = value.strip()
        if re.match(r"^\d{1,2}/\d{1,2}/\d{2,4}$", text):
            return text
        cleaned = text.replace("Z", "").replace("T", " ")
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                dt = datetime.strptime(cleaned.split(".")[0], fmt)
                return dt.strftime("%d/%m/%Y")
            except ValueError:
                continue
    return None

def extract_property_key_from_lot_plan(lot_plan_str: str) -> Optional[str]:
    """
    Convert Logan-style lot/plan into property key.

    Examples:
      "Lot 19 SP 169446"  -> "19SP169446"
      "SP169446/19"       -> "19SP169446"
      "19/SP169446"       -> "19SP169446"
      "SP169446 / 19"     -> "19SP169446"
    """
    if not lot_plan_str:
        return None

    text = lot_plan_str.strip().upper()

    # "LOT 19 SP 169446"
    m = re.search(r"LOT\s+(\d+)\s+([A-Z]+\s*\d+)", text)
    if m:
        lot = m.group(1)
        plan = m.group(2).replace(" ", "")
        return f"{lot}{plan}"

    # "SP169446/19" (plan first)
    m = re.match(r"([A-Z]+\d+)\s*\/\s*(\d+)", text)
    if m:
        plan = m.group(1)
        lot = m.group(2)
        return f"{lot}{plan}"

    # "19/SP169446" (lot first)
    m = re.match(r"(\d+)\s*\/\s*([A-Z]+\d+)", text)
    if m:
        lot = m.group(1)
        plan = m.group(2)
        return f"{lot}{plan}"

    return None

# ------------- S3 XML parsing -------------

def parse_s3_xml_listing(
    xml_data: str,
    app_prefix: str,
    bucket: str,
) -> List[Dict[str, Any]]:
    """
    Parse S3 XML listing and return PDFs whose Key contains 'root/<app_prefix>'.
    """
    docs: List[Dict[str, Any]] = []
    contents_pattern = re.compile(r"<Contents>([\s\S]*?)</Contents>", re.IGNORECASE)

    for match in contents_pattern.finditer(xml_data):
        block = match.group(1)

        key_match = re.search(r"<Key>([^<]+)</Key>", block)
        if not key_match:
            continue
        key = key_match.group(1)

        if not key.lower().endswith(".pdf"):
            continue
        if f"root/{app_prefix}" not in key:
            continue

        size_match = re.search(r"<Size>([^<]+)</Size>", block)
        lm_match = re.search(r"<LastModified>([^<]+)</LastModified>", block)

        size_bytes = int(size_match.group(1)) if size_match else 0
        last_modified = lm_match.group(1) if lm_match else None

        url = f"https://s3-ap-southeast-2.amazonaws.com/{bucket}/{key}"
        filename = key.split("/")[-1]
        base = re.sub(r"\.pdf$", "", filename, flags=re.IGNORECASE)

        try:
            display_name = unquote(base)
        except Exception:
            display_name = base

        name_lower = display_name.lower()
        doc_type = "PDF Document"
        if "infrastructure" in name_lower or "charge" in name_lower:
            doc_type = "Infrastructure Charges"
        elif "plan" in name_lower and (
            "development" in name_lower or "architectural" in name_lower
        ):
            doc_type = "Development Plans"
        elif "landscape" in name_lower:
            doc_type = "Landscape Plans"
        elif "acoustic" in name_lower or "report" in name_lower:
            doc_type = "Technical Reports"
        elif "condition" in name_lower:
            doc_type = "Development Conditions"
        elif "decision" in name_lower or "notice" in name_lower:
            doc_type = "Decision Notices"
        elif "application" in name_lower or "supporting" in name_lower:
            doc_type = "Application Documents"
        elif "consent" in name_lower:
            doc_type = "Consent Forms"
        elif "approval" in name_lower:
            doc_type = "Approval Documents"

        docs.append(
            {
                "name": display_name,
                "url": url,
                "type": doc_type,
                "size": format_bytes(size_bytes),
                "lastModified": last_modified,
            }
        )

    return docs

# ------------- ArcGIS parsing -------------

def parse_arcgis_application_data(
    json_data: Dict[str, Any],
) -> Dict[str, Any]:
    details: Dict[str, Any] = {}
    features = json_data.get("features") or []
    if not features:
        return details

    attrs = (features[0].get("attributes") or {})

    if attrs.get("Application_Applicant"):
        details["applicantName"] = str(attrs["Application_Applicant"]).strip()

    if attrs.get("Application_Property_Lot_Plan"):
        details["lotPlan"] = str(attrs["Application_Property_Lot_Plan"]).strip()

    if attrs.get("Application_Property_Key"):
        details["propertyKey"] = str(attrs["Application_Property_Key"]).strip()

    if attrs.get("Application_Property_Address"):
        addr = str(attrs["Application_Property_Address"]).strip()
        suburb = attrs.get("Application_Property_Suburb")
        if suburb:
            addr += f", {str(suburb).strip()}"
        details["address"] = addr

    if attrs.get("Application_Description"):
        details["description"] = str(attrs["Application_Description"]).strip()

    if attrs.get("Application_Status"):
        details["status"] = str(attrs["Application_Status"]).strip()

    if attrs.get("Application_Lodgement_Date") is not None:
        details["lodged"] = esri_date_to_au_string(
            attrs["Application_Lodgement_Date"]
        )

    if attrs.get("Application_LatestDecision_Date") is not None:
        details["decided"] = esri_date_to_au_string(
            attrs["Application_LatestDecision_Date"]
        )

    if attrs.get("Application_Property_Zone"):
        details["zone"] = str(attrs["Application_Property_Zone"]).strip()

    if attrs.get("Application_Property_Area_m2"):
        try:
            area = float(attrs["Application_Property_Area_m2"])
            details["landArea"] = f"{area:,.0f} m²"
        except Exception:
            pass

    if attrs.get("Application_Development_Type_De"):
        details["developmentType"] = str(
            attrs["Application_Development_Type_De"]
        ).strip()

    if attrs.get("Application_Assessment_Category"):
        details["assessmentCategory"] = str(
            attrs["Application_Assessment_Category"]
        ).strip()

    if attrs.get("Application_Decision_Type"):
        details["decisionType"] = str(
            attrs["Application_Decision_Type"]
        ).strip()

    if attrs.get("Application_Property_Division"):
        details["division"] = str(attrs["Application_Property_Division"]).strip()

    return details

def lookup_application_details(app_number: str) -> Dict[str, Any]:
    app_num_no_suffix = re.sub(r"[-/][A-Z]$", "", app_number, flags=re.IGNORECASE)
    app_num_slash_no_suffix = app_num_no_suffix.replace("-", "/")

    arcgis_databases = [
        {
            "name": "Logan City Decided Development Applications",
            "url": "https://services5.arcgis.com/ZUCWDRj8F77Xo351/"
                   "arcgis/rest/services/Logan_City_Decided_Development_Applications/"
                   "FeatureServer/0/query",
        },
        {
            "name": "Logan City Undecided Development Applications",
            "url": "https://services5.arcgis.com/ZUCWDRj8F77Xo351/"
                   "arcgis/rest/services/Logan_City_Undecided_Development_Applications/"
                   "FeatureServer/0/query",
        },
    ]

    query_patterns = [
        f"Application_Number='{app_num_slash_no_suffix}'",
        f"Application_Number='{app_num_no_suffix}'",
        f"Application_Number='{app_number.replace('-', '/')}'",
        f"Application_Number='{app_number}'",
        f"Application_Number LIKE '%{app_num_slash_no_suffix}%'",
        f"Application_Number LIKE '%{app_num_no_suffix}%'",
    ]

    for db in arcgis_databases:
        for where_clause in query_patterns:
            url = (f"{db['url']}?f=json&where="
                   f"{requests.utils.quote(where_clause)}&outFields=*")
            try:
                resp = fetch_with_user_agent(url, {"Accept": "application/json"})
                if not resp.ok:
                    continue
                data = resp.json()
                if data.get("features"):
                    details = parse_arcgis_application_data(data)
                    details["_rawArcGIS"] = data
                    return details
            except Exception:
                continue

    return {}

# ------------- Lambda-friendly JSON wrapper -------------

def scrape_logan_da_json(application_id: str) -> Dict[str, Any]:
    """
    Lambda-friendly wrapper. No input(), no printing.
    Returns {success, data, error} in the same shape as BCC.
    """
    if not application_id:
        return {
            "success": False,
            "data": None,
            "error": "Application ID is required",
        }

    try:
        # 1) Application details (ArcGIS)
        details = lookup_application_details(application_id)

        # 2) Build S3 roots
        clean_app = application_id.replace("/", "-").strip()

        docs_api_root = (
            "https://s3-ap-southeast-2.amazonaws.com/"
            f"lcc-docs-01?delimiter=/&prefix=root/{clean_app}/"
        )

        # Optional as-constructed roots (by property key)
        prop_key = None
        lot_plan = details.get("lotPlan")
        if lot_plan:
            prop_key = extract_property_key_from_lot_plan(lot_plan)

        ascon_categories = [
            "AsConstructedDrainage",
            "AsConstructedWaterSewer",
            "AsConstructedRoads",
        ]

        # 3) Fetch regular docs
        documents: List[Dict[str, Any]] = []

        try:
            resp = fetch_with_user_agent(docs_api_root)
            if resp.ok:
                regular_docs = parse_s3_xml_listing(
                    resp.text,
                    clean_app,
                    "lcc-docs-01",
                )
                for d in regular_docs:
                    documents.append(
                        {
                            "applicationId": application_id,
                            "documentId": d["url"],  # use URL as synthetic ID
                            "fileName": d["name"],
                            "category": d["type"],
                            "fileDate": d.get("lastModified") or "",
                            "fileSize": d.get("size") or "",
                            "fileextension": "pdf",
                            "downloadUrl": d["url"],
                        }
                    )
        except Exception:
            # fail soft on docs
            pass

        # 4) As-constructed docs (if property key known)
        if prop_key:
            for cat in ascon_categories:
                api_url = (
                    "https://s3-ap-southeast-2.amazonaws.com/"
                    f"lcc.docs.01?delimiter=/&prefix=root/{prop_key}/{cat}/"
                )
                try:
                    resp = fetch_with_user_agent(api_url)
                    if not resp.ok:
                        continue
                    cat_docs = parse_s3_xml_listing(
                        resp.text,
                        f"{prop_key}/{cat}",
                        "lcc.docs.01",
                    )
                    for d in cat_docs:
                        documents.append(
                            {
                                "applicationId": application_id,
                                "documentId": d["url"],
                                "fileName": d["name"],
                                "category": f"As-Constructed {cat.replace('AsConstructed', '')}".strip(),
                                "fileDate": d.get("lastModified") or "",
                                "fileSize": d.get("size") or "",
                                "fileextension": "pdf",
                                "downloadUrl": d["url"],
                            }
                        )
                except Exception:
                    continue

        categories = sorted(
            {doc["category"] for doc in documents if doc.get("category")}
        )

        data = {
            "applicationId": application_id,
            "details": details,
            "documents": documents,
            "metadata": {
                "totalDocuments": len(documents),
                "scrapedAt": datetime.utcnow().isoformat() + "Z",
                "categories": categories,
            },
        }

        return {
            "success": True,
            "data": data,
            "error": None,
        }

    except Exception as e:
        return {
            "success": False,
            "data": None,
            "error": str(e),
        }


if __name__ == "__main__":
    # optional CLI for local testing
    app_number = input(
        "Enter Logan DA / Application number (e.g. MCUERA/100/2006): "
    ).strip()
    result = scrape_logan_da_json(app_number)
    print(json.dumps(result, indent=2, ensure_ascii=False))
