import {
  DynamoDBClient,
  QueryCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { randomUUID } from "crypto";

const dynamo = new DynamoDBClient({ region: "ap-southeast-2" });

const COMPANIES_TABLE = "companies";
const NAME_INDEX = "name_normalized-index";

export const handler = async (event) => {
  console.log("Event:", JSON.stringify(event));

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const rawName = (body.company_name || "").trim();

    if (!rawName) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "company_name is required" }),
      };
    }

    const normalized = rawName.toLowerCase().replace(/\s+/g, " ");

    console.log("Looking up company:", { rawName, normalized });

    // 1) Try find existing company by normalized name (GSI)
    const query = new QueryCommand({
      TableName: COMPANIES_TABLE,
      IndexName: NAME_INDEX,
      KeyConditionExpression: "#nn = :nn",
      ExpressionAttributeNames: {
        "#nn": "name_normalized",
      },
      ExpressionAttributeValues: {
        ":nn": { S: normalized },
      },
      Limit: 1,
    });

    const result = await dynamo.send(query);
    console.log("Query result:", JSON.stringify(result));

    if (result.Count && result.Items && result.Items.length > 0) {
      const item = result.Items[0];

      const company = {
        company_id: item.company_id.S,
        company_name: item.company_name.S,
      };

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          created: false,
          company,
        }),
      };
    }

    // 2) No existing company -> create a new one
    const newId = `comp_${randomUUID()}`;
    const now = new Date().toISOString();

    const put = new PutItemCommand({
      TableName: COMPANIES_TABLE,
      Item: {
        company_id: { S: newId },
        company_name: { S: rawName },
        name_normalized: { S: normalized },
        created_at: { S: now },
        updated_at: { S: now },
      },
      ConditionExpression: "attribute_not_exists(company_id)",
    });

    await dynamo.send(put);

    const company = {
      company_id: newId,
      company_name: rawName,
    };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        created: true,
        company,
      }),
    };
  } catch (err) {
    console.error("Error in company-search-or-create:", err);

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Internal server error" }),
    };
  }
};
