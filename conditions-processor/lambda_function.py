import json
import os
import logging
import boto3
import base64

from parsers.logan_parse import parse_logan_conditions_pdf
from parsers.bcc_parse import parse_bcc_conditions_html
from parsers.redlands_parse import parse_redlands_conditions_pdf

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client("s3")
dynamodb = boto3.client("dynamodb")

FILES_BUCKET = os.environ.get("FILES_BUCKET", "app-planease-files")
INTAKE_TABLE = os.environ.get("INTAKE_TABLE", "project_intake_sessions")

PARSER_ROUTER = {
    "LOGAN": parse_logan_conditions_pdf,
    "BCC": parse_bcc_conditions_html,
    "REDLANDS": parse_redlands_conditions_pdf,
}

def lambda_handler(event, context):
    logger.info("Incoming event: %s", json.dumps(event))

    http = (event.get("requestContext") or {}).get("http") or {}
    method = http.get("method")
    if method == "OPTIONS":
        return _response(200, {"ok": True, "message": "CORS preflight"})

    raw_body = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw_body = base64.b64decode(raw_body).decode("utf-8", errors="ignore")

    try:
        body = json.loads(raw_body)
    except Exception:
        return _response(400, {"ok": False, "error": "INVALID_JSON"})

    session_id = body.get("sessionId")
    file_key = body.get("fileKey")
    council_code = (body.get("councilCode") or "").upper()

    if not session_id or not file_key or not council_code:
        return _response(
            400,
            {
                "ok": False,
                "error": "MISSING_FIELDS",
                "message": "sessionId, fileKey, councilCode are required",
            },
        )

    parser_fn = PARSER_ROUTER.get(council_code)
    if not parser_fn:
        return _response(
            400,
            {
                "ok": False,
                "error": "UNSUPPORTED_COUNCIL",
                "message": f"No parser implemented for {council_code}",
            },
        )

    try:
        logger.info("Fetching file from S3 bucket=%s key=%s", FILES_BUCKET, file_key)
        obj = s3.get_object(Bucket=FILES_BUCKET, Key=file_key)
        file_bytes = obj["Body"].read()
    except Exception as e:
        logger.exception("S3 error reading file")
        return _response(500, {"ok": False, "error": "S3_READ_ERROR", "message": str(e)})

    try:
        logger.info("Running parser for council=%s", council_code)
        parsed = parser_fn(file_bytes)
    except Exception as e:
        logger.exception("Parser error")
        return _response(500, {"ok": False, "error": "PARSER_ERROR", "message": str(e)})

    try:
        logger.info("Updating DynamoDB session_id=%s table=%s", session_id, INTAKE_TABLE)
        dynamodb.update_item(
            TableName=INTAKE_TABLE,
            Key={"session_id": {"S": session_id}},
            UpdateExpression="SET step_data.councilConditions = :v",
            ExpressionAttributeValues={
                ":v": {
                    "S": json.dumps(
                        {"councilCode": council_code, "fileKey": file_key, "parsed": parsed}
                    )
                }
            },
        )
    except Exception as e:
        logger.exception("DynamoDB update error")
        return _response(500, {"ok": False, "error": "DDB_WRITE_ERROR", "message": str(e)})

    return _response(
        200,
        {
            "ok": True,
            "sessionId": session_id,
            "councilCode": council_code,
            "fileKey": file_key,
            "conditions": parsed,
        },
    )

def _response(status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "OPTIONS,POST",
        },
        "body": json.dumps(body),
    }
