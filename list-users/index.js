const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const region = process.env.AWS_REGION || "ap-southeast-2";
const userProfilesTable = process.env.USER_PROFILES_TABLE || "user_profiles";

const ddb = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(ddb, {
  marshallOptions: { removeUndefinedValues: true },
});

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const query = qs.q ? qs.q.toLowerCase() : null;
  const roleFilter = qs.role || null;
  const statusFilter = qs.status || null;

  try {
    const scanResult = await docClient.send(
      new ScanCommand({
        TableName: userProfilesTable,
      })
    );

    const items = scanResult.Items || [];

    const filteredUsers = items.filter((item) => {
      const matchesRole = roleFilter ? item.role === roleFilter : true;
      const matchesStatus = statusFilter ? item.status === statusFilter : true;

      if (!query) return matchesRole && matchesStatus;

      const searchableFields = [
        item.full_name,
        item.email,
        item.company_name,
      ]
        .filter(Boolean)
        .map(String);

      const matchesQuery = searchableFields.some((value) =>
        value.toLowerCase().includes(query)
      );

      return matchesRole && matchesStatus && matchesQuery;
    });

    const users = filteredUsers.map((item) => ({
      user_id: item.user_id ?? item.id ?? null,
      email: item.email ?? null,
      full_name: item.full_name ?? null,
      role: item.role ?? null,
      status: item.status ?? null,
      company_id: item.company_id ?? null,
      company_name: item.company_name ?? null,
      created_at: item.created_at ?? null,
      updated_at: item.updated_at ?? null,
    }));

    return jsonResponse(200, { users });
  } catch (err) {
    console.error("[list-users] Failed to list users", err);
    return jsonResponse(500, { message: "Failed to list users" });
  }
};
