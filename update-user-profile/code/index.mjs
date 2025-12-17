import {
  DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const dynamo = new DynamoDBClient({ region: "ap-southeast-2" });
const USER_TABLE = "user_profiles";

// Fields users are allowed to update from the Profile screen
const ALLOWED_FIELDS = [
  "email",
  "full_name",
  "discipline",
  "job_title",
  "phone_number",
  "location",
  "bio",
  "timezone",
  "company_id",
  "company_name",
];

export const handler = async (event) => {
  console.log("update-user-profile event:", JSON.stringify(event));

  try {
    // 1) Get user_id (Cognito sub) from JWT claims
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    const userId = claims?.sub;

    if (!userId) {
      console.error("No sub claim found in JWT");
      return {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Unauthorized" }),
      };
    }

    // 2) Parse request body
    if (!event.body) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Request body is required" }),
      };
    }

    let body;
    try {
      body = JSON.parse(event.body);
    } catch (err) {
      console.error("Invalid JSON body:", err);
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Invalid JSON body" }),
      };
    }

    // 3) Filter to allowed fields
    const updates = {};
    for (const [key, value] of Object.entries(body)) {
      if (ALLOWED_FIELDS.includes(key) && value !== undefined && value !== null) {
        updates[key] = value;
      }
    }

    if (Object.keys(updates).length === 0) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "No valid fields to update" }),
      };
    }

    // 4) Build DynamoDB UpdateExpression
    const expressionParts = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};

    for (const [key, value] of Object.entries(updates)) {
      const nameKey = `#${key}`;
      const valueKey = `:${key}`;

      expressionParts.push(`${nameKey} = ${valueKey}`);
      expressionAttributeNames[nameKey] = key;
      expressionAttributeValues[valueKey] = { S: String(value) };
    }

    // Always bump updated_at
    const now = new Date().toISOString();
    expressionParts.push("#updated_at = :updated_at");
    expressionAttributeNames["#updated_at"] = "updated_at";
    expressionAttributeValues[":updated_at"] = { S: now };

    const params = {
      TableName: USER_TABLE,
      Key: {
        user_id: { S: userId },
      },
      UpdateExpression: "SET " + expressionParts.join(", "),
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    };

    console.log("UpdateItem params:", JSON.stringify(params));

    const result = await dynamo.send(new UpdateItemCommand(params));

    // 5) Convert result.Attributes into a simple JSON object
    const updatedProfile = {};
    for (const [key, value] of Object.entries(result.Attributes || {})) {
      if ("S" in value) updatedProfile[key] = value.S;
      else if ("N" in value) updatedProfile[key] = Number(value.N);
      else if ("BOOL" in value) updatedProfile[key] = value.BOOL;
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updatedProfile),
    };
  } catch (err) {
    console.error("Unhandled error in update-user-profile:", err);

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Internal server error" }),
    };
  }
};
