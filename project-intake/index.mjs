import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
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
  PROJECT_MEMBERS_TABLE = "project_members",
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
  event?.rawPath || event?.requestContext?.http?.path || event?.path || null;

/**
 * nextKey handling:
 * We return nextKey as base64 JSON of LastEvaluatedKey.
 * Caller passes nextKey back as query param, we decode to ExclusiveStartKey.
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

function getUserIdFromEvent(event) {
  // Prefer explicit pathParameters if present
  const pp = event?.pathParameters || {};
  const direct = pp.user_id || pp.userId || pp["user_id"] || pp["userId"];
  if (direct) return direct;

  // Fallback parse path: /projects/{project_id}/members/{user_id}
  const path = getHttpPath(event) || "";
  const parts = path.split("/").filter(Boolean);
  // ["projects", "{pid}", "members", "{uid}"]
  if (parts[0] === "projects" && parts[2] === "members" && parts[3])
    return parts[3];

  return null;
}

function membershipId(projectId, userId) {
  return `${projectId}#${userId}`;
}

/**
 * IMPORTANT:
 * project_members PK is membership_id, but older rows may have a different membership_id format.
 * We use the GSI project_id_user_id_index to find the actual row for a given (project_id, user_id).
 */
async function findMembershipByProjectAndUser(projectId, userId) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: PROJECT_MEMBERS_TABLE,
      IndexName: "project_id_user_id_index",
      KeyConditionExpression: "project_id = :pid AND user_id = :uid",
      ExpressionAttributeValues: {
        ":pid": { S: projectId },
        ":uid": { S: userId },
      },
      Limit: 1,
    })
  );

  const item = (res.Items || [])[0];
  return item ? unmarshall(item) : null;
}

async function queryByProject({
  tableName,
  indexName,
  hashKeyName,
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

  const items = (res.Items || []).map((it) => unmarshall(it));
  const nextKey = encodeNextKey(res.LastEvaluatedKey);

  return { items, nextKey };
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
        body = JSON.parse(event.body);
      } catch {
        return jsonResponse(400, {
          error: "BAD_JSON",
          message: "Request body must be valid JSON",
        });
      }
    }

    // ------------------------
    // GET /projects
    // ------------------------
    if (method === "GET" && path === "/projects") {
      // project_summaries index: permit_stage_createdAt_index
      // HASH: permit_stage, RANGE: created_at
      const permitStage = qs.permit_stage || "all";
      const limit = Math.max(1, Math.min(500, Number(qs.limit || 50)));
      const nextKey = qs.nextKey || null;

      // If filtering by permit_stage, query index; otherwise scan is avoided by storing "all" row in summaries.
      const indexName = "permit_stage_createdAt_index";
      const hashKeyName = "permit_stage";

      const result = await queryByProject({
        tableName: "project_summaries",
        indexName,
        hashKeyName,
        projectId: permitStage,
        limit,
        nextKeyStr: nextKey,
        scanIndexForward: false,
      });

      return jsonResponse(200, result);
    }

    // ------------------------------------
    // GET /projects/{project_id}/conditions
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
        scanIndexForward: true,
      });

      return jsonResponse(200, result);
    }

    // -----------------------------------
    // GET /projects/{project_id}/documents
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
        scanIndexForward: false,
      });

      return jsonResponse(200, result);
    }

    // -----------------------------------
    // GET /projects/{project_id}/members
    // -----------------------------------
    if (method === "GET" && path.endsWith("/members")) {
      const projectId = getProjectIdFromEvent(event);
      if (!projectId)
        return jsonResponse(400, { error: "MISSING_PROJECT_ID" });

      const limit = Math.max(1, Math.min(500, Number(qs.limit || 200)));
      const nextKey = qs.nextKey || null;

      const result = await queryByProject({
        tableName: PROJECT_MEMBERS_TABLE,
        indexName: "project_id_user_id_index",
        hashKeyName: "project_id",
        projectId,
        limit,
        nextKeyStr: nextKey,
        scanIndexForward: true,
      });

      return jsonResponse(200, result);
    }

    // -----------------------------------
    // POST /projects/{project_id}/members
    // body: { user_id, project_role }
    // -----------------------------------
    if (method === "POST" && path.endsWith("/members")) {
      const projectId = getProjectIdFromEvent(event);
      if (!projectId)
        return jsonResponse(400, { error: "MISSING_PROJECT_ID" });

      const userId = String(body.user_id || "").trim();
      const projectRole = String(body.project_role || "").trim();

      if (!userId || !projectRole) {
        return jsonResponse(400, {
          error: "MISSING_FIELDS",
          message: "user_id and project_role are required",
        });
      }

      const now = new Date().toISOString();
      const membership_id = membershipId(projectId, userId);

      const item = {
        membership_id,
        project_id: projectId,
        user_id: userId,
        project_role: projectRole,
        created_at: now,
        updated_at: now,
      };

      try {
        await ddb.send(
          new PutItemCommand({
            TableName: PROJECT_MEMBERS_TABLE,
            Item: marshall(item, { removeUndefinedValues: true }),
            ConditionExpression: "attribute_not_exists(membership_id)",
          })
        );
      } catch (e) {
        if (e?.name === "ConditionalCheckFailedException") {
          return jsonResponse(409, {
            error: "ALREADY_EXISTS",
            message: "User is already a member of this project",
          });
        }
        throw e;
      }

      return jsonResponse(201, item);
    }

    // -----------------------------------------
    // PATCH /projects/{project_id}/members/{user_id}
    // body: { project_role }
    // FIX: lookup membership_id via GSI so legacy rows work
    // -----------------------------------------
    if (method === "PATCH" && /\/members\/[A-Za-z0-9\-_.~%]+$/.test(path)) {
      const projectId = getProjectIdFromEvent(event);
      const userId = getUserIdFromEvent(event);

      if (!projectId)
        return jsonResponse(400, { error: "MISSING_PROJECT_ID" });
      if (!userId) return jsonResponse(400, { error: "MISSING_USER_ID" });

      const projectRole = String(body.project_role || "").trim();
      if (!projectRole) {
        return jsonResponse(400, {
          error: "MISSING_FIELDS",
          message: "project_role is required",
        });
      }

      const existing = await findMembershipByProjectAndUser(projectId, userId);
      if (!existing?.membership_id) {
        return jsonResponse(404, { error: "NOT_FOUND" });
      }

      const now = new Date().toISOString();

      const res = await ddb.send(
        new UpdateItemCommand({
          TableName: PROJECT_MEMBERS_TABLE,
          Key: { membership_id: { S: String(existing.membership_id) } },
          UpdateExpression: "SET project_role = :r, updated_at = :t",
          ExpressionAttributeValues: {
            ":r": { S: projectRole },
            ":t": { S: now },
          },
          ReturnValues: "ALL_NEW",
        })
      );

      return jsonResponse(200, unmarshall(res.Attributes || {}));
    }

    // -----------------------------------------
    // DELETE /projects/{project_id}/members/{user_id}
    // FIX: lookup membership_id via GSI so legacy rows work
    // -----------------------------------------
    if (method === "DELETE" && /\/members\/[A-Za-z0-9\-_.~%]+$/.test(path)) {
      const projectId = getProjectIdFromEvent(event);
      const userId = getUserIdFromEvent(event);

      if (!projectId)
        return jsonResponse(400, { error: "MISSING_PROJECT_ID" });
      if (!userId) return jsonResponse(400, { error: "MISSING_USER_ID" });

      const existing = await findMembershipByProjectAndUser(projectId, userId);
      if (!existing?.membership_id) {
        return jsonResponse(404, { error: "NOT_FOUND" });
      }

      await ddb.send(
        new DeleteItemCommand({
          TableName: PROJECT_MEMBERS_TABLE,
          Key: { membership_id: { S: String(existing.membership_id) } },
        })
      );

      return jsonResponse(200, { ok: true });
    }

    // -----------------------------------------
    // POST /projects/{project_id}/documents/upload-url
    // -----------------------------------------
    if (method === "POST" && path.endsWith("/documents/upload-url")) {
      const projectId = getProjectIdFromEvent(event);
      if (!projectId)
        return jsonResponse(400, { error: "MISSING_PROJECT_ID" });

      const project = await getProject(projectId);
      if (!project)
        return jsonResponse(404, {
          error: "NOT_FOUND",
          message: "Project not found",
        });

      const { filename, content_type } = body || {};
      if (!filename || !content_type) {
        return jsonResponse(400, {
          error: "MISSING_FIELDS",
          message: "filename and content_type are required",
        });
      }

      const safeName = String(filename).replace(/[^A-Za-z0-9._-]/g, "_");
      const id = crypto.randomUUID();
      const key = `projects/${projectId}/documents/${id}_${safeName}`;

      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: FILES_BUCKET,
          Key: key,
          ContentType: content_type,
        }),
        { expiresIn: 900 }
      );

      return jsonResponse(200, { upload_url: url, s3_key: key });
    }

    // -----------------------------------------
    // POST /projects/{project_id}/documents/registry
    // -----------------------------------------
    if (method === "POST" && path.endsWith("/documents/registry")) {
      const projectId = getProjectIdFromEvent(event);
      if (!projectId)
        return jsonResponse(400, { error: "MISSING_PROJECT_ID" });

      const project = await getProject(projectId);
      if (!project)
        return jsonResponse(404, {
          error: "NOT_FOUND",
          message: "Project not found",
        });

      const {
        s3_key,
        title,
        category,
        source = "user_upload",
        file_name,
        content_type,
      } = body || {};

      if (!s3_key) {
        return jsonResponse(400, {
          error: "MISSING_FIELDS",
          message: "s3_key is required",
        });
      }

      const now = new Date().toISOString();
      const document_id = crypto.randomUUID();

      const item = {
        document_id,
        project_id: projectId,
        s3_key,
        title: title || file_name || "Uploaded file",
        category: category || "Other",
        source,
        file_name: file_name || null,
        content_type: content_type || null,
        created_at: now,
        updated_at: now,
      };

      await ddb.send(
        new PutItemCommand({
          TableName: DOCUMENTS_TABLE,
          Item: marshall(item, { removeUndefinedValues: true }),
        })
      );

      return jsonResponse(201, item);
    }

    return jsonResponse(404, { error: "ROUTE_NOT_FOUND", method, path, user });
  } catch (err) {
    console.error("projects-api error:", err);
    return jsonResponse(500, {
      error: "INTERNAL_SERVER_ERROR",
      message: err?.message || "Unknown error",
    });
  }
};
