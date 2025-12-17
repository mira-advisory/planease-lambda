// index.mjs (Node.js 24.x, ESM)

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const REGION =
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION ||
  "ap-southeast-2";

const BUCKET = process.env.PROJECT_FILES_BUCKET; // should be "app-planease-files"

const s3 = new S3Client({ region: REGION });

function slugifyFileName(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function defaultHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
  };
}

function httpResponse(statusCode, bodyObj) {
  return {
    statusCode,
    headers: defaultHeaders(),
    body: JSON.stringify(bodyObj ?? {}),
  };
}

export const handler = async (event) => {
  console.log("Incoming event:", JSON.stringify(event));

  const method = event.requestContext?.http?.method || "POST";

  // --- CORS preflight ---
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: defaultHeaders(),
      body: "",
    };
  }

  try {
    if (!BUCKET) {
      console.error("PROJECT_FILES_BUCKET is not set");
      return httpResponse(500, {
        ok: false,
        error: "SERVER_CONFIG_ERROR",
        message: "PROJECT_FILES_BUCKET is not set",
      });
    }

    // Path like: /intake/session/{session_id}/upload-url
    const rawPath =
      event.requestContext?.http?.path || event.rawPath || event.path || "";
    let sessionIdFromPath = null;
    const m = rawPath.match(
      /^\/intake\/session\/([^/]+)\/upload-url$/i
    );
    if (m) {
      sessionIdFromPath = m[1];
    }

    // Parse body
    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch (err) {
        console.error("Invalid JSON body:", err);
        return httpResponse(400, {
          ok: false,
          error: "INVALID_JSON",
          message: "Request body is not valid JSON",
        });
      }
    }

    const {
      projectId,
      sessionId: sessionIdFromBody,
      fileName,
      contentType,
      docType = "conditions",
      source = "user",
    } = body;

    const sessionId = sessionIdFromBody || sessionIdFromPath;

    if (!fileName || !contentType) {
      return httpResponse(400, {
        ok: false,
        error: "MISSING_FIELDS",
        message: "fileName and contentType are required",
      });
    }

    if (!sessionId && !projectId) {
      return httpResponse(400, {
        ok: false,
        error: "MISSING_ID",
        message: "Either sessionId (intake) or projectId (project) is required",
      });
    }

    // --- Decide prefix: intake vs projects ---
    let keyPrefix;
    if (sessionId) {
      // Intake flow – no project yet
      keyPrefix = `intake/${sessionId}/${docType}/`;
    } else {
      // Existing project documents
      keyPrefix = `projects/${projectId}/${docType}/`;
    }

    const safeName = slugifyFileName(fileName);
    const key = `${keyPrefix}${Date.now()}_${safeName}`;

    const putCommand = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3, putCommand, {
      expiresIn: 300, // 5 minutes
    });

    return httpResponse(200, {
      ok: true,
      uploadUrl,
      fileKey: key,
      bucket: BUCKET,
      docType,
      source,
      sessionId: sessionId ?? null,
      projectId: projectId ?? null,
    });
  } catch (err) {
    console.error("Upload URL generation failed:", err);
    return httpResponse(500, {
      ok: false,
      error: "UPLOAD_URL_ERROR",
      message: err?.message || "Unknown error",
    });
  }
};
