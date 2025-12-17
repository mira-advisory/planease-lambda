import {
  DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";

const dynamo = new DynamoDBClient({ region: "ap-southeast-2" });
const USER_TABLE = "user_profiles";

export const handler = async (event) => {
  console.log("Event:", JSON.stringify(event));

  try {
    // JWT claims from API Gateway HTTP API (JWT authorizer)
    const claims = event.requestContext?.authorizer?.jwt?.claims || {};
    const userId = claims.sub;

    if (!userId) {
      console.error("Missing sub in JWT claims");
      return {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Unauthorized" }),
      };
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const companyId = (body.company_id || "").trim();
    const companyName = (body.company_name || "").trim();

    if (!companyId || !companyName) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "company_id and company_name are required" }),
      };
    }

    const now = new Date().toISOString();

    const cmd = new UpdateItemCommand({
      TableName: USER_TABLE,
      Key: {
        user_id: { S: userId },
      },
      UpdateExpression: "SET company_id = :cid, company_name = :cname, updated_at = :u",
      ExpressionAttributeValues: {
        ":cid": { S: companyId },
        ":cname": { S: companyName },
        ":u": { S: now },
      },
      ReturnValues: "ALL_NEW",
    });

    const result = await dynamo.send(cmd);
    console.log("Update result:", JSON.stringify(result));

    const attrs = result.Attributes || {};

    const responseProfile = {
      user_id: attrs.user_id?.S,
      email: attrs.email?.S,
      full_name: attrs.full_name?.S,
      role: attrs.role?.S,
      company_id: attrs.company_id?.S,
      company_name: attrs.company_name?.S,
      updated_at: attrs.updated_at?.S,
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Company updated",
        profile: responseProfile,
      }),
    };
  } catch (err) {
    console.error("Error in update-user-company:", err);

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Internal server error" }),
    };
  }
};
