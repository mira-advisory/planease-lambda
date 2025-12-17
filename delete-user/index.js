const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

// Region + table
const region = "ap-southeast-2";
const table = process.env.USER_PROFILES_TABLE || "user_profiles";

const ddb = new DynamoDBClient({ region });
const doc = DynamoDBDocumentClient.from(ddb);

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  console.log("delete-user event:", JSON.stringify(event));

  const userId = event?.pathParameters?.user_id;
  if (!userId) {
    return json(400, { message: "Missing user_id in path" });
  }

  const now = new Date().toISOString();

  try {
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { user_id: userId },
        UpdateExpression:
          "SET #status = :status, updated_at = :updated_at, disabled_at = :disabled_at",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":status": "disabled",
          ":updated_at": now,
          ":disabled_at": now,
        },
      })
    );

    return json(200, {
      message: "User disabled",
      user_id: userId,
      status: "disabled",
    });
  } catch (err) {
    console.error("delete-user error:", err);
    return json(500, { message: "Failed to disable user" });
  }
};
