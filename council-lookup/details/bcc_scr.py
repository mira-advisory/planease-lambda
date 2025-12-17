#!/usr/bin/env python3
"""
BCC_SCR - Brisbane City Council Document Scraper (Python, JSON-friendly)

Core function:
    scrape_bcc_documents_json(application_id: str) -> dict

Returns:
{
  "success": true,
  "data": {
    "applicationId": "A006738808",
    "documents": [ ... ],
    "metadata": {
      "totalDocuments": 0,
      "scrapedAt": "2025-11-22T05:23:01.123Z",
      "categories": ["Decision Notice", "Plans", ...]
    }
  },
  "error": null
}

If something fails:
{
  "success": false,
  "data": null,
  "error": "Some error message"
}
"""

import json
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import Any, Dict, List, Optional

import requests
from urllib.parse import quote


BASE_URL = "https://developmenti.brisbane.qld.gov.au"


@dataclass
class BCCDocument:
    applicationId: str
    documentId: str
    fileName: str
    category: str
    fileDate: str
    fileSize: str
    fileextension: str
    downloadUrl: str


def _create_bcc_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/91.0.4472.124 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,"
                  "image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    })
    return s


def scrape_bcc_documents_json(application_id: str) -> Dict[str, Any]:
    """
    Main function your webapp (or Lambda) should call.

    :param application_id: e.g. "A006738808"
    :return: dict shaped like the Deno BCC_SCR response.
    """
    if not application_id:
        return {
            "success": False,
            "data": None,
            "error": "Application ID is required",
        }

    try:
        session = _create_bcc_session()

        # 1) GET main page to establish session / cookies
        main_page_url = f"{BASE_URL}/DocumentSearch/GetAllDocument"
        params = {"applicationId": application_id}

        main_resp = session.get(main_page_url, params=params, timeout=60)
        if not main_resp.ok:
            return {
                "success": False,
                "data": None,
                "error": (
                    f"Failed to fetch main page: "
                    f"{main_resp.status_code} {main_resp.reason}"
                ),
            }

        # 2) POST to GetResult endpoint (DataTables JSON)
        api_url = f"{BASE_URL}/DocumentSearch/GetResult"
        form_body = {
            "searchText": "",
            "datefile": "",
            "applicationId": application_id,
            "isSubCategory": "false",
        }

        headers = {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "Origin": BASE_URL,
            "Referer": f"{BASE_URL}/DocumentSearch/GetAllDocument?applicationId={application_id}",
        }

        api_resp = session.post(api_url, data=form_body, headers=headers, timeout=60)
        if not api_resp.ok:
            return {
                "success": False,
                "data": None,
                "error": (
                    f"BCC API request failed: "
                    f"{api_resp.status_code} {api_resp.reason}"
                ),
            }

        try:
            api_data = api_resp.json()
        except json.JSONDecodeError:
            return {
                "success": False,
                "data": None,
                "error": "Invalid JSON returned by BCC API",
            }

        rows = api_data.get("data")
        if not isinstance(rows, list):
            return {
                "success": False,
                "data": None,
                "error": "Invalid API response format: missing 'data' array",
            }

        documents: List[BCCDocument] = []
        for row in rows:
            doc_application_id = str(row.get("applicationId", application_id))
            document_id = str(row.get("documentId", "")).strip()
            file_name = str(row.get("fileName", "")).strip()
            category = (row.get("category") or "Document").strip()
            file_date = str(row.get("fileDate", "")).strip()
            file_size = str(row.get("fileSize", "")).strip()
            file_ext = str(row.get("fileextension", "")).strip()

            download_url = (
                f"{BASE_URL}/DocumentSearch/downloadFile"
                f"?fileId={quote(document_id)}"
                f"&fileName={quote(file_name)}"
                f"&flag=true"
                f"&fileType={quote(file_ext)}"
            )

            documents.append(
                BCCDocument(
                    applicationId=doc_application_id,
                    documentId=document_id,
                    fileName=file_name,
                    category=category or "Document",
                    fileDate=file_date,
                    fileSize=file_size,
                    fileextension=file_ext,
                    downloadUrl=download_url,
                )
            )

        categories = sorted({d.category for d in documents if d.category})

        data = {
            "applicationId": application_id,
            "documents": [asdict(d) for d in documents],
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


# Lambda-friendly wrapper
def scrape_bcc_da_json(application_id: str) -> dict:
    """
    Thin wrapper to keep a consistent name if you want,
    but router currently calls scrape_bcc_documents_json directly.
    """
    return scrape_bcc_documents_json(application_id)


# -------- Optional CLI: prints CLEAN JSON only --------
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Brisbane City Council Development-i document scraper (JSON output)"
    )
    parser.add_argument(
        "application_id",
        help='BCC application ID, e.g. "A006738808"',
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON instead of compact",
    )

    args = parser.parse_args()
    result = scrape_bcc_documents_json(args.application_id)

    if args.pretty:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(json.dumps(result, separators=(",", ":"), ensure_ascii=False))
