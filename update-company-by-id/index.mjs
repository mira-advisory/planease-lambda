// index.mjs (handler: index.handler)

import {
  DynamoDBClient,
  UpdateItemCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";

const REGION = "ap-southeast-2";
const COMPANIES_TABLE = "companies";

const dynamo = new DynamoDBClient({ region: REGION });

const headers = {
  "Content-Type": "application/json",
};

export const handler = async (event) => {
  console.log("update-company-by-id event:", JSON.stringify(event));

  try {
    const companyId = event?.pathParameters?.companyId;
    if (!companyId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: "companyId path parameter is required" }),
      };
    }

    const body = event.body ? JSON.parse(event.body) : {};
    const now = new Date().toISOString();

    // Whitelist the fields we allow updating
    const allowedFields = [
      "company_name",
      "abn",
      "primary_contact_name",
      "primary_contact_email",
      "primary_contact_phone",
      "street_address",
      "suburb",
      "state",
      "postcode",
      "company_type",
    ];

    const updates = Object.entries(body).filter(
      ([key, value]) => allowedFields.includes(key) && value !== undefined
    );

    if (updates.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ message: "No updatable fields provided" }),
      };
    }

    // Build UpdateExpression
    let updateExpr = "SET updated_at = :updated_at";
    const exprAttrValues = {
      ":updated_at": { S: now },
    };
    const exprAttrNames = {};

    updates.forEach(([key, value], index) => {
      const nameKey = `#f${index}`;
      const valueKey = `:v${index}`;

      exprAttrNames[nameKey] = key;
      exprAttrValues[valueKey] = { S: String(value) };
      updateExpr += `, ${nameKey} = ${valueKey}`;
    });

    const updateCmd = new UpdateItemCommand({
      TableName: COMPANIES_TABLE,
      Key: {
        company_id: { S: companyId },
      },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: exprAttrNames,
      ExpressionAttributeValues: exprAttrValues,
      ReturnValues: "NONE",
    });

    await dynamo.send(updateCmd);

    // Re-read the full company record
    const getCmd = new GetItemCommand({
      TableName: COMPANIES_TABLE,
      Key: {
        company_id: { S: companyId },
      },
    });

    const getRes = await dynamo.send(getCmd);
    if (!getRes.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ message: "Company not found after update" }),
      };
    }

    const item = getRes.Item;
    const company = {
      company_id: item.company_id.S,
      company_name: item.company_name?.S,
      abn: item.abn?.S,
      primary_contact_name: item.primary_contact_name?.S,
      primary_contact_email: item.primary_contact_email?.S,
      primary_contact_phone: item.primary_contact_phone?.S,
      street_address: item.street_address?.S,
      suburb: item.suburb?.S,
      state: item.state?.S,
      postcode: item.postcode?.S,
      company_type: item.company_type?.S,
      created_at: item.created_at?.S,
      updated_at: item.updated_at?.S,
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ company }),
    };
  } catch (err) {
    console.error("Error in update-company-by-id:", err);

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: "Internal server error" }),
    };
  }
};
