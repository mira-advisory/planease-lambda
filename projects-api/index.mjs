import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall, marshall } from "@aws-sdk/util-dynamodb";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";

const REGION = process.env.REGION || process.env.AWS_REGION || "ap-southeast-2";

const ddb = new DynamoDBClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

const {
  PROJECTS_TABLE = "projects",
  CONDITIONS_TABLE = "conditions",
  DOCUMENTS_TABLE = "documents",
  COMMENTS_TABLE = "comments",
  FILES_BUCKET = "app-planease-files",
} = process.env;

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PATCH,DELETE",
  },
  body: JSON.stringify(body),
});

const getUser = (event) => {
  const claims = event?.requestContext?.authorizer?.jwt?.claims || {};
  return {
    userId: claims.sub || "unknown",
    email: claims.email || "",
    name: claims.name || claims.email || "Unknown User",
  };
};

const getHttpMethod = (event) =>
  event?.requestContext?.http?.method || event?.httpMethod || null;

const getHttpPath = (event) =>
  event?.rawPath ||
  event?.requestContext?.http?.path ||
  event?.path ||
  null;

/**
 * nextKey handling:
 * - client passes ?nextKey=<base64(JSON)>
 * - lambda returns nextKey the same way (string) or null
 */
function decodeNextKey(nextKeyStr) {
  if (!nextKeyStr) return null;
  try {
    const json = Buffer.from(nextKeyStr, "base64").toString("utf8");
    const obj = JSON.parse(json);
    // Dynamo expects AttributeValue map. We stored it exactly as returned by QueryCommand.
    return obj;
  } catch {
    return null;
  }
}

function encodeNextKey(lastEvaluatedKey) {
  if (!lastEvaluatedKey) return null;
  try {
    return Buffer.from(JSON.stringify(lastEvaluatedKey), "utf8").toString(
      "base64"
    );
  } catch {
    return null;
  }
}

function getProjectIdFromEvent(event) {
  // Prefer explicit pathParameters if present
  const pp = event?.pathParameters || {};
  const direct =
    pp.project_id || pp.projectId || pp["project_id"] || pp["projectId"];
  if (direct) return direct;

  // Fallback parse path: /projects/{id}/...
  const path = getHttpPath(event) || "";
  const parts = path.split("/").filter(Boolean);
  // ["projects", "{id}", ...]
  if (parts[0] === "projects" && parts[1]) return parts[1];

  return null;
}

async function getProject(projectId) {
  // ✅ FIX: projects table PK is project_id
  const res = await ddb.send(
    new GetItemCommand({
      TableName: PROJECTS_TABLE,
      Key: { project_id: { S: projectId } },
    })
  );

  return res.Item ? unmarshall(res.Item) : null;
}

/**
 * Generic query helper for "project -> list"
 * Returns { items, nextKey } where nextKey is a base64 string or null
 */
async function queryByProject({
  tableName,
  indexName,
  hashKeyName, // e.g. "project_id"
  projectId,
  limit,
  nextKeyStr,
  scanIndexForward = true,
}) {
  const ExclusiveStartKey = decodeNextKey(nextKeyStr);

  const res = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: indexName,
      KeyConditionExpression: "#hk = :pid",
      ExpressionAttributeNames: {
        "#hk": hashKeyName,
      },
      ExpressionAttributeValues: {
        ":pid": { S: projectId },
      },
      Limit: limit,
      ExclusiveStartKey: ExclusiveStartKey || undefined,
      ScanIndexForward: scanIndexForward,
    })
  );

  return {
    items: res.Items?.map(unmarshall) || [],
    nextKey: encodeNextKey(res.LastEvaluatedKey || null),
  };
}

async function createUploadUrl(projectId, filename, contentType) {
  const safeName = String(filename || "file").replace(/[^\w.\-() ]+/g, "_");
  const key = `projects/${projectId}/documents/${Date.now()}_${safeName}`;

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: FILES_BUCKET,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: 900 }
  );

  return { uploadUrl, key, bucket: FILES_BUCKET };
}

async function addComment({ projectId, conditionId, message }, user) {
  const createdAt = new Date().toISOString();
  const commentId = crypto.randomUUID();

  // Using snake_case attributes to match your other tables style
  const Item = {
    comment_id: { S: commentId },
    created_at: { S: createdAt },
    updated_at: { S: createdAt },

    project_id: { S: projectId },
    condition_id: { S: conditionId },

    author_user_id: { S: user.userId },
    author_name: { S: user.name },
    author_email: { S: user.email || "" },

    message: { S: String(message || "") },
    source: { S: "app" },
  };

  await ddb.send(
    new PutItemCommand({
      TableName: COMMENTS_TABLE,
      Item,
    })
  );

  return { comment_id: commentId, created_at: createdAt };
}

export const handler = async (event) => {
  try {
    const method = getHttpMethod(event);
    const path = getHttpPath(event);

    if (method === "OPTIONS") {
      return jsonResponse(200, { ok: true });
    }

    if (!method || !path) {
      return jsonResponse(400, {
        error: "BAD_EVENT",
        message: "Missing http context (method/path)",
      });
    }

    const user = getUser(event);
    const qs = event.queryStringParameters || {};

    let body = {};
    if (event.body) {
      try {
        const raw = event.isBase64Encoded
          ? Buffer.from(event.body, "base64").toString("utf8")
          : event.body;
        body = JSON.parse(raw);
      } catch {
        return jsonResponse(400, { error: "INVALID_JSON" });
      }
    }

    // ---------------------------
    // GET /projects/{project_id}
    // ---------------------------
    if (method === "GET" && /^\/projects\/[^/]+$/.test(path)) {
      const projectId = getProjectIdFromEvent(event);
      if (!projectId)
        return jsonResponse(400, {
          error: "MISSING_PROJECT_ID",
          message: "project_id is required",
        });

      const project = await getProject(projectId);
      if (!project) return jsonResponse(404, { error: "PROJECT_NOT_FOUND" });

      return jsonResponse(200, project);
    }

    // ------------------------------------
    // GET /projects/{project_id}/conditions
    // conditions index: project_id_index
    // HASH: project_id, RANGE: condition_number
    // ------------------------------------
    if (method === "GET" && path.endsWith("/conditions")) {
      const projectId = getProjectIdFromEvent(event);
      if (!projectId)
        return jsonResponse(400, { error: "MISSING_PROJECT_ID" });

      const limit = Math.max(1, Math.min(500, Number(qs.limit || 100)));
      const nextKey = qs.nextKey || null;

      const result = await queryByProject({
        tableName: CONDITIONS_TABLE,
        indexName: "project_id_index",
        hashKeyName: "project_id",
        projectId,
        limit,
        nextKeyStr: nextKey,
        scanIndexForward: true, // condition_number ascending
      });

      return jsonResponse(200, result);
    }

    // -----------------------------------
    // GET /projects/{project_id}/documents
    // documents index: gsi_project_created
    // HASH: project_id, RANGE: created_at
    // -----------------------------------
    if (method === "GET" && path.endsWith("/documents")) {
      const projectId = getProjectIdFromEvent(event);
      if (!projectId)
        return jsonResponse(400, { error: "MISSING_PROJECT_ID" });

      const limit = Math.max(1, Math.min(500, Number(qs.limit || 100)));
      const nextKey = qs.nextKey || null;

      const result = await queryByProject({
        tableName: DOCUMENTS_TABLE,
        indexName: "gsi_project_created",
        hashKeyName: "project_id",
        projectId,
        limit,
        nextKeyStr: nextKey,
        scanIndexForward: false, // newest first
      });

      return jsonResponse(200, result);
    }

    // -----------------------------------------
    // POST /projects/{project_id}/documents/upload-url
    // -----------------------------------------
    if (method === "POST" && path.endsWith("/documents/upload-url")) {
      const projectId = getProjectIdFromEvent(event);
      if (!projectId)
        return jsonResponse(400, { error: "MISSING_PROJECT_ID" });

      const { filename, contentType } = body;
      if (!filename || !contentType) {
        return jsonResponse(400, {
          error: "MISSING_FIELDS",
          message: "filename and contentType required",
        });
      }

      const result = await createUploadUrl(projectId, filename, contentType);
      return jsonResponse(200, result);
    }

    // -----------------------------------------
    // POST /projects/{project_id}/conditions/{condition_id}/comments
    // -----------------------------------------
    if (method === "POST" && /\/comments$/.test(path)) {
      const parts = path.split("/").filter(Boolean);
      // ["projects", pid, "conditions", cid, "comments"]
      const projectId = parts[1];
      const conditionId = parts[3];

      if (!projectId || !conditionId) {
        return jsonResponse(400, {
          error: "MISSING_PATH_PARAMS",
          message: "project_id and condition_id required in path",
        });
      }

      if (!body.message || !String(body.message).trim()) {
        return jsonResponse(400, { error: "MESSAGE_REQUIRED" });
      }

      const result = await addComment(
        { projectId, conditionId, message: body.message },
        user
      );

      return jsonResponse(201, result);
    }

    return jsonResponse(404, { error: "ROUTE_NOT_FOUND", method, path });
  } catch (err) {
    console.error("projects-api error", err);
    return jsonResponse(500, {
      error: "INTERNAL_ERROR",
      message: err?.message || "Unknown error",
    });
  }
};
