# Planease Lambda Functions

AWS Lambda functions powering the Planease development application tracking platform. These serverless functions handle user management, project intake workflows, council document lookups, conditions parsing, and project/document APIs.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              API Gateway (HTTP API)                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
          ┌────────────────────────────┼────────────────────────────┐
          │                            │                            │
          ▼                            ▼                            ▼
   ┌──────────────┐           ┌──────────────┐           ┌──────────────┐
   │     User     │           │   Project    │           │   Council    │
   │  Management  │           │    Intake    │           │   Lookup     │
   └──────────────┘           └──────────────┘           └──────────────┘
          │                            │                            │
          ▼                            ▼                            ▼
   ┌──────────────┐           ┌──────────────┐           ┌──────────────┐
   │   DynamoDB   │           │      S3      │           │   External   │
   │   (Tables)   │           │   (Files)    │           │  Council APIs│
   └──────────────┘           └──────────────┘           └──────────────┘
```

## Technology Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 24.x (ESM), Python 3.12 |
| Region | `ap-southeast-2` (Sydney) |
| Database | Amazon DynamoDB |
| Storage | Amazon S3 (`app-planease-files`) |
| Auth | Amazon Cognito |
| Infrastructure | AWS Lambda, API Gateway HTTP API |

---

## Lambda Functions Reference

### Authentication & User Management

#### `cognito-post-confirmation-add-viewer`
**Trigger:** Cognito Post-Confirmation  
**Runtime:** Node.js 24.x (ESM)

Automatically triggered after user signup confirmation. Handles:
- Adds new users to the `viewer` Cognito group
- Creates initial user profile in DynamoDB `user_profiles` table

```javascript
// Creates profile with:
{
  user_id: "<cognito-sub>",
  email: "<user-email>",
  role: "viewer",
  created_at: "<iso-timestamp>",
  updated_at: "<iso-timestamp>"
}
```

---

#### `get-user-profile`
**Endpoint:** `GET /users/me`  
**Runtime:** Node.js 24.x (ESM)  
**Auth:** JWT (Cognito)

Retrieves the authenticated user's profile from DynamoDB.

**Response:**
```json
{
  "id": "user-uuid",
  "email": "user@example.com",
  "full_name": "John Doe",
  "discipline": "Civil Engineering",
  "job_title": "Project Manager",
  "company_id": "comp_xxx",
  "company_name": "Acme Consulting",
  "role": "viewer"
}
```

---

#### `update-user-profile`
**Endpoint:** `PATCH /users/me`  
**Runtime:** Node.js 24.x (ESM)  
**Auth:** JWT (Cognito)

Updates the authenticated user's profile. Allowed fields:
- `email`, `full_name`, `discipline`, `job_title`
- `phone_number`, `location`, `bio`, `timezone`
- `company_id`, `company_name`

---

#### `update-user-company`
**Endpoint:** `PATCH /users/me/company`  
**Runtime:** Node.js 24.x (ESM)  
**Auth:** JWT (Cognito)

Updates the user's company association.

**Request:**
```json
{
  "company_id": "comp_xxx",
  "company_name": "Acme Consulting"
}
```

---

#### `list-users`
**Endpoint:** `GET /admin/users`  
**Runtime:** Node.js 24.x (CommonJS)  
**Auth:** JWT (Cognito, admin role)

Lists all users with optional filtering.

**Query Parameters:**
- `q` - Search query (searches name, email, company)
- `role` - Filter by role (`viewer`, `contributor`, `controller`, `super_admin`)
- `status` - Filter by status

---

#### `update-user`
**Endpoint:** `PATCH /admin/users/{user_id}`  
**Runtime:** Node.js 24.x (CommonJS)  
**Auth:** JWT (Cognito, admin role)

Admin endpoint to update any user's profile.

**Allowed Fields:** `full_name`, `role`, `status`, `company_id`, `company_name`

---

#### `delete-user`
**Endpoint:** `DELETE /admin/users/{user_id}`  
**Runtime:** Node.js 24.x (CommonJS)  
**Auth:** JWT (Cognito, admin role)

Soft-deletes a user by setting `status: "disabled"`.

---

#### `invite-user`
**Endpoint:** `POST /admin/users/invite`  
**Runtime:** Node.js 24.x (CommonJS)  
**Auth:** JWT (Cognito, admin role)

Creates a user invitation with a 7-day expiry.

**Request:**
```json
{
  "email": "newuser@example.com",
  "full_name": "Jane Smith",
  "role": "contributor",
  "discipline": "Architecture",
  "company_id": "comp_xxx",
  "company_name": "Acme Consulting"
}
```

**Tables:** `user_invitations`

---

### Company Management

#### `company-search-or-create`
**Endpoint:** `POST /companies/search-or-create`  
**Runtime:** Node.js 24.x (ESM)

Searches for an existing company by normalised name, or creates a new one if not found.

**Request:**
```json
{
  "company_name": "Acme Consulting Pty Ltd"
}
```

**Response:**
```json
{
  "created": true,
  "company": {
    "company_id": "comp_xxx",
    "company_name": "Acme Consulting Pty Ltd"
  }
}
```

**Tables:** `companies` (with `name_normalized-index` GSI)

---

#### `get-company-by-id`
**Endpoint:** `GET /companies/{companyId}`  
**Runtime:** Node.js 24.x (ESM)

Retrieves full company details including contact information and address.

---

#### `update-company-by-id`
**Endpoint:** `PATCH /companies/{companyId}`  
**Runtime:** Node.js 24.x (ESM)

Updates company details.

**Allowed Fields:**
- `company_name`, `abn`
- `primary_contact_name`, `primary_contact_email`, `primary_contact_phone`
- `street_address`, `suburb`, `state`, `postcode`
- `company_type`

---

#### `list-companies`
**Endpoint:** `GET /companies`  
**Runtime:** Node.js 24.x (ESM)

Lists companies with optional search.

**Query Parameters:**
- `q` - Search query (searches normalised name)

---

### Project Intake Workflow

The intake workflow follows a multi-step wizard pattern:

```
1. Create Session → 2. Project Details → 3. Team → 4. Documents → 5. Council Conditions → 6. Finalise
```

#### `project-intake`
**Endpoints:**
- `POST /intake/session` - Create new intake session
- `PATCH /intake/session/{session_id}/project` - Save project step
- `PATCH /intake/session/{session_id}/team` - Save team step
- `PATCH /intake/session/{session_id}/documents` - Save documents step
- `PATCH /intake/session/{session_id}/council-conditions` - Save conditions step

**Runtime:** Node.js 24.x (ESM)  
**Auth:** JWT (Cognito)

**Create Session Request:**
```json
{
  "councilCode": "BCC",
  "daNumber": "A006738808"
}
```

**Tables:** `project_intake_sessions`

---

#### `generate-intake-upload-url`
**Endpoint:** `POST /intake/session/{session_id}/upload-url`  
**Runtime:** Node.js 24.x (ESM)

Generates presigned S3 URLs for file uploads during intake.

**Request:**
```json
{
  "fileName": "conditions-package.pdf",
  "contentType": "application/pdf",
  "docType": "conditions"
}
```

**Response:**
```json
{
  "ok": true,
  "uploadUrl": "https://s3.amazonaws.com/...",
  "fileKey": "intake/{session_id}/conditions/1234567890_conditions-package.pdf",
  "bucket": "app-planease-files"
}
```

---

#### `finalise-intake`
**Endpoint:** `POST /intake/session/{session_id}/finalise`  
**Runtime:** Node.js 24.x (ESM)  
**Auth:** JWT (Cognito)

Finalises the intake session and creates all project resources:

1. Creates project record in `projects` table
2. Creates project membership for the user (`project_members`)
3. Flattens and stores conditions (`conditions` table)
4. Processes and stores documents:
   - Council lookup documents (external URLs)
   - Parser-extracted reference documents
   - User-uploaded documents (copies from `intake/` to `projects/` in S3)
5. Creates project summary (`project_summaries`)
6. Marks intake session as finalised

**Response:**
```json
{
  "ok": true,
  "projectId": "uuid",
  "counts": {
    "conditions": 45,
    "documents": 23,
    "council": 15,
    "parser": 5,
    "user_upload": 3
  }
}
```

---

### Council Integration

#### `council-lookup`
**Endpoint:** `POST /council/lookup`  
**Runtime:** Python 3.12

Scrapes development application documents from council websites.

**Supported Councils:**
| Code | Council | Source |
|------|---------|--------|
| `BCC` | Brisbane City Council | Development-i portal |
| `LOGAN` | Logan City Council | Council API |
| `REDLANDS` | Redland City Council | Council portal |

**Request:**
```json
{
  "councilCode": "BCC",
  "daNumber": "A006738808",
  "sessionId": "sess_xxx"
}
```

**Response:**
```json
{
  "ok": true,
  "councilCode": "BCC",
  "daNumber": "A006738808",
  "projectMetadata": {
    "applicationId": "A006738808",
    "scrapedAt": "2025-01-01T00:00:00Z",
    "totalDocuments": 15,
    "categories": ["Decision Notice", "Plans", "Reports"]
  }
}
```

**Scrapers:**
- `details/bcc_scr.py` - Brisbane City Council (Development-i)
- `details/logan_scr.py` - Logan City Council
- `details/redlands_scr.py` - Redland City Council

---

#### `conditions-processor`
**Endpoint:** `POST /conditions/process`  
**Runtime:** Python 3.12

Parses council condition documents (PDF/HTML) and extracts structured data.

**Supported Formats:**
| Council | Format | Parser |
|---------|--------|--------|
| `BCC` | HTML (conditions package) | `bcc_parse.py` |
| `LOGAN` | PDF (decision notice) | `logan_parse.py` |
| `REDLANDS` | PDF | `redlands_parse.py` |

**Request:**
```json
{
  "sessionId": "sess_xxx",
  "fileKey": "intake/sess_xxx/conditions/package.html",
  "councilCode": "BCC"
}
```

**Extracted Data Structure:**
```json
{
  "council": "BCC",
  "summary": {
    "numberOfConditions": 45,
    "numberOfPlans": 12,
    "numberOfReferenceDocuments": 8
  },
  "applicationDetails": {
    "addressOfSite": "123 Example St, Brisbane",
    "councilFileReference": "A006738808",
    "permitReferenceNumbers": "PRN001"
  },
  "projectTeam": [...],
  "referenceDocuments": [...],
  "conditions": {
    "sections": [
      {
        "title": "General Conditions",
        "conditions": [
          {
            "number": "1",
            "title": "Approved Plans",
            "description": "Development must be carried out...",
            "timing": "Prior to commencement",
            "children": [...]
          }
        ]
      }
    ]
  }
}
```

**Dependencies:** `fitz` (PyMuPDF), `beautifulsoup4`, `pypdf`

---

### Project & Documents API

#### `projects-api`
**Endpoints:**
- `GET /projects/{project_id}` - Get project details
- `GET /projects/{project_id}/conditions` - List conditions (paginated)
- `GET /projects/{project_id}/documents` - List documents (paginated)
- `POST /projects/{project_id}/documents/upload-url` - Generate upload URL
- `POST /projects/{project_id}/conditions/{condition_id}/comments` - Add comment

**Runtime:** Node.js 24.x (ESM)  
**Auth:** JWT (Cognito)

**Pagination:** Uses base64-encoded `nextKey` for cursor-based pagination.

**Tables:** `projects`, `conditions`, `documents`, `comments`

---

#### `project_summaries`
**Endpoint:** `GET /projects`  
**Runtime:** Node.js 24.x (ESM)  
**Auth:** JWT (Cognito)

Lists all projects the authenticated user has access to via `project_members`.

**Response:**
```json
{
  "ok": true,
  "projects": [
    {
      "project_id": "uuid",
      "project_name": "123 Example St Development",
      "council_code": "BCC",
      "da_number": "A006738808",
      "conditions_count": 45,
      "documents_count": 23
    }
  ]
}
```

---

#### `create-condition`
**Endpoint:** `POST /projects/{project_id}/conditions`  
**Runtime:** Node.js 24.x (CommonJS)  
**Auth:** JWT (Cognito)

Creates a new condition with optional file attachments.

**Request:**
```json
{
  "project_id": "uuid",
  "condition_text": "All stormwater must be...",
  "condition_ref": "SW-001",
  "category": "Stormwater",
  "status": "pending",
  "due_date": "2025-06-01",
  "files": [
    {
      "file_name": "drawing.pdf",
      "mime_type": "application/pdf",
      "content": "<base64-encoded>"
    }
  ]
}
```

---

## DynamoDB Tables

| Table | Primary Key | GSIs |
|-------|-------------|------|
| `user_profiles` | `user_id` | - |
| `user_invitations` | `invite_id` | - |
| `companies` | `company_id` | `name_normalized-index` |
| `project_intake_sessions` | `session_id` | - |
| `projects` | `project_id` | - |
| `project_members` | `membership_id` | `user_id_index` |
| `project_summaries` | `project_id` | - |
| `conditions` | `condition_id` | `project_id_index` |
| `documents` | `document_id` | `gsi_project_created` |
| `comments` | `comment_id` | - |

---

## S3 Bucket Structure

```
app-planease-files/
├── intake/
│   └── {session_id}/
│       ├── conditions/
│       │   └── {timestamp}_{filename}
│       └── documents/
│           └── {timestamp}_{filename}
└── projects/
    └── {project_id}/
        ├── conditions/
        │   └── {condition_id}/
        │       └── {filename}
        └── documents/
            └── {timestamp}_{filename}
```

---

## Environment Variables

### Common Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `AWS_REGION` | AWS region | `ap-southeast-2` |
| `FILES_BUCKET` / `PROJECT_FILES_BUCKET` | S3 bucket for files | `app-planease-files` |

### Table Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `INTAKE_TABLE` / `INTAKE_SESSIONS_TABLE` | Intake sessions table | `project_intake_sessions` |
| `PROJECTS_TABLE` | Projects table | `projects` |
| `CONDITIONS_TABLE` | Conditions table | `conditions` |
| `DOCUMENTS_TABLE` | Documents table | `documents` |
| `COMMENTS_TABLE` | Comments table | `comments` |
| `USER_PROFILES_TABLE` | User profiles table | `user_profiles` |
| `USER_INVITATIONS_TABLE` | Invitations table | `user_invitations` |
| `COMPANIES_TABLE` | Companies table | `companies` |
| `PROJECT_MEMBERS_TABLE` | Project members table | `project_members` |
| `PROJECT_SUMMARY_TABLE` | Project summaries table | `project_summaries` |

---

## Deployment

Each function has a `config.json` containing the Lambda configuration exported from AWS. Functions can be deployed using:

1. **AWS Console** - Upload zip directly
2. **AWS CLI** - `aws lambda update-function-code`
3. **SAM/CloudFormation** - Infrastructure as code
4. **Terraform** - Infrastructure as code

### Example CLI Deployment
```bash
# Zip and deploy a Node.js function
cd cognito-post-confirmation-add-viewer
zip -r function.zip .
aws lambda update-function-code \
  --function-name cognito-post-confirmation-add-viewer \
  --zip-file fileb://function.zip \
  --region ap-southeast-2

# For Python functions with dependencies
cd conditions-processor
pip install -r requirements.txt -t .
zip -r function.zip .
aws lambda update-function-code \
  --function-name conditions-processor \
  --zip-file fileb://function.zip \
  --region ap-southeast-2
```

---

## IAM Permissions Required

Functions require IAM roles with permissions for:
- **DynamoDB**: `GetItem`, `PutItem`, `UpdateItem`, `Query`, `Scan`, `BatchWriteItem`
- **S3**: `GetObject`, `PutObject`, `CopyObject`, `HeadObject`
- **Cognito**: `AdminAddUserToGroup` (for post-confirmation trigger)
- **CloudWatch Logs**: `CreateLogGroup`, `CreateLogStream`, `PutLogEvents`

---

## Development Notes

### Code Style
- **Node.js functions**: ESM (`.mjs`) preferred, some legacy CommonJS (`.js`)
- **Python functions**: Python 3.12 with type hints
- **Naming**: snake_case for DynamoDB attributes, camelCase for API responses

### Error Handling
All functions return consistent error responses:
```json
{
  "ok": false,
  "error": "ERROR_CODE",
  "message": "Human-readable description"
}
```

### CORS
All functions include CORS headers:
```javascript
{
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PATCH,DELETE"
}
```

---

## License

Proprietary - Planease Pty Ltd
