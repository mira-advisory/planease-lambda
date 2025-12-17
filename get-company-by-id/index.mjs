// index.mjs for get-company-by-id

import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

const REGION = process.env.AWS_REGION ?? "ap-southeast-2";
const COMPANIES_TABLE = process.env.COMPANIES_TABLE ?? "companies";

const dynamo = new DynamoDBClient({ region: REGION });

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://app.planease.net",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

const getStr = (attr) => {
  if (!attr || !attr.S) return null;
  // Convert literal "null" strings to real null
  return attr.S === "null" ? null : attr.S;
};

export const handler = async (event) => {
  console.log("get-company-by-id event:", JSON.stringify(event));

  // Handle CORS preflight
  if (event.requestContext?.http?.method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: "",
    };
  }

  const companyId =
    event.pathParameters?.companyId ||
    event.pathParameters?.company_id ||
    null;

  if (!companyId) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "companyId path parameter is required",
      }),
    };
  }

  try {
    const cmd = new GetItemCommand({
      TableName: COMPANIES_TABLE,
      Key: {
        company_id: { S: companyId },
      },
      // No ProjectionExpression: fetch all attributes
    });

    const result = await dynamo.send(cmd);
    console.log("get-company-by-id result:", JSON.stringify(result));

    if (!result.Item) {
      return {
        statusCode: 404,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Company not found" }),
      };
    }

    const item = result.Item;

    const company = {
      company_id: getStr(item.company_id),
      company_name: getStr(item.company_name),
      name_normalized: getStr(item.name_normalized),

      abn: getStr(item.abn),
      primary_contact_name: getStr(item.primary_contact_name),
      primary_contact_email: getStr(item.primary_contact_email),
      primary_contact_phone: getStr(item.primary_contact_phone),

      street_address: getStr(item.street_address) || getStr(item.street),
      suburb: getStr(item.suburb),
      state: getStr(item.state),
      postcode: getStr(item.postcode),

      company_type: getStr(item.company_type),
      owner_user_id: getStr(item.owner_user_id),

      created_at: getStr(item.created_at),
      updated_at: getStr(item.updated_at),
    };

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ company }),
    };
  } catch (err) {
    console.error("Error in get-company-by-id:", err);

    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Internal server error",
      }),
    };
  }
};
