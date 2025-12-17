const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");

// Fixed region (where your stuff lives)
const region = "ap-southeast-2";
const invitationsTable =
  process.env.USER_INVITATIONS_TABLE || "user_invitations";

const ddb = new DynamoDBClient({ region });
const doc = DynamoDBDocumentClient.from(ddb, {
  marshallOptions: { removeUndefinedValues: true },
});

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  console.log("invite-user event:", JSON.stringify(event));

  // 1. Parse body
  let body = {};
  try {
    if (event.body) {
      body = JSON.parse(event.body);
    }
  } catch (err) {
    console.error("Invalid JSON body:", err);
    return json(400, { message: "Invalid JSON body" });
  }

  const {
    email,
    full_name,
    role,
    discipline,
    company_id,
    company_name,
  } = body || {};

  // 2. Basic validation
  if (!email || !full_name) {
    return json(400, {
      message: "email and full_name are required",
    });
  }

  const allowedRoles = [
    "viewer",
    "contributor",
    "controller",
    "super_admin",
  ];
  if (role && !allowedRoles.includes(role)) {
    return json(400, {
      message: `Invalid role. Allowed: ${allowedRoles.join(", ")}`,
    });
  }

  // 3. Build invitation record
  const invite_id = randomUUID();
  const invitation_token = randomUUID();

  const now = new Date();
  const invited_at = now.toISOString();
  const expires_at = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const claims = event.requestContext?.authorizer?.jwt?.claims || {};
  const invited_by_user_id = claims.sub || null;

  const item = {
    invite_id,
    email,
    full_name,
    role: role || "viewer",
    discipline: discipline || null,
    company_id: company_id || null,
    company_name: company_name || null,
    status: "pending",
    invitation_token,
    invited_by_user_id,
    invited_at,
    expires_at,
  };

  console.log("Putting invitation item:", item);

  try {
    await doc.send(
      new PutCommand({
        TableName: invitationsTable,
        Item: item,
        ConditionExpression:
          "attribute_not_exists(invite_id) AND attribute_not_exists(invitation_token)",
      })
    );

    // TODO: later -> send email using SES or another Lambda
    console.log("TODO send invite email to", email, "with token", invitation_token);

    return json(201, {
      message: "Invitation created",
      invite_id,
      invitation_token,
      email,
      full_name,
      role: item.role,
      company_name: item.company_name,
    });
  } catch (err) {
    console.error("Failed to create invitation:", err);
    return json(500, { message: "Failed to create invitation" });
  }
};
