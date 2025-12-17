#!/usr/bin/env python3
"""
Redland City Council Development-i document scraper (Lambda/JSON-friendly)

Primary entry point for Lambda router:
    scrape_redlands_da_json(application_id: str) -> dict
"""

import csv
import json
import os
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import Any, Dict, List, Optional

import requests
from urllib.parse import quote

BASE_URL = "https://developmenti.redland.qld.gov.au"


@dataclass
class RedlandsDocument:
    applicationId: str
    documentId: str
    fileName: str
    category: str
    fileDate: str
    fileSize: str
    fileextension: str
    downloadUrl: str


def create_redlands_session() -> requests.Session:
    """Create a session with desktop browser headers."""
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


def scrape_redlands_documents(application_id: str) -> List[RedlandsDocument]:
    """Return a list of RedlandsDocument for the given applicationId."""
    if not application_id:
        raise ValueError("Application ID is required")

    session = create_redlands_session()

    # 1) Hit the main page to establish session / cookies (mirrors Dev-i behaviour)
    main_page_url = f"{BASE_URL}/DocumentSearch/GetAllDocument"
    params = {"applicationId": application_id}

    main_resp = session.get(main_page_url, params=params, timeout=60)
    if not main_resp.ok:
        raise RuntimeError(
            f"Failed to fetch main page: "
            f"{main_resp.status_code} {main_resp.reason}"
        )

    # 2) POST to GetResult endpoint to get JSON document list
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
        raise RuntimeError(
            f"Redlands API request failed: "
            f"{api_resp.status_code} {api_resp.reason}"
        )

    try:
        api_data = api_resp.json()
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Invalid JSON returned by Redlands API: {e}") from e

    rows = api_data.get("data")
    if not isinstance(rows, list):
        raise RuntimeError("Invalid API response format: missing 'data' array")

    documents: List[RedlandsDocument] = []

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
            RedlandsDocument(
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

    return documents

# -------- Lambda-friendly JSON wrapper --------

def scrape_redlands_da_json(application_id: str) -> Dict[str, Any]:
    """
    Lambda-friendly wrapper mirroring BCC structure:
    { success, data: { applicationId, documents, metadata }, error }
    """
    if not application_id:
        return {
            "success": False,
            "data": None,
            "error": "Application ID is required",
        }

    try:
        docs = scrape_redlands_documents(application_id)
        documents = [asdict(d) for d in docs]

        categories = sorted(
            {d.category for d in docs if d.category}
        )

        data = {
            "applicationId": application_id,
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


# --------- CLI for local testing (optional) ---------

def write_documents_csv(
    documents: List[RedlandsDocument],
    output_path: str,
) -> None:
    """Write documents into a CSV at output_path."""
    fieldnames = [
        "applicationId",
        "documentId",
        "fileName",
        "category",
        "fileDate",
        "fileSize",
        "fileextension",
        "downloadUrl",
    ]

    with open(output_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for doc in documents:
            writer.writerow(asdict(doc))


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(
        description="Redland City Council Development-i document scraper -> CSV"
    )
    parser.add_argument(
        "application_id",
        help='Redlands application ID, e.g. "CAR25/0782"',
    )
    parser.add_argument(
        "--out",
        help=(
            "Output CSV file path. "
            "Default: redlands_<applicationId-with-slashes-replaced>.csv"
        ),
        default=None,
    )

    args = parser.parse_args()
    application_id = args.application_id

    result = scrape_redlands_da_json(application_id)
    print(json.dumps(result, indent=2, ensure_ascii=False))

    # optional: still write CSV if you want
    docs = [RedlandsDocument(**d) for d in result.get("data", {}).get("documents", [])]
    safe_id = application_id.replace("/", "-")
    output_path = args.out or os.path.join(
        os.getcwd(),
        f"redlands_{safe_id}.csv",
    )
    write_documents_csv(docs, output_path)
    print(f"\nCSV written to: {output_path}")


if __name__ == "__main__":
    main()
