const AWS = require("aws-sdk");
const { randomUUID } = require("crypto");

const CONDITIONS_TABLE = process.env.CONDITIONS_TABLE || "";
const PROJECT_FILES_BUCKET = process.env.PROJECT_FILES_BUCKET || "";

const ddb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();

exports.handler = async (event) => {
  try {
    if (!CONDITIONS_TABLE) {
      console.error("CONDITIONS_TABLE env var is not set");
      return {
        statusCode: 500,
        body: JSON.stringify({
          message: "Failed to create condition",
          error: "CONDITIONS_TABLE env var is not configured"
        })
      };
    }

    if (!event.body) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: "Missing request body" })
      };
    }

    const body = JSON.parse(event.body);

    // ---- Required fields ----
    const required = ["project_id", "condition_text"];
    const missing = required.filter((f) => !body[f]);
    if (missing.length > 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "Missing required fields",
          missing
        })
      };
    }

    // ---- User from JWT (same pattern as create-project) ----
    const auth = (event.requestContext && event.requestContext.authorizer) || {};
    const jwt = auth.jwt || {};
    const claims = jwt.claims || auth.claims || {};

    const userId =
      claims["custom:user_id"] || claims["sub"] || claims["username"];

    if (!userId) {
      console.error("No user id found in JWT claims", claims);
      return {
        statusCode: 401,
        body: JSON.stringify({ message: "Unauthenticated" })
      };
    }

    const now = new Date().toISOString();
    const condition_id = randomUUID();
    const project_id = body.project_id;

    // ================================
    // S3: optional files upload
    // ================================
    let attachments = [];

    if (Array.isArray(body.files) && body.files.length > 0 && PROJECT_FILES_BUCKET) {
      for (let i = 0; i < body.files.length; i++) {
        const f = body.files[i];
        if (!f || !f.content) {
          console.warn("Skipping empty file entry at index", i);
          continue;
        }

        const fileName = f.file_name || `file-${i + 1}`;
        const mimeType = f.mime_type || "application/octet-stream";

        const key = `projects/${project_id}/conditions/${condition_id}/${fileName}`;

        try {
          // assume base64 string
          const buffer = Buffer.from(f.content, "base64");

          await s3
            .putObject({
              Bucket: PROJECT_FILES_BUCKET,
              Key: key,
              Body: buffer,
              ContentType: mimeType
            })
            .promise();

          attachments.push({
            s3_key: key,
            file_name: fileName,
            mime_type: mimeType
          });
        } catch (err) {
          console.error("Failed to upload condition file", { index: i, fileName }, err);
          // keep going with other files
        }
      }
    }

    // ================================
    // DDB: create condition item
    // ================================
    const conditionItem = {
      condition_id,
      project_id,
      condition_ref: body.condition_ref || null,
      condition_title: body.condition_title || null,
      condition_text: body.condition_text,
      category: body.category || null,
      status: body.status || "pending",
      sort_order: body.sort_order || 0,
      due_date: body.due_date || null,
      completed_at: body.completed_at || null,
      assigned_to_user_id: body.assigned_to_user_id || null,
      assigned_to_company_id: body.assigned_to_company_id || null,
      attachments: attachments,             // <-- stored S3 file metadata
      created_at: now,
      updated_at: now,
      created_by_user_id: userId,
      updated_by_user_id: userId
    };

    await ddb
      .put({
        TableName: CONDITIONS_TABLE,
        Item: conditionItem
      })
      .promise();

    return {
      statusCode: 201,
      body: JSON.stringify(conditionItem)
    };
  } catch (err) {
    console.error("ERROR CREATING CONDITION:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Failed to create condition",
        error: err && err.message ? err.message : "Unknown"
      })
    };
  }
};
