import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";

const dynamo = new DynamoDBClient({ region: "ap-southeast-2" });
const COMPANIES_TABLE = "companies";

export const handler = async (event) => {
  console.log("list-companies event:", JSON.stringify(event));

  try {
    const queryParam = event?.queryStringParameters?.q || "";
    const query = queryParam.trim();

    const params = {
      TableName: COMPANIES_TABLE,
      Limit: 100, // safety cap
    };

    if (query) {
      const normalized = query.toLowerCase().replace(/\s+/g, " ");
      params.FilterExpression = "contains(#nn, :q)";
      params.ExpressionAttributeNames = {
        "#nn": "name_normalized",
      };
      params.ExpressionAttributeValues = {
        ":q": { S: normalized },
      };
    }

    const result = await dynamo.send(new ScanCommand(params));

    const companies = (result.Items || []).map((item) => ({
      company_id: item.company_id?.S || "",
      company_name: item.company_name?.S || "",
    }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companies }),
    };
  } catch (error) {
    console.error("Error in list-companies:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Internal server error" }),
    };
  }
};
