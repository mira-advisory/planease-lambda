// Node.js 24.x (ESM)
import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import crypto from "crypto";

const ddb = new DynamoDBClient({});

// Environment variables (set in Lambda config)
const INTAKE_TABLE = process.env.INTAKE_SESSIONS_TABLE; // "project_intake_sessions"
const FILES_BUCKET = process.env.PROJECT_FILES_BUCKET;  // "app-planease-files" (reserved for later)

// Step config for wizard
const STEP_CONFIG = {
  project: {
    attr: "project",
    currentStep: "PROJECT",
  },
  team: {
    attr: "team",
    currentStep: "TEAM",
  },
  documents: {
    attr: "documents",
    currentStep: "DOCUMENTS",
  },
  "council-conditions": {
    attr: "councilConditions",
    currentStep: "COUNCIL_CONDITIONS",
  },
};

export const handler = async (event) => {
  console.log("Incoming intake event:", JSON.stringify(event, null, 2));

  const method = event.requestContext?.http?.method || "";
  const rawPath =
    event.requestContext?.http?.path ||
    event.rawPath ||
    event.path ||
    "";

  const path = rawPath.replace(/\/+$/, ""); // strip trailing slash

  // ---------------------------------------------------------------------------
  // CORS preflight
  // ---------------------------------------------------------------------------
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: defaultHeaders(),
      body: "",
    };
  }

  // ---------------------------------------------------------------------------
  // ROUTE: POST /intake/session  (create new intake session)
  // ---------------------------------------------------------------------------
  if (method === "POST" && path === "/intake/session") {
    return await handleCreateSession(event);
  }

  // ---------------------------------------------------------------------------
  // ROUTES: PATCH /intake/session/{session_id}/(project|team|documents|council-conditions)
  // ---------------------------------------------------------------------------
  const stepMatch = path.match(
    /^\/intake\/session\/([^/]+)\/(project|team|documents|council-conditions)$/
  );
  if (method === "PATCH" && stepMatch) {
    const sessionId = stepMatch[1];
    const stepSegment = stepMatch[2]; // "project" | "team" | "documents" | "council-conditions"
    return await handlePatchStep(event, sessionId, stepSegment);
  }

  // ---------------------------------------------------------------------------
  // ROUTE: POST /intake/session/{session_id}/finalise  (stub for now)
  // ---------------------------------------------------------------------------
  const finaliseMatch = path.match(
    /^\/intake\/session\/([^/]+)\/finalise$/
  );
  if (method === "POST" && finaliseMatch) {
    const sessionId = finaliseMatch[1];
    // Real finalise logic (create project, conditions, etc.) will be added later.
    return json(200, {
      ok: true,
      route: "finalise-intake-stub",
      sessionId,
    });
  }

  // ---------------------------------------------------------------------------
  // Fallback: route not implemented
  // ---------------------------------------------------------------------------
  return json(404, {
    ok: false,
    error: "Route not implemented",
    method,
    path,
  });
};

// ============================================================================
// STEP 1: CREATE INTAKE SESSION  (POST /intake/session)
// ============================================================================
async function handleCreateSession(event) {
  if (!INTAKE_TABLE) {
    console.error("INTAKE_SESSIONS_TABLE env var is not set");
    return json(500, {
      ok: false,
      error: "Server misconfiguration: INTAKE_SESSIONS_TABLE not set",
    });
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    console.error("Bad JSON body:", e);
    return json(400, { ok: false, error: "Invalid JSON body" });
  }

  const councilCode = payload.councilCode;
  const daNumber = payload.daNumber;

  if (!councilCode) return json(400, { ok: false, error: "councilCode is required" });
  if (!daNumber) return json(400, { ok: false, error: "daNumber is required" });

  const claims = event.requestContext?.authorizer?.jwt?.claims || {};
  const createdBy = claims["username"] || claims["cognito:username"] || "unknown";
  const createdBySub = claims["sub"] || "unknown";

  const sessionId = `sess_${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const item = {
    session_id:       { S: sessionId },
    council_code:     { S: councilCode },
    da_number:        { S: daNumber },
    status:           { S: "DRAFT" },
    current_step:     { S: "PROJECT" },
    created_by:       { S: createdBy },
    created_by_sub:   { S: createdBySub },
    created_at:       { S: now },
    updated_at:       { S: now },
    step_data:        { M: {} }, // map of per-step JSON blobs
  };

  console.log("Writing intake session to Dynamo:", JSON.stringify(item, null, 2));

  try {
    await ddb.send(
      new PutItemCommand({
        TableName: INTAKE_TABLE,
        Item: item,
      })
    );
  } catch (err) {
    console.error("DynamoDB PutItem failed:", err);
    return json(500, {
      ok: false,
      error: "Failed to create intake session",
      details: err.message,
    });
  }

  return json(200, {
    ok: true,
    sessionId,
    status: "DRAFT",
    councilCode,
    daNumber,
  });
}

// ============================================================================
// STEP 2: UPDATE STEP (PATCH /intake/session/{session_id}/<step>)
// ============================================================================
async function handlePatchStep(event, sessionId, stepSegment) {
  if (!INTAKE_TABLE) {
    console.error("INTAKE_SESSIONS_TABLE env var is not set");
    return json(500, {
      ok: false,
      error: "Server misconfiguration: INTAKE_SESSIONS_TABLE not set",
    });
  }

  const stepConfig = STEP_CONFIG[stepSegment];
  if (!stepConfig) {
    return json(400, {
      ok: false,
      error: `Unknown step segment: ${stepSegment}`,
    });
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    console.error("Bad JSON body for step update:", e);
    return json(400, { ok: false, error: "Invalid JSON body" });
  }

  // 1) Ensure session exists
  let existing;
  try {
    const getResp = await ddb.send(
      new GetItemCommand({
        TableName: INTAKE_TABLE,
        Key: {
          session_id: { S: sessionId },
        },
      })
    );
    existing = getResp.Item;
  } catch (err) {
    console.error("DynamoDB GetItem failed:", err);
    return json(500, {
      ok: false,
      error: "Failed to load intake session",
      details: err.message,
    });
  }

  if (!existing) {
    return json(404, {
      ok: false,
      error: "Intake session not found",
      sessionId,
    });
  }

  const now = new Date().toISOString();

  // 2) Update step_data.<step> with JSON string, plus current_step + updated_at
  const updateParams = {
    TableName: INTAKE_TABLE,
    Key: {
      session_id: { S: sessionId },
    },
    UpdateExpression:
      "SET step_data.#stepKey = :stepVal, current_step = :cs, updated_at = :ua",
    ExpressionAttributeNames: {
      "#stepKey": stepConfig.attr,
    },
    ExpressionAttributeValues: {
      ":stepVal": { S: JSON.stringify(payload || {}) },
      ":cs": { S: stepConfig.currentStep },
      ":ua": { S: now },
    },
    ReturnValues: "ALL_NEW",
  };

  console.log(
    "Updating intake session step:",
    JSON.stringify(updateParams, null, 2)
  );

  let updated;
  try {
    const updateResp = await ddb.send(new UpdateItemCommand(updateParams));
    updated = updateResp.Attributes || {};
  } catch (err) {
    console.error("DynamoDB UpdateItem failed:", err);
    return json(500, {
      ok: false,
      error: "Failed to update intake session",
      details: err.message,
    });
  }

  const statusAttr = updated.status?.S || existing.status?.S || "DRAFT";

  return json(200, {
    ok: true,
    sessionId,
    step: stepConfig.attr,
    status: statusAttr,
    data: payload,
  });
}

// ============================================================================
// Helpers
// ============================================================================
function json(statusCode, body) {
  return {
    statusCode,
    headers: defaultHeaders(),
    body: JSON.stringify(body),
  };
}

function defaultHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PATCH",
  };
}
