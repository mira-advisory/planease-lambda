import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const PROJECT_MEMBERS_TABLE = process.env.PROJECT_MEMBERS_TABLE || "project_members";
const PROJECT_SUMMARIES_TABLE = process.env.PROJECT_SUMMARIES_TABLE || "project_summaries";
const USER_ID_INDEX = process.env.PROJECT_MEMBERS_USER_INDEX || "user_id_index";

function httpResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Methods": "OPTIONS,GET",
    },
    body: JSON.stringify(body),
  };
}

function getUserIdFromEvent(event) {
  const claims =
    event?.requestContext?.authorizer?.jwt?.claims ||
    event?.requestContext?.authorizer?.claims ||
    null;
  return claims?.sub || null;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export const handler = async (event) => {
  try {
    const http = event?.requestContext?.http || {};
    if (http.method === "OPTIONS") return httpResponse(200, { ok: true });

    const userId = getUserIdFromEvent(event);
    if (!userId) return httpResponse(401, { ok: false, error: "UNAUTHENTICATED" });

    // 1) Query membership by user id
    const q = await ddb.send(
      new QueryCommand({
        TableName: PROJECT_MEMBERS_TABLE,
        IndexName: USER_ID_INDEX, // ✅ must match actual GSI name: user_id_index
        KeyConditionExpression: "user_id = :uid",
        ExpressionAttributeValues: {
          ":uid": userId,
        },
      })
    );

    const memberships = q.Items || [];
    const projectIds = memberships
      .map((m) => m.project_id)
      .filter((v) => typeof v === "string" && v.length > 0);

    if (projectIds.length === 0) {
      return httpResponse(200, { ok: true, projects: [], nextToken: null });
    }

    // 2) BatchGet summaries (100 keys max per call)
    const keys = projectIds.map((pid) => ({ project_id: pid }));
    const batches = chunk(keys, 100);

    const projects = [];
    for (const batch of batches) {
      const resp = await ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [PROJECT_SUMMARIES_TABLE]: {
              Keys: batch,
            },
          },
        })
      );

      const got = resp.Responses?.[PROJECT_SUMMARIES_TABLE] || [];
      projects.push(...got);
    }

    // Optional: sort newest first
    projects.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));

    return httpResponse(200, { ok: true, projects, nextToken: null });
  } catch (err) {
    console.error("LIST_PROJECTS_FAILED:", err);
    return httpResponse(500, {
      ok: false,
      error: "LIST_PROJECTS_FAILED",
      message: err?.message || "Unknown error",
    });
  }
};
