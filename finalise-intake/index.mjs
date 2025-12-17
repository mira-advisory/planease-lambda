import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  CopyObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import crypto from "crypto";
import path from "path";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const INTAKE_TABLE = process.env.INTAKE_TABLE || "project_intake_sessions";
const PROJECTS_TABLE = process.env.PROJECTS_TABLE || "projects";
const CONDITIONS_TABLE = process.env.CONDITIONS_TABLE || "conditions";
const DOCUMENTS_TABLE = process.env.DOCUMENTS_TABLE || "documents";
const PROJECT_SUMMARY_TABLE =
  process.env.PROJECT_SUMMARY_TABLE || "project_summaries";
const PROJECT_MEMBERS_TABLE =
  process.env.PROJECT_MEMBERS_TABLE || "project_members";
const FILES_BUCKET = process.env.FILES_BUCKET || "app-planease-files";

const nowIso = () => new Date().toISOString();

function httpResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Methods": "OPTIONS,POST",
    },
    body: JSON.stringify(body),
  };
}

function safeJsonParse(s, fallback = null) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function uuid() {
  return crypto.randomUUID();
}

// ---- auth helpers ----
function getJwtClaims(event) {
  return (
    event?.requestContext?.authorizer?.jwt?.claims ||
    event?.requestContext?.authorizer?.claims ||
    null
  );
}

function getUserIdFromEvent(event) {
  const claims = getJwtClaims(event);
  return claims?.sub || null;
}

// ---- S3 helpers ----
function isIntakeKey(key) {
  if (!key || typeof key !== "string") return false;
  return key.startsWith("intake/") || key.includes("/intake/");
}

function basenameFromKey(key) {
  try {
    return path.basename(key);
  } catch {
    const parts = String(key).split("/");
    return parts[parts.length - 1] || "file";
  }
}

async function headExists(key) {
  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: FILES_BUCKET,
        Key: key,
      })
    );
    return true;
  } catch {
    return false;
  }
}

function addTimestampBeforeExt(filename) {
  const ext = path.extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  return `${base}_${Date.now()}${ext}`;
}

async function ensureUniqueDestKey(destKey) {
  if (!(await headExists(destKey))) return destKey;

  const dir = path.posix.dirname(destKey);
  const file = path.posix.basename(destKey);
  const bumped = addTimestampBeforeExt(file);
  return `${dir}/${bumped}`;
}

async function copyS3Object({ sourceKey, destKey }) {
  const finalDestKey = await ensureUniqueDestKey(destKey);

  await s3.send(
    new CopyObjectCommand({
      Bucket: FILES_BUCKET,
      CopySource: `${FILES_BUCKET}/${sourceKey}`,
      Key: finalDestKey,
    })
  );

  // verify destination exists
  await s3.send(
    new HeadObjectCommand({
      Bucket: FILES_BUCKET,
      Key: finalDestKey,
    })
  );

  return finalDestKey;
}

/**
 * Extract what finalise needs from session.step_data
 */
function extractFromSession(session) {
  const step = session.step_data || {};

  const councilConditionsRaw = step.councilConditions;
  const councilConditionsObj =
    typeof councilConditionsRaw === "string"
      ? safeJsonParse(councilConditionsRaw, null)
      : councilConditionsRaw || null;

  const parsed = councilConditionsObj?.parsed || null;
  const councilConditionsFileKey = councilConditionsObj?.fileKey || null;

  const lookupDocuments =
    step.lookupDocuments ||
    step.councilLookupDocuments ||
    step.councilLookup?.projectMetadata?.raw?.documents ||
    session.lookupDocuments ||
    [];

  const projectDetails = step.projectDetails || step.projectInfo || {};

  return {
    parsed,
    lookupDocuments,
    projectDetails,
    councilConditionsFileKey,
    step_data: step,
  };
}

function flattenConditions(parsed) {
  const sections = parsed?.conditions?.sections || [];
  const rows = [];

  for (const sec of sections) {
    const sectionTitle = sec?.title || "General";
    const conds = sec?.conditions || [];
    for (const c of conds) {
      rows.push({
        number: c.number,
        parentNumber: c.parentNumber || null,
        sectionTitle,
        title: c.title || "",
        description: c.description || "",
        timing: c.timing || "",
        timingSource: c.timingSource || "",
        timingColumn: c.timingColumn || "",
        timingInline: c.timingInline || "",
        material: c.material ?? null,
      });

      const kids = c.children || [];
      for (const k of kids) {
        rows.push({
          number: k.number,
          parentNumber: k.parentNumber || c.number || null,
          sectionTitle,
          title: k.title || "",
          description: k.description || "",
          timing: k.timing || "",
          timingSource: k.timingSource || "",
          timingColumn: k.timingColumn || "",
          timingInline: k.timingInline || "",
          material: k.material ?? null,
        });
      }
    }
  }

  return rows;
}

function mergeDocuments({ lookupDocuments, parsedDocuments }) {
  const councilDocs = (lookupDocuments || []).map((d) => ({
    source: "council_lookup",
    externalId: d.documentId || null,
    title: d.fileName || "",
    category: d.category || "",
    docDate: d.fileDate || "",
    fileExtension: d.fileextension || "",
    downloadUrl: d.downloadUrl || "",
    s3Key: d.s3Key || d.s3_key || d.key || null,
    raw: d,
  }));

  const parserDocs = (parsedDocuments || []).map((d) => ({
    source: "conditions_parser",
    externalId: null,
    title: d.title || "",
    category: "Parser: Approved Drawings/Documents",
    docDate: d.planDate || "",
    fileExtension: "",
    downloadUrl: "",
    s3Key: d.s3Key || d.s3_key || d.key || null,
    raw: d,
  }));

  return { councilDocs, parserDocs, all: [...councilDocs, ...parserDocs] };
}

function collectIntakeFiles({
  sessionStep,
  councilConditionsFileKey,
  lookupDocuments,
}) {
  const files = [];

  // 1) conditions package file
  if (isIntakeKey(councilConditionsFileKey)) {
    files.push({
      sourceKey: councilConditionsFileKey,
      type: "conditions",
      source: "council_conditions_file",
    });
  }

  // 2) intake uploads arrays
  const possibleArrays = [
    sessionStep?.uploads,
    sessionStep?.intakeUploads,
    sessionStep?.uploadedDocuments,
    sessionStep?.documents,
    sessionStep?.projectDocuments,
    sessionStep?.files,
  ].filter(Array.isArray);

  for (const arr of possibleArrays) {
    for (const item of arr) {
      const key =
        item?.s3Key ||
        item?.s3_key ||
        item?.key ||
        item?.fileKey ||
        item?.file_key;
      if (isIntakeKey(key)) {
        files.push({
          sourceKey: key,
          type: "documents",
          source: "intake_upload",
        });
      }
    }
  }

  // 3) council lookup docs that have s3Key stored (optional)
  for (const d of lookupDocuments || []) {
    const key = d?.s3Key || d?.s3_key || d?.key || null;
    if (isIntakeKey(key)) {
      files.push({
        sourceKey: key,
        type: "documents",
        source: "lookup_doc_s3",
      });
    }
  }

  // de-dupe
  const seen = new Set();
  return files.filter((f) => {
    if (!f.sourceKey) return false;
    if (seen.has(f.sourceKey)) return false;
    seen.add(f.sourceKey);
    return true;
  });
}

async function batchWriteAll(tableName, items, keyNameForLog) {
  const parts = chunk(items, 25);
  let written = 0;

  for (const part of parts) {
    let resp = await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName]: part.map((Item) => ({ PutRequest: { Item } })),
        },
      })
    );

    let unprocessed = resp.UnprocessedItems?.[tableName] || [];
    let attempts = 0;

    while (unprocessed.length > 0 && attempts < 6) {
      attempts++;
      resp = await ddb.send(
        new BatchWriteCommand({
          RequestItems: { [tableName]: unprocessed },
        })
      );
      unprocessed = resp.UnprocessedItems?.[tableName] || [];
    }

    if (unprocessed.length > 0) {
      const sample =
        unprocessed[0]?.PutRequest?.Item?.[keyNameForLog] ?? "unknown";
      throw new Error(
        `BatchWrite left unprocessed items in ${tableName}. Sample ${keyNameForLog}=${sample}`
      );
    }

    written += part.length;
  }

  return written;
}

export const handler = async (event) => {
  const progress = [];
  const pushStep = (id, title, status, meta = {}) => {
    progress.push({ id, title, status, ...meta, at: nowIso() });
  };

  try {
    const http = event?.requestContext?.http || {};
    if (http.method === "OPTIONS") {
      return httpResponse(200, { ok: true });
    }

    // must be authenticated (JWT authorizer)
    const userId = getUserIdFromEvent(event);
    if (!userId) {
      return httpResponse(401, { ok: false, error: "UNAUTHENTICATED", progress });
    }

    // sessionId from path: /intake/session/{session_id}/finalise
    let sessionIdFromPath = null;
    if (http.path) {
      const parts = http.path.split("/");
      if (parts.length >= 5) sessionIdFromPath = parts[3];
    }

    let body = {};
    if (event?.body) {
      try {
        body = JSON.parse(event.body);
      } catch {
        return httpResponse(400, { ok: false, error: "INVALID_JSON", progress });
      }
    }

    const sessionId = body.sessionId || sessionIdFromPath;
    if (!sessionId) {
      return httpResponse(400, {
        ok: false,
        error: "MISSING_SESSION",
        message: "sessionId is required",
        progress,
      });
    }

    pushStep("load_session", "Load intake session", "running");

    const sessionResp = await ddb.send(
      new GetCommand({
        TableName: INTAKE_TABLE,
        Key: { session_id: sessionId },
      })
    );

    const session = sessionResp.Item;
    if (!session) {
      pushStep("load_session", "Load intake session", "failed");
      return httpResponse(404, {
        ok: false,
        error: "SESSION_NOT_FOUND",
        progress,
      });
    }

    // Idempotency: if already finalised, return same projectId
    if (session.finalised === true && session.project_id) {
      pushStep("load_session", "Load intake session", "done");
      pushStep("already_finalised", "Already finalised", "done", {
        projectId: session.project_id,
      });
      return httpResponse(200, {
        ok: true,
        route: "finalise-intake",
        sessionId,
        projectId: session.project_id,
        alreadyFinalised: true,
        progress,
      });
    }

    pushStep("load_session", "Load intake session", "done");

    const {
      parsed,
      lookupDocuments,
      projectDetails,
      councilConditionsFileKey,
      step_data,
    } = extractFromSession(session);

    if (!parsed) {
      return httpResponse(400, {
        ok: false,
        error: "MISSING_PARSED_CONDITIONS",
        message:
          "No parsed conditions payload found in session. Ensure conditions/parse has been run before finalise.",
        progress,
      });
    }

    // Create canonical project_id ONCE and reuse everywhere
    pushStep("create_project", "Create project", "running");

    const projectId = uuid();
    const councilCode =
      parsed.council || session.councilCode || session.council_code || null;

    const app = parsed.applicationDetails || {};
    const permit = parsed.permitInfo || {};
    const summary = parsed.summary || {};

    const projectItem = {
      project_id: projectId,
      created_at: nowIso(),
      updated_at: nowIso(),
      source: "intake",
      intake_session_id: sessionId,
      council_code: councilCode,

      da_number:
        app.councilFileReference || session.daNumber || session.da_number || "",
      address: app.addressOfSite || projectDetails.address || "",
      real_property_description: app.realPropertyDescriptionOfSite || "",
      approval_type: app.aspectsOfDevelopmentAndTypeOfApproval || "",
      permit_stage: permit.stage || "",
      package_status: app.packageStatus || "",
      package_generated: app.packageGenerated || "",

      created_by_user_id: userId,

      parsed_snapshot: parsed,
    };

    await ddb.send(
      new PutCommand({
        TableName: PROJECTS_TABLE,
        Item: projectItem,
        ConditionExpression: "attribute_not_exists(project_id)",
      })
    );

    pushStep("create_project", "Create project", "done", { projectId });

    // membership
    pushStep("write_membership", "Attach creator to project", "running");

    await ddb.send(
      new PutCommand({
        TableName: PROJECT_MEMBERS_TABLE,
        Item: {
          membership_id: uuid(),
          project_id: projectId,
          user_id: userId,
          role: "owner",
          is_active: true,
          created_at: nowIso(),
          updated_at: nowIso(),
          source: "intake",
        },
      })
    );

    pushStep("write_membership", "Attach creator to project", "done");

    // Copy intake S3 files
    pushStep("copy_files", "Copy intake files to project folders", "running");

    const intakeFiles = collectIntakeFiles({
      sessionStep: step_data,
      councilConditionsFileKey,
      lookupDocuments,
    });

    const copiedFiles = []; // { sourceKey, destKey, type }

    for (const f of intakeFiles) {
      const filename = basenameFromKey(f.sourceKey);

      const baseDestKey =
        f.type === "conditions"
          ? `projects/${projectId}/conditions/${filename}`
          : `projects/${projectId}/documents/${filename}`;

      const finalDestKey = await copyS3Object({
        sourceKey: f.sourceKey,
        destKey: baseDestKey,
      });

      copiedFiles.push({
        sourceKey: f.sourceKey,
        destKey: finalDestKey,
        type: f.type,
      });
    }

    if (copiedFiles.length === 0) {
      pushStep("copy_files", "Copy intake files to project folders", "skipped", {
        message: "No intake S3 files found to copy",
      });
    } else {
      pushStep("copy_files", "Copy intake files to project folders", "done", {
        count: copiedFiles.length,
      });
    }

    // Conditions (FIXED: include condition_number for GSI sort key)
    pushStep("write_conditions", "Write conditions", "running");

    const flatConditions = flattenConditions(parsed);
    const conditionItems = flatConditions.map((c) => {
      const condNum = (c.number ?? "").toString().trim();

      return {
        condition_id: uuid(),
        project_id: projectId,
        created_at: nowIso(),
        updated_at: nowIso(),
        source: "intake",
        council_code: councilCode,

        // ✅ required by conditions.project_id_index sort key
        condition_number: condNum,

        // optional legacy
        number: condNum,

        parent_number: c.parentNumber || null,
        section_title: c.sectionTitle,
        title: c.title,
        description: c.description,
        timing: c.timing,
        timing_source: c.timingSource,
        timing_column: c.timingColumn,
        timing_inline: c.timingInline,
        material: c.material,
        status: "new",
      };
    });

    const writtenConditions = await batchWriteAll(
      CONDITIONS_TABLE,
      conditionItems,
      "condition_id"
    );

    pushStep("write_conditions", "Write conditions", "done", {
      count: writtenConditions,
    });

    // Documents (ensure created_at + project_id ALWAYS present for gsi_project_created)
    pushStep("write_documents", "Write documents", "running");

    const { councilDocs, parserDocs, all } = mergeDocuments({
      lookupDocuments,
      parsedDocuments: parsed.documents || [],
    });

    const copiedBySourceKey = new Map(
      copiedFiles.map((c) => [c.sourceKey, c.destKey])
    );

    const docItems = all.map((d) => {
      const raw = d.raw || {};
      const sourceS3Key = d.s3Key || raw.s3Key || raw.s3_key || raw.key || null;
      const destS3Key = sourceS3Key ? copiedBySourceKey.get(sourceS3Key) : null;

      return {
        document_id: uuid(),

        // ✅ required for documents GSIs
        project_id: projectId,
        created_at: nowIso(),

        updated_at: nowIso(),
        source: d.source,
        council_code: councilCode,
        external_id: d.externalId,
        title: d.title,
        category: d.category,
        doc_date: d.docDate,
        file_extension: d.fileExtension,

        // ✅ normalize S3 field names to match your other code
        s3_bucket: destS3Key ? FILES_BUCKET : null,
        s3_key: destS3Key || null,

        // if we copied to S3, we don't need external URL
        download_url: destS3Key ? null : d.downloadUrl,

        raw,
      };
    });

    const writtenDocs = await batchWriteAll(
      DOCUMENTS_TABLE,
      docItems,
      "document_id"
    );

    pushStep("write_documents", "Write documents", "done", {
      count: writtenDocs,
      councilLookupCount: councilDocs.length,
      parserDocsCount: parserDocs.length,
    });

    // Summary cache table
    pushStep("write_summary", "Write project summary", "running");

    const summaryItem = {
      project_id: projectId,
      updated_at: nowIso(),
      created_at: nowIso(),
      council_code: councilCode,
      address: projectItem.address,
      da_number: projectItem.da_number,
      package_status: projectItem.package_status,

      conditions_count:
        typeof summary.numberOfConditions === "number"
          ? summary.numberOfConditions
          : writtenConditions,

      documents_count:
        (lookupDocuments?.length || 0) + (parsed.documents?.length || 0),

      council_documents_count: lookupDocuments?.length || 0,
      parsed_documents_count: parsed.documents?.length || 0,
    };

    await ddb.send(
      new PutCommand({
        TableName: PROJECT_SUMMARY_TABLE,
        Item: summaryItem,
      })
    );

    pushStep("write_summary", "Write project summary", "done");

    // Mark session finalised
    pushStep("finalise_session", "Mark intake session finalised", "running");

    await ddb.send(
      new UpdateCommand({
        TableName: INTAKE_TABLE,
        Key: { session_id: sessionId },
        UpdateExpression:
          "SET finalised = :t, project_id = :pid, finalised_at = :ts",
        ExpressionAttributeValues: {
          ":t": true,
          ":pid": projectId,
          ":ts": nowIso(),
        },
      })
    );

    pushStep("finalise_session", "Mark intake session finalised", "done");

    return httpResponse(200, {
      ok: true,
      route: "finalise-intake",
      sessionId,
      projectId,
      progress,
    });
  } catch (err) {
    console.error("Finalise error:", err);
    return httpResponse(500, {
      ok: false,
      error: "FINALISE_FAILED",
      message: err?.message || "Unknown error",
      progress,
    });
  }
};
