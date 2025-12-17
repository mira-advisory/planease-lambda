import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({ region: "ap-southeast-2" });
const USER_TABLE = "user_profiles";

export const handler = async (event) => {
  console.log("GET /me event:", JSON.stringify(event));

  try {
    // 1) Get user id from Cognito JWT (sub claim)
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    const userId = claims?.sub;

    if (!userId) {
      console.error("No sub claim found in JWT claims:", claims);
      return {
        statusCode: 401,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Unauthorized" }),
      };
    }

    // 2) Fetch from DynamoDB
    const resp = await ddb.send(
      new GetItemCommand({
        TableName: USER_TABLE,
        Key: { user_id: { S: userId } },
      })
    );

    if (!resp.Item) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Profile not found" }),
      };
    }

    // 3) Flatten DynamoDB item into plain JSON
    const item = resp.Item;
    const getS = (k) => (item[k] && item[k].S) || "";

    const profile = {
      id: getS("user_id"),
      email: getS("email"),
      full_name: getS("full_name"),
      first_name: getS("first_name"),
      last_name: getS("last_name"),
      discipline: getS("discipline"),
      job_title: getS("job_title"),
      phone_number: getS("phone_number"),
      location: getS("location"),
      company_id: getS("company_id"),
      company_name: getS("company_name"),
      bio: getS("bio"),
      role: getS("role"),
      timezone: getS("timezone"),
      created_at: getS("created_at"),
      updated_at: getS("updated_at"),
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    };
  } catch (err) {
    console.error("Error in get-user-profile:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Internal server error" }),
    };
  }
};
