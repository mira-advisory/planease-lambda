import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
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

  // Optional index overrides (defaults match your current code)
  PROJECT_SUMMARIES_INDEX = "permit_stage_createdAt_index",
  CONDITIONS_PROJECT_INDEX = "project_id_index",
  DOCUMENTS_PROJECT_CREATED_INDEX = "gsi_project_created",
  PROJECT_MEMBERS_INDEX = "project_id_user_id_index",

  // Comments indexes (match DynamoDB GSIs you showed)
  COMMENTS_CONDITION_CREATED_INDEX = "GSI1-conditionId-createdAt",
  COMMENTS_PROJECT_CREATED_INDEX = "GSI2-projectId-createdAt",
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
  const pp = event?.pathParameters || {};
  const direct =
    pp.project_id || pp.projectId || pp["project_id"] || pp["projectId"];
  if (direct) return direct;

  const path = getHttpPath(event) || "";
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "projects" && parts[1]) return parts[1];

  return null;
}

function getUserIdFromEvent(event) {
  const pp = event?.pathParameters || {};
  const direct = pp.user_id || pp.userId || pp["user_id"] || pp["userId"];
  if (direct) return direct;

  const path = getHttpPath(event) || "";
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "projects" && parts[2] === "members" && parts[3])
    return parts[3];

  return null;
}

function getConditionIdFromEvent(event) {
  const pp = event?.pathParameters || {};
  const direct =
    pp.condition_id ||
    pp.conditionId ||
    pp["condition_id"] ||
    pp["conditionId"];
  if (direct) return direct;

  const path = getHttpPath(event) || "";
  const parts = path.split("/").filter(Boolean);
  // /projects/{project_id}/conditions/{condition_id}/...
  const idx = parts.findIndex((p) => p === "conditions");
  if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];

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
      IndexName: PROJECT_MEMBERS_INDEX,
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

function isDynamoIndexOrKeyError(err) {
  const msg = String(err?.message || "");
  const name = String(err?.name || "");
  return (
    name === "ValidationException" ||
    msg.includes("The table does not have the specified index") ||
    msg.includes("Query condition missed key schema element") ||
    msg.includes("provided key element does not match the schema")
  );
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

/**
 * Fallback when index/key is wrong: Scan + FilterExpression on project_id.
 * Note: Scan does not guarantee ordering.
 */
async function scanByProject({ tableName, projectId, limit, nextKeyStr }) {
  const ExclusiveStartKey = decodeNextKey(nextKeyStr);

  const res = await ddb.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: "#pid = :pid",
      ExpressionAttributeNames: {
        "#pid": "project_id",
      },
      ExpressionAttributeValues: {
        ":pid": { S: projectId },
      },
      Limit: limit,
      ExclusiveStartKey: ExclusiveStartKey || undefined,
    })
  );

  const items = (res.Items || []).map((it) => unmarshall(it));
  const nextKey = encodeNextKey(res.LastEvaluatedKey);
  return { items, nextKey, source: "scan_fallback" };
}

async function getProject(projectId) {
  const res = await ddb.send(
    new GetItemCommand({
      TableName: PROJECTS_TABLE,
      Key: { project_id: { S: projectId } },
    })
  );
  return res.Item ? unmarshall(res.Item) : null;
}

/**
 * Comments:
 * Table PK: (commentId HASH, createdAt RANGE)
 * We query via GSIs:
 * - GSI1-conditionId-createdAt  (conditionId HASH, createdAt RANGE)
 * - GSI2-projectId-createdAt    (projectId HASH, createdAt RANGE)
 */
async function queryCommentsByCondition({
  projectId,
  conditionId,
  limit,
  nextKeyStr,
  newestFirst = true,
}) {
  const ExclusiveStartKey = decodeNextKey(nextKeyStr);

  const res = await ddb.send(
    new QueryCommand({
      TableName: COMMENTS_TABLE,
      IndexName: COMMENTS_CONDITION_CREATED_INDEX,
      KeyConditionExpression: "conditionId = :cid",
      ExpressionAttributeValues: {
        ":cid": { S: conditionId },
      },
      Limit: limit,
      ExclusiveStartKey: ExclusiveStartKey || undefined,
      ScanIndexForward: newestFirst ? false : true,
    })
  );

  // Extra safety: enforce project scope (because index is on conditionId only)
  const items = (res.Items || [])
    .map((it) => unmarshall(it))
    .filter((it) => !projectId || it.projectId === projectId);

  const nextKey = encodeNextKey(res.LastEvaluatedKey);

  return { items, nextKey };
}

function buildUpdateExpressionFromBody(body, allowedFields) {
  const sets = [];
  const names = {};
  const values = {};

  for (const field of allowedFields) {
    if (body[field] === undefined) continue;

    const nameKey = `#${field}`;
    const valueKey = `:${field}`;

    names[nameKey] = field;

    // allow null (explicitly clearing a field)
    const v = body[field];
    values[valueKey] =
      v === null ? { NULL: true } : marshall({ v }).v; // marshall scalar safely
    sets.push(`${nameKey} = ${valueKey}`);
  }

  if (sets.length === 0) return null;

  return {
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

export const handler = async (event) => {
  try {
    const method = getHttpMethod(event);
    const path = getHttpPath(event);

    if (method === "OPTIONS") return jsonResponse(200, { ok: true });

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
      const permitStage = qs.permit_stage || "all";
      const limit = Math.max(1, Math.min(500, Number(qs.limit || 50)));
      const nextKey = qs.nextKey || null;

      const result = await queryByProject({
        tableName: "project_summaries",
        indexName: PROJECT_SUMMARIES_INDEX,
        hashKeyName: "permit_stage",
        projectId: permitStage,
        limit,
        nextKeyStr: nextKey,
        scanIndexForward: false,
      });

      return jsonResponse(200, result);
    }

    // ------------------------
    // GET /projects/{project_id}
    // ------------------------
    if (method === "GET" && /^\/projects\/[^/]+$/.test(path)) {
      const projectId = getProjectIdFromEvent(event);
      if (!projectId) return jsonResponse(400, { error: "MISSING_PROJECT_ID" });

      const project = await getProject(projectId);
      if (!project) {
        return jsonResponse(404, {
          error: "NOT_FOUND",
          message: "Project not found",
        });
      }

      return jsonResponse(200, project);
    }

    // ------------------------------------
    // GET /projects/{project_id}/conditions
    // ------------------------------------
    if (method === "GET" && path.endsWith("/conditions")) {
      const projectId = getProjectIdFromEvent(event);
      if (!projectId) return jsonResponse(400, { error: "MISSING_PROJECT_ID" });

      const limit = Math.max(1, Math.min(500, Number(qs.limit || 100)));
      const nextKey = qs.nextKey || null;

      try {
        const result = await queryByProject({
          tableName: CONDITIONS_TABLE,
          indexName: CONDITIONS_PROJECT_INDEX,
          hashKeyName: "project_id",
          projectId,
          limit,
          nextKeyStr: nextKey,
          scanIndexForward: true,
        });
        return jsonResponse(200, result);
      } catch (e) {
        if (isDynamoIndexOrKeyError(e)) {
          const fallback = await scanByProject({
            tableName: CONDITIONS_TABLE,
            projectId,
            limit,
            nextKeyStr: nextKey,
          });
          return jsonResponse(200, fallback);
        }
        throw e;
      }
    }

    // -----------------------------------------------------------
    // PATCH /projects/{project_id}/conditions/{condition_id}
    // Snappy update endpoint (status/assignee/dates/priority etc.)
    // -----------------------------------------------------------
    if (
      method === "PATCH" &&
      /^\/projects\/[^/]+\/conditions\/[^/]+$/.test(path)
    ) {
      const projectId = getProjectIdFromEvent(event);
      const conditionId = getConditionIdFromEvent(event);

      if (!projectId) return jsonResponse(400, { error: "MISSING_PROJECT_ID" });
      if (!conditionId)
        return jsonResponse(400, { error: "MISSING_CONDITION_ID" });

      // whitelist fields you want editable from the UI
      const allowed = [
        "status",
        "priority",
        "assigned_to",
        "assigned_to_user_id",
        "assigned_to_name",
        "due_date",
        "completed_date",
        "title",
        "description",
      ];

      const now = new Date().toISOString();

      // always update updated_at if any allowed field is present
      const patch = { ...body };
      patch.updated_at = now;

      const expr = buildUpdateExpressionFromBody(patch, [
        ...allowed,
        "updated_at",
      ]);

      if (!expr) {
        return jsonResponse(400, {
          error: "MISSING_FIELDS",
          message: "No valid fields to update",
        });
      }

      // NOTE: We assume conditions table PK is `condition_id` (common in this codebase).
      // We also enforce the project_id match so you can't update a condition in another project.
      let res;
      try {
        res = await ddb.send(
          new UpdateItemCommand({
            TableName: CONDITIONS_TABLE,
            Key: { condition_id: { S: conditionId } },
            ...expr,
            ConditionExpression:
              "attribute_exists(condition_id) AND project_id = :pid",
            ExpressionAttributeValues: {
              ...expr.ExpressionAttributeValues,
              ":pid": { S: projectId },
            },
            ReturnValues: "ALL_NEW",
          })
        );
      } catch (e) {
        if (e?.name === "ConditionalCheckFailedException") {
          return jsonResponse(404, {
            error: "NOT_FOUND",
            message: "Condition not found for this project",
          });
        }
        // If your table PK is not condition_id, Dynamo will throw a schema error.
        // We'll surface that clearly rather than hiding it.
        if (isDynamoIndexOrKeyError(e)) {
          return jsonResponse(500, {
            error: "SCHEMA_MISMATCH",
            message:
              "Conditions table key schema does not match expected Key {condition_id}. Describe the conditions table keys and update this handler accordingly.",
            detail: e?.message || String(e),
          });
        }
        throw e;
      }

      return jsonResponse(200, unmarshall(res.Attributes || {}));
    }

    // -----------------------------------
    // GET /projects/{project_id}/documents
    // -----------------------------------
    if (method === "GET" && path.endsWith("/documents")) {
      const projectId = getProjectIdFromEvent(event);
      if (!projectId) return jsonResponse(400, { error: "MISSING_PROJECT_ID" });

      const limit = Math.max(1, Math.min(500, Number(qs.limit || 100)));
      const nextKey = qs.nextKey || null;

      try {
        const result = await queryByProject({
          tableName: DOCUMENTS_TABLE,
          indexName: DOCUMENTS_PROJECT_CREATED_INDEX,
          hashKeyName: "project_id",
          projectId,
          limit,
          nextKeyStr: nextKey,
          scanIndexForward: false,
        });
        return jsonResponse(200, result);
      } catch (e) {
        if (isDynamoIndexOrKeyError(e)) {
          const fallback = await scanByProject({
            tableName: DOCUMENTS_TABLE,
            projectId,
            limit,
            nextKeyStr: nextKey,
          });
          return jsonResponse(200, fallback);
        }
        throw e;
      }
    }

    // -----------------------------------
    // GET /projects/{project_id}/members
    // -----------------------------------
    if (method === "GET" && path.endsWith("/members")) {
      const projectId = getProjectIdFromEvent(event);
      if (!projectId) return jsonResponse(400, { error: "MISSING_PROJECT_ID" });

      const limit = Math.max(1, Math.min(500, Number(qs.limit || 200)));
      const nextKey = qs.nextKey || null;

      try {
        const result = await queryByProject({
          tableName: PROJECT_MEMBERS_TABLE,
          indexName: PROJECT_MEMBERS_INDEX,
          hashKeyName: "project_id",
          projectId,
          limit,
          nextKeyStr: nextKey,
          scanIndexForward: true,
        });
        return jsonResponse(200, result);
      } catch (e) {
        if (isDynamoIndexOrKeyError(e)) {
          const fallback = await scanByProject({
            tableName: PROJECT_MEMBERS_TABLE,
            projectId,
            limit,
            nextKeyStr: nextKey,
          });
          return jsonResponse(200, fallback);
        }
        throw e;
      }
    }

    // -----------------------------------
    // POST /projects/{project_id}/members
    // body: { user_id, project_role }
    // -----------------------------------
    if (method === "POST" && path.endsWith("/members")) {
      const projectId = getProjectIdFromEvent(event);
      if (!projectId) return jsonResponse(400, { error: "MISSING_PROJECT_ID" });

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
    // -----------------------------------------
    if (method === "PATCH" && /\/members\/[A-Za-z0-9\-_.~%]+$/.test(path)) {
      const projectId = getProjectIdFromEvent(event);
      const userId = getUserIdFromEvent(event);

      if (!projectId) return jsonResponse(400, { error: "MISSING_PROJECT_ID" });
      if (!userId) return jsonResponse(400, { error: "MISSING_USER_ID" });

      const projectRole = String(body.project_role || "").trim();
      if (!projectRole) {
        return jsonResponse(400, {
          error: "MISSING_FIELDS",
          message: "project_role is required",
        });
      }

      const existing = await findMembershipByProjectAndUser(projectId, userId);
      if (!existing?.membership_id)
        return jsonResponse(404, { error: "NOT_FOUND" });

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
    // -----------------------------------------
    if (method === "DELETE" && /\/members\/[A-Za-z0-9\-_.~%]+$/.test(path)) {
      const projectId = getProjectIdFromEvent(event);
      const userId = getUserIdFromEvent(event);

      if (!projectId) return jsonResponse(400, { error: "MISSING_PROJECT_ID" });
      if (!userId) return jsonResponse(400, { error: "MISSING_USER_ID" });

      const existing = await findMembershipByProjectAndUser(projectId, userId);
      if (!existing?.membership_id)
        return jsonResponse(404, { error: "NOT_FOUND" });

      await ddb.send(
        new DeleteItemCommand({
          TableName: PROJECT_MEMBERS_TABLE,
          Key: { membership_id: { S: String(existing.membership_id) } },
        })
      );

      return jsonResponse(200, { ok: true });
    }

    // ---------------------------------------------------------
    // GET /projects/{project_id}/conditions/{condition_id}/comments
    // ---------------------------------------------------------
    if (
      method === "GET" &&
      /^\/projects\/[^/]+\/conditions\/[^/]+\/comments$/.test(path)
    ) {
      const projectId = getProjectIdFromEvent(event);
      const conditionId = getConditionIdFromEvent(event);

      if (!projectId) return jsonResponse(400, { error: "MISSING_PROJECT_ID" });
      if (!conditionId)
        return jsonResponse(400, { error: "MISSING_CONDITION_ID" });

      const limit = Math.max(1, Math.min(500, Number(qs.limit || 100)));
      const nextKey = qs.nextKey || null;

      const result = await queryCommentsByCondition({
        projectId,
        conditionId,
        limit,
        nextKeyStr: nextKey,
        newestFirst: true,
      });

      return jsonResponse(200, result);
    }

    // ----------------------------------------------------------
    // POST /projects/{project_id}/conditions/{condition_id}/comments
    // body: { content, comment_type?, metadata? }
    // ----------------------------------------------------------
    if (
      method === "POST" &&
      /^\/projects\/[^/]+\/conditions\/[^/]+\/comments$/.test(path)
    ) {
      const projectId = getProjectIdFromEvent(event);
      const conditionId = getConditionIdFromEvent(event);

      if (!projectId) return jsonResponse(400, { error: "MISSING_PROJECT_ID" });
      if (!conditionId)
        return jsonResponse(400, { error: "MISSING_CONDITION_ID" });

      const content = String(body.content || body.message || "").trim();
      if (!content) {
        return jsonResponse(400, {
          error: "MISSING_FIELDS",
          message: "content is required",
        });
      }

      const now = new Date().toISOString();
      const commentId = crypto.randomUUID();

      const item = {
        commentId,
        createdAt: now,
        projectId,
        conditionId,

        // payload
        content,
        commentType: String(body.comment_type || body.commentType || "comment"),
        metadata: body.metadata || null,

        // author
        authorUserId: user.userId,
        authorEmail: user.email,
        authorName: user.name,
      };

      await ddb.send(
        new PutItemCommand({
          TableName: COMMENTS_TABLE,
          Item: marshall(item, { removeUndefinedValues: true }),
        })
      );

      return jsonResponse(201, item);
    }

    // -----------------------------------------
    // POST /projects/{project_id}/documents/upload-url
    // -----------------------------------------
    if (method === "POST" && path.endsWith("/documents/upload-url")) {
      const projectId = getProjectIdFromEvent(event);
      if (!projectId) return jsonResponse(400, { error: "MISSING_PROJECT_ID" });

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
      if (!projectId) return jsonResponse(400, { error: "MISSING_PROJECT_ID" });

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
