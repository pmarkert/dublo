## Serverless Dublo Test Orchestration on AWS
Overview
A suite execution is triggered (CI, schedule, or manual API call) → an Orchestrator Lambda fans out individual Worker tasks — one per scenario × context combination — each running Dublo headlessly, then publishes its report to S3.

Data Layer (S3 + DynamoDB)
S3 — Shared Workspace Bucket (dublo-workspace/)

workspaces/<workspace-name>/defaults.json — workspace config
workspaces/<workspace-name>/llm/<profile>.json — LLM settings
workspaces/<workspace-name>/scenarios/<name>.md — scenario definitions
workspaces/<workspace-name>/personas/<name>.md — persona files
workspaces/<workspace-name>/blocks/<name>.json — init blocks
reports/<suite-run-id>/<task-id>/ — per-task artifacts (HTML, markdown, screenshots)
reports/<suite-run-id>/summary.json — aggregated suite summary
DynamoDB — Test Inventory

DubloTestCases table: pk=workspaceName, sk=scenarioName, attributes: scenario text/overrides, tags, enabled flag
DubloContextVars table: pk=workspaceName, sk=contextName, attributes: context JSON blob (non-secret values only — secrets stay in Secrets Manager / SSM)
DubloSuiteRuns table: tracking suite executions, statuses per task, aggregated pass/fail counts
Compute Layer
Option A — Lambda + Docker container image (recommended)

Build a Docker image: Node 20 + Playwright + Chromium + Dublo installed
Deploy as a Lambda function with 10 GB memory / 15 min timeout, ARM64 or x86
Playwright in headless mode works inside Lambda containers with the right system deps
Each invocation runs a single dublo run with config injected via the event payload
Option B — ECS Fargate tasks (for longer-running scenarios)

Same Docker image deployed to ECR
Orchestrator submits Fargate RunTask calls instead of Lambda Invoke
Better for scenarios exceeding Lambda's 15-minute limit
Slightly higher cold-start overhead, but no timeout constraints
Recommendation: Start with Lambda containers; add a Fargate fallback for suites that hit the timeout.

Orchestrator Lambda
Triggered by: EventBridge (schedule), API Gateway (manual/CI webhook), or SQS message.

Input payload:

JSON
{
  "workspaceName": "my-app",
  "suiteRunId": "uuid",
  "scenarios": ["checkout", "login"],   // omit = all enabled in DynamoDB
  "contexts": ["qa-user", "prod-user"], // omit = all enabled in DynamoDB
  "llmOverride": "bedrock-nova-pro",
  "tags": ["smoke"]
}
Logic:

Fetch the enabled scenario × context matrix from DynamoDB (filter by tags if provided)
Download defaults.json and LLM profiles from S3 to validate config
Fan out one Worker invocation per (scenario, context) pair — up to Lambda's concurrency limit, or batched into SQS for rate control
Write initial DubloSuiteRuns record with all task IDs and PENDING status
Return suiteRunId immediately (async fan-out)
Worker Lambda / Fargate Task
Startup sequence:

Receive event: { suiteRunId, taskId, workspaceName, scenario, context, llmProfile }
Sync workspace files from S3 into /tmp/workspace/ (only what's needed for this run)
Fetch context variables from DynamoDB → write to /tmp/workspace/context/<name>.json
Fetch secrets from AWS Secrets Manager → pass as DUBLO_SECRET_* env vars (never written to disk)
Build dublo run arguments and exec in-process (call runScenario() directly via the library API, avoiding subprocess overhead)
Capture the report artifacts
Upload report artifacts to s3://dublo-reports/<suiteRunId>/<taskId>/
Write task result (pass/fail, cost, step count, duration) to DubloSuiteRuns DynamoDB record
On completion of all tasks, a DynamoDB Stream → aggregator Lambda computes the suite summary and writes summary.json to S3
Report Publishing
Each worker uploads its raw artifacts (HTML report, markdown, screenshots) to S3
S3 bucket policy allows pre-signed URL generation for sharing results
Aggregator Lambda (triggered by DynamoDB Streams when all tasks complete) produces a suite-summary.html page linking to all individual task reports
Optionally: CloudFront distribution in front of the reports bucket for easy browsing
SNS/SES notification with suite pass/fail + S3 link on completion
Security & Config
Worker Lambda execution role: s3:GetObject (workspace bucket), s3:PutObject (reports bucket), dynamodb:GetItem/Query (test tables), secretsmanager:GetSecretValue, bedrock:InvokeModel
Secrets Manager stores credentials used in test context (passwords, API keys, tokens)
Workspace bucket uses server-side encryption; reports bucket can be scoped per-team with bucket policies
Separate IAM roles for orchestrator (broader read) vs. worker (scoped to its workspace prefix)
Infrastructure (IaC)
Define all resources in AWS CDK or Terraform:

ECR repository + Docker build pipeline (CodeBuild or GitHub Actions → ECR push)
Lambda functions (Orchestrator, Worker, Aggregator) with appropriate memory/timeout
DynamoDB tables with on-demand billing
S3 buckets (workspace, reports) with lifecycle rules for old reports
EventBridge rules for scheduled suite runs
SQS queue (optional, for rate-controlled fan-out)
CloudWatch dashboards for suite pass rates, cost per run, step counts
Dublo Code Changes Required
Library entrypoint: Expose runScenario() cleanly from src/index.ts (it may already be partially exported) so the Worker can call it programmatically without spawning a subprocess
S3 workspace adapter: Add an optional workspace resolver that reads scenario/llm/persona/context files from S3 paths instead of the local filesystem — or simply sync to /tmp on Lambda startup (simpler, no code change)
DynamoDB context source: Add a context provider that fetches context variables from DynamoDB as an alternative to local JSON/YAML files — can be injected via --json flag with data pre-fetched in the worker harness
Report S3 upload: After runScenario() completes, the worker uploads the outputDir artifacts to S3 (this is worker harness logic, not a Dublo core change)
The simplest path avoids changes to Dublo core entirely: the worker syncs S3 files to /tmp, runs Dublo normally, and uploads the output directory to S3 when done.

Phased Rollout
Phase 1 — Foundation

Docker image with Playwright + Dublo running headlessly in Lambda
Manual-trigger Orchestrator via API Gateway
Workspace files stored in S3, synced to /tmp on startup
Reports uploaded to S3 after each run
Phase 2 — DynamoDB Integration

Migrate scenario and context inventory to DynamoDB
Implement scenario × context fan-out in the Orchestrator
DynamoDB Streams → Aggregator Lambda for suite summaries
Phase 3 — Polish

CloudFront + suite summary HTML page
SNS/Slack notifications
Scheduled runs via EventBridge
Cost tracking per suite/scenario in DynamoDB