const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

// Fixed region (Lambda is in ap-southeast-2)
const region = "ap-southeast-2";
const table = process.env.USER_PROFILES_TABLE || "user_profiles";

// DynamoDB client
const ddb = new DynamoDBClient({ region });
const doc = DynamoDBDocumentClient.from(ddb, {
  marshallOptions: { removeUndefinedValues: true },
});

// Helper to format HTTP responses
const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  console.log("update-user event:", JSON.stringify(event));

  // 1. Get user_id from path parameters
  const userId = event?.pathParameters?.user_id;
  if (!userId) {
    return json(400, { message: "Missing user_id in path" });
  }

  // 2. Parse JSON body
  let body = {};
  try {
    if (event.body) {
      body = JSON.parse(event.body);
    }
  } catch (err) {
    console.error("Invalid JSON body:", err);
    return json(400, { message: "Invalid JSON body" });
  }

  // 3. Allowed fields to update
  const ALLOWED_FIELDS = [
    "full_name",
    "role",
    "status",
    "company_id",
    "company_name",
  ];

  const fields = Object.keys(body).filter((key) =>
    ALLOWED_FIELDS.includes(key)
  );

  if (fields.length === 0) {
    return json(400, { message: "No valid fields to update" });
  }

  // 4. Build UpdateExpression dynamically
  let UpdateExpression = "SET updated_at = :updated_at";
  const ExpressionAttributeNames = {};
  const ExpressionAttributeValues = {
    ":updated_at": new Date().toISOString(),
  };

  fields.forEach((field) => {
    UpdateExpression += `, #${field} = :${field}`;
    ExpressionAttributeNames[`#${field}`] = field;
    ExpressionAttributeValues[`:${field}`] = body[field];
  });

  console.log("UpdateExpression:", UpdateExpression);
  console.log("ExpressionAttributeValues:", ExpressionAttributeValues);

  // 5. Execute DynamoDB UpdateItem
  try {
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { user_id: userId },
        UpdateExpression,
        ExpressionAttributeNames,
        ExpressionAttributeValues,
      })
    );

    return json(200, {
      message: "User updated",
      user_id: userId,
      updated_fields: fields,
    });
  } catch (err) {
    console.error("DynamoDB Update failed:", err);
    return json(500, { message: "Failed to update user" });
  }
};
