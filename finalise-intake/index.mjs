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
const uuid = () => crypto.randomUUID();

function httpResponse(statusCode: number, body: any) {
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

function safeJsonParse(v: any, fallback: any = null) {
  if (!v) return fallback;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------- AUTH ----------------
function getUserIdFromEvent(event: any) {
  const claims =
    event?.requestContext?.authorizer?.jwt?.claims ||
    event?.requestContext?.authorizer?.claims ||
    null;
  return claims?.sub || null;
}

// ---------------- COUNCIL LOOKUP LINKS ----------------
function extractCouncilLinks(session: any) {
  const lookup = safeJsonParse(session.council_lookup, null);
  if (!lookup) return null;

  const raw =
    lookup.projectMetadata?.raw ||
    lookup.projectMetadata ||
    lookup.raw ||
    {};

  const links = raw.links || lookup.links || {};

  return {
    application_page_url: links.application_page_url || raw.application_page_url || null,
    documents_page_url: links.documents_page_url || raw.documents_page_url || null,
    base_url: links.base_url || raw.base_url || null,
  };
}

// ---------------- OPTIONAL S3 COPY HELPERS ----------------
function isIntakeKey(key: any) {
  if (!key || typeof key !== "string") return false;
  return key.startsWith("intake/") || key.includes("/intake/");
}

function basenameFromKey(key: string) {
  try {
    return path.posix.basename(key);
  } catch {
    const parts = String(key).split("/");
    return parts[parts.length - 1] || "file";
  }
}

async function headExists(key: string) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: FILES_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

function addTimestampBeforeExt(filename: string) {
  const ext = path.extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  return `${base}_${Date.now()}${ext}`;
}

async function ensureUniqueDestKey(destKey: string) {
  if (!(await headExists(destKey))) return destKey;
  const dir = path.posix.dirname(destKey);
  const file = path.posix.basename(destKey);
  const bumped = addTimestampBeforeExt(file);
  return `${dir}/${bumped}`;
}

async function copyS3Object(sourceKey: string, destKey: string) {
  const finalDestKey = await ensureUniqueDestKey(destKey);

  await s3.send(
    new CopyObjectCommand({
      Bucket: FILES_BUCKET,
      CopySource: `${FILES_BUCKET}/${sourceKey}`,
      Key: finalDestKey,
    })
  );

  // verify destination exists
  await s3.send(new HeadObjectCommand({ Bucket: FILES_BUCKET, Key: finalDestKey }));
  return finalDestKey;
}

// ---------------- BATCH WRITE (WITH RETRIES) ----------------
async function batchWriteAll(tableName: string, items: any[]) {
  for (const part of chunk(items, 25)) {
    let requestItems = {
      [tableName]: part.map((Item) => ({ PutRequest: { Item } })),
    } as any;

    // retry unprocessed items
    for (let attempt = 0; attempt < 8; attempt++) {
      const resp = await ddb.send(new BatchWriteCommand({ RequestItems: requestItems }));
      const unprocessed = resp.UnprocessedItems?.[tableName];

      if (!unprocessed || unprocessed.length === 0) break;

      // exponential-ish backoff
      await new Promise((r) => setTimeout(r, 80 * Math.pow(2, attempt)));

      requestItems = { [tableName]: unprocessed } as any;

      if (attempt === 7) {
        throw new Error(`BatchWrite exceeded retries for ${tableName} (unprocessed=${unprocessed.length})`);
      }
    }
  }
}

// ---------------- CONDITIONS FLATTEN ----------------
function flattenConditions(parsed: any) {
  const sections = parsed?.conditions?.sections || [];
  const rows: any[] = [];

  for (const sec of sections) {
    const sectionTitle = sec?.title || "General";
    for (const c of sec?.conditions || []) {
      rows.push({
        number: c.number,
        parentNumber: null,
        sectionTitle,
        title: c.title || "",
        description: c.description || "",
        timing: c.timing || "",
        timingSource: c.timingSource || "",
        timingColumn: c.timingColumn || "",
        timingInline: c.timingInline || "",
        material: c.material ?? null,
      });

      for (const k of c.children || []) {
        rows.push({
          number: k.number,
          parentNumber: c.number,
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

// ---------------- DOCUMENT NORMALISATION (BACKEND CONTRACT) ----------------
// IMPORTANT: This backend only produces the DB schema.
// UI should NOT need a “normalizer” anymore.

type DocRow = {
  document_id: string;
  project_id: string;
  created_at: string;
  updated_at: string;
  source: "council" | "parser" | "user_upload";
  council_code: string | null;
  external_id: string | null;
  title: string;
  category: string;
  doc_date: string | null;
  file_extension: string | null;
  s3_bucket: string | null;
  s3_key: string | null;
  download_url: string | null;
  raw: any;
};

function dedupeKey(d: Partial<DocRow>) {
  return [
    d.source || "",
    d.external_id || "",
    d.s3_key || "",
    d.download_url || "",
    d.title || "",
    d.category || "",
  ].join("|");
}

function safeStr(v: any) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function inferExtFromName(name: string) {
  const ext = path.extname(name || "").replace(".", "").toLowerCase();
  return ext || null;
}

// council_lookup documents: you already have rows like:
// { documentId, fileName, category, fileDate, fileextension, downloadUrl, fileSize }
function buildCouncilDocRows(args: {
  projectId: string;
  councilCode: string | null;
  items: any[];
}): DocRow[] {
  const { projectId, councilCode, items } = args;
  const now = nowIso();

  return (items || [])
    .filter(Boolean)
    .map((d) => {
      const title = safeStr(d.fileName || d.title).trim();
      const category = safeStr(d.category || "Council Document").trim();

      const externalId = safeStr(d.documentId || d.externalId || "").trim() || null;
      const downloadUrl = safeStr(d.downloadUrl || d.download_url || "").trim() || null;

      const ext =
        safeStr(d.fileextension || d.fileExtension || "").trim().toLowerCase() ||
        inferExtFromName(title);

      return {
        document_id: uuid(),
        project_id: projectId,
        created_at: now,
        updated_at: now,
        source: "council",
        council_code: councilCode,
        external_id: externalId,
        title: title || "(untitled)",
        category,
        doc_date: safeStr(d.fileDate || d.docDate || "").trim() || null,
        file_extension: ext,
        s3_bucket: null,
        s3_key: null,
        download_url: downloadUrl,
        raw: d,
      };
    })
    .filter((r) => !!r.title);
}

// parser/reference documents: come from parsedConditions.referenceDocuments OR parsed.documents
// these often have: { number, title, planDate, revision, preparedBy }
function buildParserDocRows(args: {
  projectId: string;
  councilCode: string | null;
  items: any[];
}): DocRow[] {
  const { projectId, councilCode, items } = args;
  const now = nowIso();

  return (items || [])
    .filter(Boolean)
    .map((d) => {
      const title = safeStr(d.title || d.fileName || "").trim();
      const category = safeStr(d.category || "Documents Referenced in Conditions").trim();

      // IMPORTANT: for parser docs, external_id should be the plan/document “number”
      const externalId = safeStr(d.number || d.externalId || d.documentId || "").trim() || null;

      const docDate = safeStr(d.planDate || d.fileDate || d.docDate || "").trim() || null;

      // usually no download url and no s3
      return {
        document_id: uuid(),
        project_id: projectId,
        created_at: now,
        updated_at: now,
        source: "parser",
        council_code: councilCode,
        external_id: externalId,
        title: title || "(untitled referenced doc)",
        category,
        doc_date: docDate,
        file_extension: safeStr(d.fileextension || d.fileExtension || "").trim().toLowerCase() || null,
        s3_bucket: null,
        s3_key: null,
        download_url: null,
        raw: d,
      };
    })
    .filter((r) => !!r.title);
}

// user uploads: MUST be copied to:
// projects/{project_id}/documents/{document_id}/{filename}
async function buildUserUploadDocRows(args: {
  projectId: string;
  councilCode: string | null;
  intakeUploads: any[];
}): Promise<DocRow[]> {
  const { projectId, councilCode, intakeUploads } = args;
  const now = nowIso();

  const rows: DocRow[] = [];

  for (const u of Array.isArray(intakeUploads) ? intakeUploads : []) {
    if (!u) continue;

    // Try all likely keys
    const intakeKey =
      u.s3Key ||
      u.s3_key ||
      u.key ||
      u.fileKey ||
      u.file_key ||
      null;

    const title = safeStr(u.title || u.fileName || u.name || "").trim();
    const category = safeStr(u.category || "User Upload").trim();

    // If it’s not an intake S3 key, skip copying (but you could still store as external)
    if (!isIntakeKey(intakeKey)) {
      continue;
    }

    const documentId = uuid();
    const filename = basenameFromKey(intakeKey);
    const destKey = `projects/${projectId}/documents/${documentId}/${filename}`;
    const copiedKey = await copyS3Object(intakeKey, destKey);

    rows.push({
      document_id: documentId,
      project_id: projectId,
      created_at: now,
      updated_at: now,
      source: "user_upload",
      council_code: councilCode,
      external_id: null,
      title: title || filename,
      category,
      doc_date: safeStr(u.docDate || u.date || "").trim() || null,
      file_extension: safeStr(u.fileExtension || u.ext || "").trim().toLowerCase() || inferExtFromName(filename),
      s3_bucket: FILES_BUCKET,
      s3_key: copiedKey,
      download_url: null,
      raw: u,
    });
  }

  return rows;
}

// ---------------- SESSION EXTRACTION ----------------
function extractFromSession(session: any) {
  const step = session.step_data || {};

  const projectObj = safeJsonParse(step.project, {}) || {};
  const councilConditionsObj = safeJsonParse(step.councilConditions, null);

  const baseParsed =
    councilConditionsObj?.parsedConditions ||
    councilConditionsObj?.parsed ||
    session.parsedConditions ||
    null;

  const editedConditions =
    councilConditionsObj?.conditions ||
    (Array.isArray(councilConditionsObj?.sections)
      ? { sections: councilConditionsObj.sections }
      : null);

  let parsed: any = null;
  if (baseParsed) {
    parsed = {
      ...baseParsed,
      conditions: editedConditions || baseParsed.conditions,
    };
  }

  // Overlay edited application details (addressOfSite etc)
  const applicationDetails =
    projectObj?.applicationDetails ||
    projectObj?.projectDetails?.applicationDetails ||
    {};

  if (parsed) {
    parsed.applicationDetails = {
      ...(parsed.applicationDetails || {}),
      ...applicationDetails,
    };
  }

  const projectName =
    projectObj.projectName ||
    projectObj.name ||
    projectObj.project_name ||
    null;

  const yourRef =
    projectObj.yourRef ||
    projectObj.your_ref ||
    projectObj.reference ||
    null;

  // Council lookup docs are typically stored on step_data.lookupDocuments
  // (your screenshot shows lookupDocuments already shaped in UI, but here we read raw)
  const lookupDocuments =
    step.lookupDocuments ||
    step.councilLookup?.projectMetadata?.raw?.documents ||
    session.lookupDocuments ||
    [];

  const councilConditionsFileKey =
    councilConditionsObj?.fileKey ||
    councilConditionsObj?.conditionsFileKey ||
    null;

  // Intake uploads: include explicit uploads plus the conditions fileKey (if you want)
  const intakeUploads: any[] =
    step.uploads ||
    step.uploadedDocuments ||
    step.documents ||
    [];

  // If the councilConditionsFileKey exists, add it as a user_upload automatically
  if (councilConditionsFileKey) {
    intakeUploads.push({
      title: "Conditions Package",
      category: "Conditions",
      s3Key: councilConditionsFileKey,
    });
  }

  // Parser referenced docs can be in:
  // parsed.referenceDocuments OR parsed.referencedDocuments OR parsed.documents
  const parserDocs =
    parsed?.referenceDocuments ||
    parsed?.referencedDocuments ||
    parsed?.documents ||
    [];

  return {
    parsed,
    parserDocs,
    lookupDocuments,
    intakeUploads,
    projectName,
    yourRef,
  };
}

// ================= HANDLER =================
export const handler = async (event: any) => {
  try {
    const httpMethod = event?.requestContext?.http?.method;
    if (httpMethod === "OPTIONS") return httpResponse(200, { ok: true });

    const userId = getUserIdFromEvent(event);
    if (!userId) return httpResponse(401, { ok: false, error: "UNAUTHENTICATED" });

    const body = safeJsonParse(event.body, {});
    const sessionId =
      body.sessionId ||
      event?.requestContext?.http?.path?.split("/")?.[3];

    if (!sessionId) return httpResponse(400, { ok: false, error: "MISSING_SESSION" });

    const sessionResp = await ddb.send(
      new GetCommand({
        TableName: INTAKE_TABLE,
        Key: { session_id: sessionId },
      })
    );

    const session = sessionResp.Item;
    if (!session) return httpResponse(404, { ok: false, error: "SESSION_NOT_FOUND" });

    // Idempotency
    if (session.finalised === true && session.project_id) {
      return httpResponse(200, {
        ok: true,
        projectId: session.project_id,
        alreadyFinalised: true,
      });
    }

    const { parsed, parserDocs, lookupDocuments, intakeUploads, projectName, yourRef } =
      extractFromSession(session);

    if (!parsed) {
      return httpResponse(400, {
        ok: false,
        error: "MISSING_PARSED_CONDITIONS",
        message:
          "No parsed conditions payload found in session (expected step_data.councilConditions.parsedConditions).",
      });
    }

    const councilLinks = extractCouncilLinks(session);
    const projectId = uuid();

    const councilCode =
      parsed.council ||
      session.councilCode ||
      session.council_code ||
      null;

    const app = parsed.applicationDetails || {};
    const summary = parsed.summary || {};

    // ---------------- PROJECT ----------------
    const projectItem: any = {
      project_id: projectId,
      created_at: nowIso(),
      updated_at: nowIso(),
      source: "intake",
      intake_session_id: sessionId,
      council_code: councilCode,
      da_number: app.councilFileReference || session.daNumber || session.da_number || null,
      address: app.addressOfSite || "",
      project_name: projectName,
      your_ref: yourRef,
      council_links: councilLinks,
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

    // ---------------- MEMBERSHIP ----------------
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

    // ---------------- CONDITIONS ----------------
    const flat = flattenConditions(parsed);

    await batchWriteAll(
      CONDITIONS_TABLE,
      flat.map((c) => ({
        condition_id: uuid(),
        project_id: projectId,
        created_at: nowIso(),
        updated_at: nowIso(),
        source: "intake",
        council_code: councilCode,

        condition_number: safeStr(c.number).trim(),
        parent_number: c.parentNumber ?? null,

        section_title: c.sectionTitle,
        title: c.title,
        description: c.description,
        timing: c.timing,
        timing_source: c.timingSource,
        timing_column: c.timingColumn,
        timing_inline: c.timingInline,
        material: c.material,
        status: "new",
      }))
    );

    // ---------------- DOCUMENTS ----------------
    // 1) council lookup docs (external)
    const councilRows = buildCouncilDocRows({
      projectId,
      councilCode,
      items: lookupDocuments,
    });

    // 2) parser reference docs (no URL, no S3)
    const parserRows = buildParserDocRows({
      projectId,
      councilCode,
      items: parserDocs,
    });

    // 3) user uploads copied from intake -> project
    const uploadRows = await buildUserUploadDocRows({
      projectId,
      councilCode,
      intakeUploads,
    });

    // dedupe before writing
    const all = [...councilRows, ...parserRows, ...uploadRows];
    const seen = new Set<string>();
    const docsToWrite = all.filter((d) => {
      const k = dedupeKey(d);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    if (docsToWrite.length > 0) {
      await batchWriteAll(DOCUMENTS_TABLE, docsToWrite);
    }

    // ---------------- SUMMARY ----------------
    const conditionsCount =
      typeof summary.numberOfConditions === "number"
        ? summary.numberOfConditions
        : flat.length;

    await ddb.send(
      new PutCommand({
        TableName: PROJECT_SUMMARY_TABLE,
        Item: {
          project_id: projectId,
          created_at: nowIso(),
          updated_at: nowIso(),
          council_code: councilCode,
          da_number: projectItem.da_number,
          address: projectItem.address,
          project_name: projectName,
          your_ref: yourRef,
          council_links: councilLinks,

          conditions_count: conditionsCount,
          documents_count: docsToWrite.length,

          council_documents_count: councilRows.length,
          parsed_documents_count: parserRows.length,
          user_documents_count: uploadRows.length,

          has_council_links: !!councilLinks,
        },
      })
    );

    // ---------------- FINALISE SESSION ----------------
    await ddb.send(
      new UpdateCommand({
        TableName: INTAKE_TABLE,
        Key: { session_id: sessionId },
        UpdateExpression: "SET finalised = :t, project_id = :pid, finalised_at = :ts",
        ExpressionAttributeValues: {
          ":t": true,
          ":pid": projectId,
          ":ts": nowIso(),
        },
      })
    );

    return httpResponse(200, {
      ok: true,
      projectId,
      counts: {
        conditions: flat.length,
        documents: docsToWrite.length,
        council: councilRows.length,
        parser: parserRows.length,
        user_upload: uploadRows.length,
      },
    });
  } catch (err: any) {
    console.error("FINALISE_FAILED", err);
    return httpResponse(500, {
      ok: false,
      error: "FINALISE_FAILED",
      message: err?.message || "Unknown error",
    });
  }
};
