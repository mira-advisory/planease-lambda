import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";

import {
  DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";

// Clients
const cognito = new CognitoIdentityProviderClient({ region: "ap-southeast-2" });
const dynamo = new DynamoDBClient({ region: "ap-southeast-2" });

export const handler = async (event) => {
  const userPoolId = event.userPoolId;
  const username = event.userName;

  console.log("Post confirmation trigger for:", username);
  console.log("Event triggerSource:", event.triggerSource);

  // 1) Add user to viewer group
  const addToGroupParams = {
    UserPoolId: userPoolId,
    Username: username,
    GroupName: "viewer",
  };

  try {
    await cognito.send(new AdminAddUserToGroupCommand(addToGroupParams));
    console.log(`User ${username} added to viewer group`);
  } catch (err) {
    console.error("Error adding user to viewer group:", err);
  }

  // 2) Create default user profile in DynamoDB
  try {
    const userId = event.request?.userAttributes?.sub;
    const email = event.request?.userAttributes?.email;

    if (!userId) {
      console.error("No userAttributes.sub found on event, skipping profile creation");
    } else {
      const now = new Date().toISOString();

      const item = {
        user_id: { S: userId },
        email: email ? { S: email } : { S: "" },
        role: { S: "viewer" },
        created_at: { S: now },
        updated_at: { S: now },
        // Add more defaults later if you want:
        // first_name: { S: "" },
        // last_name: { S: "" },
        // company: { S: "" },
      };

      await dynamo.send(
        new PutItemCommand({
          TableName: "user_profiles",
          Item: item,
          ConditionExpression: "attribute_not_exists(user_id)", // avoid overwriting if it somehow exists
        })
      );

      console.log(`User profile created for user_id=${userId}`);
    }
  } catch (err) {
    console.error("Error creating user profile in DynamoDB:", err);
  }

  // Always return event for Cognito triggers
  return event;
};
