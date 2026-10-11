# Dhaba Triage API

## Project overview and safety boundaries

`POST /triage` accepts one ticket object. Deterministic fixture mode is the default and makes no model calls. Gemini is used only when `TRIAGE_MODE=gemini` and `GEMINI_API_KEY` are both set. It may suggest category, severity, reply draft, and confidence; the backend validates those suggestions and owns refund status, amount, reason, and human-review decisions.

Ticket text is untrusted. The Gemini prompt says to ignore embedded instructions, but prompt instructions are not a security boundary. Backend validation and refund-decision logic provide separate safeguards. Fixture rules are demo behavior, not AI classification or refund eligibility. They never approve refunds.

## Setup and run

Use Node.js 20, 22, or 24. The local environment used for this run had Node.js 24.14.1 and npm 11.11.0. On a clean machine:

```powershell
npm ci
Copy-Item .env.example .env  # optional; never commit .env
npm run build
npm test
npm run typecheck
npm start
```

Fixture mode works without an API key; leave `TRIAGE_MODE` unset or set it to `fixture`. To opt into Gemini, set `TRIAGE_MODE=gemini` and `GEMINI_API_KEY` in the local environment or ignored `.env` file.

### Synthetic API request

After starting the API in fixture mode, this PowerShell example sends a synthetic ticket that matches the request schema:

```powershell
$ticket = @{
  id = "synthetic-demo-001"
  received_at = "2026-10-12T12:00:00+05:30"
  subject = "How do I update my display name?"
  body = "Please explain the steps."
  purchases = @()
  app_opens_since_renewal = 0
}
$requestBody = $ticket | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "http://127.0.0.1:3000/triage" -Method Post -ContentType "application/json" -Body $requestBody
```

### Local synthetic load test

Build and start the API in fixture mode from PowerShell (Terminal 1). An empty `GEMINI_API_KEY` is intentional; no API key is required for this run:

```powershell
npm run build
$env:TRIAGE_MODE = "fixture"
$env:GEMINI_API_KEY = ""
$env:PORT = "3000"
npm start
```

In a second terminal, run the short default test (50 requests/second for 10 seconds, maximum 32 in flight, 5-second request timeout):

```powershell
npm run loadtest
```

For example, set the rate, duration, concurrency, timeout, or endpoint explicitly:

```powershell
npm run loadtest -- --rate 50 --duration 20 --concurrency 32 --timeout-ms 5000 --url http://127.0.0.1:3000
```

The runner uses synthetic ticket text and unique ticket IDs for load requests, validates successful responses against the built response schema, applies a bounded concurrency limit, and reports HTTP, network, and schema failures. Its separate two-request replay check uses the same synthetic ID and payload; provider-call deduplication is additionally covered by the mocked-provider API test.

### Recorded local measurements

Measured on the local Windows environment with Node.js 24.14.1 and npm 11.11.0, against `127.0.0.1:3000` with `TRIAGE_MODE=fixture` and an empty Gemini key. Requests used unique synthetic IDs. `Completed RPS` counts terminal outcomes (HTTP response or network failure) divided by elapsed time through final drain. Latencies include response-body parsing. The runner defines “sustained” as no unsent requests/concurrency drops, all sent requests successful, at least 95% of planned successes completed within the configured window, and total completed RPS at least 95% of target.

| Target / duration / concurrency | Scheduled | Sent / completed | Success / HTTP error / network failure / schema failure | Skipped at cap | Completed RPS | p50 / p95 (ms) | Sustained by stated criterion |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 50/s / 5s / 16 (initial) | 250 | 118 / 118 | 112 / 0 / 6 / 0 | 132 | 17.56 | 326.39 / 5001.14 | No |
| 50/s / 10s / 32 | 500 | 500 / 500 | 496 / 0 / 4 / 0 | 0 | 48.82 | 299.72 / 367.32 | No |
| 50/s / 20s / 32 | 1000 | 1000 / 1000 | 1000 / 0 / 0 / 0 | 0 | 49.28 | 295.58 / 351.31 | Yes |

The 20-second run completed 983 successful responses within its measurement window (49.15 successful responses/second); the remaining 17 completed during drain. The two-request replay check returned successful, identical response bodies. The first short run saturated its concurrency cap; the 10-second run had four network failures. The longer run met the runner's 95% criterion, but measured completed throughput was 49.28/second, below exactly 50. These local fixture results do not establish exact 50/s capacity under other machines, Gemini mode, production traffic, or longer operation. They are measurements, not a load test of the proposed production architecture.

## Task 2: Evaluation of the 12 supplied tickets

The recorded local fixture-mode run returned successful HTTP responses for all 12 tickets, with confidence `0.5` for each. Because fixture confidence is below the `0.70` human-review threshold, every response sets `needs_human: true`. The table records those observed outputs. The assessment remains `Investigate` where the available record does not provide enough independent evidence to judge correctness; a successful response alone is not proof of a correct classification.

| Ticket | Category | Severity | Refund status | `needs_human` | Assessment |
| --- | --- | --- | --- | --- | --- |
| T-1001 | `billing_dispute` | `medium` | `pending_review` | `true` | Investigate - no independent label recorded |
| T-1002 | `general_complaint` | `medium` | `not_applicable` | `true` | Investigate - no independent label recorded |
| T-1003 | `general_complaint` | `medium` | `pending_review` | `true` | Investigate - instruction-bearing input needs separate evaluation |
| T-1004 | `cancellation` | `medium` | `not_applicable` | `true` | Investigate - no independent label recorded |
| T-1005 | `payment_activation` | `medium` | `pending_review` | `true` | Investigate - no independent label recorded |
| T-1006 | `billing_dispute` | `medium` | `not_applicable` | `true` | Investigate - no independent label recorded |
| T-1007 | `feature_request` | `low` | `pending_review` | `true` | Investigate - inspect billing evidence |
| T-1008 | `fraud` | `high` | `not_applicable` | `true` | Investigate - no independent label recorded |
| T-1009 | `billing_dispute` | `medium` | `pending_review` | `true` | Investigate - no independent label recorded |
| T-1010 | `invoice_request` | `medium` | `not_applicable` | `true` | Investigate - no independent label recorded |
| T-1011 | `product_question` | `low` | `pending_review` | `true` | Investigate - inspect billing evidence and instruction handling |
| T-1012 | `general_complaint` | `medium` | `pending_review` | `true` | Investigate - no independent label recorded |

### Prompt-injection findings and observed outputs

The authorized local scan identified T-1003 and T-1011 as the two tickets containing assistant-directed instructions. Their observed deterministic fixture outputs are already shown in the evaluation table: T-1003 was `general_complaint`, `medium`, `pending_review` with amount zero, human review true; T-1011 was `product_question`, `low`, `pending_review` with amount zero, human review true. Confidence was `0.5` for both. Ticket content is intentionally omitted.

These are fixture outputs, not Gemini results. The real Gemini provider was not called on either ticket, so there is no evidence here that Gemini resisted their instructions. The synthetic mocked-provider test `preserves backend refund safety when customer text requests a policy override` in `tests/gemini-api.test.ts` checks a separate synthetic instruction and false refund-approval draft. It verifies that the backend retains refund status and amount and replaces the unsupported approval claim; it does not evaluate the real model.

### Ambiguity and dashboard metric

The fixture-mode human-review rate was **12/12 (100%)**. This is a fixture metric, not model accuracy. All responses have confidence `0.5`, below the `0.70` threshold. T-1007 combines `feature_request` with `pending_review`; T-1011 combines `product_question` and low severity with `pending_review`. Backend purchase or billing signals may explain those review decisions. Inspect those signals before judging either output; neither is declared wrong based on its category alone.

## Task 3: Backend track

### Implemented behavior

Gemini calls use a 10-second abort signal. Invalid suggestions and provider errors fall back to a schema-validated deterministic fixture response with the normal response shape. Fixture mode works without an API key. A process-local idempotency cache coalesces concurrent requests and replays results for the same ticket ID and validated payload; reusing an ID with different content returns HTTP 409. The cache holds at most 10,000 entries and evicts the least-recently-used completed result when full; it never evicts in-flight work, and returns HTTP 503 for a new ID if all entries are in flight. After eviction, a later repeat of that older ID can be processed again. The cache is lost on restart and is not shared between instances, so this is not durable or distributed idempotency. The project does not execute refunds, and this mechanism does not claim to prevent duplicate refunds.

### Proposed 50-tickets/second production design (not implemented or load-tested)

Validate at ingress and assign a correlation ID. Reserve an idempotency record before enqueueing. Use a bounded queue with a bounded wait; for example, 500 jobs represents about 10 seconds at 50 requests per second. A worker pool should cap concurrent Gemini calls and use a token-bucket rate limit configured to the provider quota. Apply deadlines and backpressure. When the queue is full or the provider circuit breaker is open, skip model work and return the deterministic fixture response rather than accumulating unbounded work. That degraded response uses confidence `0.5`, requires human review under the current threshold, and keeps refund fields backend-generated with zero amount. If fallback generation or required idempotency storage is unavailable, return a generic retryable `503` with `Retry-After`. Apart from provider-error fallback, these are proposals, not current behavior. The local fixture load test above does not validate this production design.

### Proposed storage

| Table/document | Example fields | Purpose |
| --- | --- | --- |
| `tickets` | ticket ID, encrypted minimal payload, received time, expiry | Store only processing-required ticket data with access controls and retention. |
| `triage_runs` | run ID, ticket ID, state, mode, model/prompt version, result JSON, timestamps | Record processing state and each triage result. |
| `idempotency_keys` | key, payload hash, run ID, stored response/status, expiry | Return the recorded result for repeats and reject key reuse with a different payload. |
| `audit_events` | event ID, run ID, request ID, event type, policy version, refund status/amount, reason code, timestamp | Keep append-only decision metadata without ticket text, credentials, or raw model output. |

### 3 AM debugging

Propagate a correlation ID from ingress through queue and provider calls. Emit structured, redacted logs with mode, elapsed time, queue depth, model/prompt version, and fallback/error class, plus counters for fallback rate and queue saturation. Do not log subject, body, full payload, API keys, or raw model responses.

## Task 4: AI usage disclosure

- **Agent used:** OpenAI Codex in this conversation for code review, implementation, and test work.
- **Code contribution:** OpenAI Codex wrote essentially all of the code. I reviewed the results and made small fixes with Codex guidance.
- **Genuine agent mistake:** The first refund-negation regression test expected `needs_human: false`, although fixture confidence is `0.5` and the existing `<0.70` rule requires human review. The test failure exposed the conflict. The assertion was corrected to `true`; refund status remained `not_applicable`, amount remained zero, and the safety threshold was not weakened.
- **Handwritten task:** I did not independently handwrite a task; I relied on Codex for implementation.
- **Exact prompt from this conversation (not a claim that it was the single best prompt):**

```text
Add one synthetic regression test to tests/gemini-api.test.ts for the combined backend safety invariant.

Requirements:

- Use a synthetic ticket, not any ticket from the confidential assignment.
- The ticket body should contain an instruction attempting to override policy and approve a refund.
- Use the existing mocked provider mechanism.
- Have the mock return a benign, high-confidence classification and a reply draft that falsely claims the refund was approved.
- Assert that the API retains the backend-derived refund status and amount of zero, sets needs_human appropriately, and replaces the unsupported approval claim with the neutral safety message.
- Assert that the response passes the existing response schema.
- Do not call Gemini or inspect .env.
- Do not change production code unless the test exposes a genuine invariant violation; if so, explain the violation and make the smallest fix.
- Run npm test and npm run typecheck, then report the exact test added, files changed, and results.

Do not commit or push.
```

## Limitations

Fixture mode uses keyword heuristics and constant `0.5` confidence; it is not a model classification or validated refund policy. The demo approves no refunds. The 12 successful HTTP responses do not establish classification accuracy. The synthetic mocked-provider test does not prove behavior of the real Gemini model on the two instruction-bearing tickets. Persistent idempotency, refund execution, queueing, and the proposed outage controls are not implemented. The recorded load test is local, fixture-only, and limited to 20 seconds; no production or Gemini-mode load test has been run.
