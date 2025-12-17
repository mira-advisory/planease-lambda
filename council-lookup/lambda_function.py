import json
import os
from datetime import datetime

import boto3

# Import council-specific scrapers
from details.bcc_scr import scrape_bcc_documents_json
from details.logan_scr import scrape_logan_da_json
from details.redlands_scr import scrape_redlands_da_json

dynamodb = boto3.client("dynamodb")

# IMPORTANT: make sure this env var is set to "project_intake_sessions"
INTAKE_TABLE = os.environ.get("INTAKE_TABLE", "project_intake_sessions")

# Route table: councilCode -> function
COUNCIL_ROUTER = {
    "BCC": scrape_bcc_documents_json,
    "LOGAN": scrape_logan_da_json,
    "REDLANDS": scrape_redlands_da_json,
}


def lambda_handler(event, context):
    print("Incoming event:", json.dumps(event, indent=2))

    # HTTP API v2 style (proxy integration sets event["body"])
    if "body" in event:
        try:
            body = json.loads(event["body"] or "{}")
        except Exception:
            return http_response(
                400,
                {"ok": False, "error": "INVALID_JSON"},
            )
    else:
        # direct test invoke (no "body" wrapper)
        body = event or {}

    council_code = (body.get("councilCode") or "").upper().strip()
    da_number = (body.get("daNumber") or "").strip()
    session_id = (body.get("sessionId") or "").strip()

    if not council_code or not da_number:
        return http_response(
            400,
            {
                "ok": False,
                "error": "MISSING_FIELDS",
                "message": "councilCode and daNumber are required",
            },
        )

    scraper = COUNCIL_ROUTER.get(council_code)
    if scraper is None:
        return http_response(
            400,
            {
                "ok": False,
                "error": "UNSUPPORTED_COUNCIL",
                "message": f"Council '{council_code}' not supported yet",
            },
        )

    # Call council-specific scraper
    try:
        result = scraper(da_number)
    except Exception as e:
        print("Scraper exception:", repr(e))
        return http_response(
            500,
            {
                "ok": False,
                "error": "SCRAPER_EXCEPTION",
                "message": str(e),
            },
        )

    # Normalise result
    if not isinstance(result, dict) or not result.get("success"):
        return http_response(
            502,
            {
                "ok": False,
                "error": "SCRAPE_FAILED",
                "details": result,
            },
        )

    data = result.get("data") or {}
    metadata = data.get("metadata") or {}

    project_metadata = {
        "applicationId": data.get("applicationId") or da_number,
        "scrapedAt": metadata.get("scrapedAt") or datetime.utcnow().isoformat() + "Z",
        "totalDocuments": metadata.get("totalDocuments"),
        "categories": metadata.get("categories"),
        # pass through the full raw data for later use
        "raw": data,
    }

    # Optionally persist into the intake session
    if session_id and INTAKE_TABLE:
        try:
            dynamodb.update_item(
                TableName=INTAKE_TABLE,
                Key={"session_id": {"S": session_id}},
                UpdateExpression="SET council_lookup = :v",
                ExpressionAttributeValues={
                    ":v": {
                        "S": json.dumps(
                            {
                                "councilCode": council_code,
                                "daNumber": da_number,
                                "projectMetadata": project_metadata,
                                "lookupAt": datetime.utcnow().isoformat() + "Z",
                            }
                        )
                    }
                },
            )
        except Exception as e:
            print("DynamoDB update error:", repr(e))

    return http_response(
        200,
        {
            "ok": True,
            "councilCode": council_code,
            "daNumber": da_number,
            "sessionId": session_id or None,
            "projectMetadata": project_metadata,
        },
    )


def http_response(status_code, body_dict):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "OPTIONS,POST",
        },
        "body": json.dumps(body_dict),
    }
