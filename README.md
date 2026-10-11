# Dhaba Triage API

This project defaults to deterministic fixture mode. `POST /triage` applies a small, local keyword heuristic and makes no model calls unless `TRIAGE_MODE=gemini` and `GEMINI_API_KEY` are both set. Copy `.env.example` to `.env` to configure local use. Environment variables are loaded before the app is created. Gemini may suggest only category, severity, reply draft, and confidence; its output is validated before use. The backend independently supplies refund fields and forces human review for pending refunds. Ticket text is sent as untrusted content, and the prompt instructs Gemini to ignore embedded instructions that attempt to change its role or bypass policy. Prompt instructions alone are not a security boundary: backend validation and refund-decision logic provide separate safeguards.

Fixture mode remains deterministic: the same ticket produces the same result. Its keyword rules are demo behavior, not an AI classification or refund policy. Refund requests and synonyms, disputed or unauthorized charges, renewal disputes, explicit ambiguous billing phrases (including supported Hinglish payment activation phrases), and initiated or failed purchases are sent to `pending_review` with a zero amount and `needs_human: true`; suspected fraud also always requires human review. Other tickets receive `not_applicable` with a zero amount. No refund eligibility is established by these demo rules.

## Local fixture-mode evaluation

In a local run using deterministic fixture mode, all 12 requests returned successful HTTP responses. Confidence was `0.5` for every response.

| Ticket | Category | Severity | Refund status | `needs_human` |
| --- | --- | --- | --- | --- |
| T-1001 | `billing_dispute` | `medium` | `pending_review` | `true` |
| T-1002 | `general_complaint` | `medium` | `not_applicable` | `false` |
| T-1003 | `general_complaint` | `medium` | `pending_review` | `true` |
| T-1004 | `cancellation` | `medium` | `not_applicable` | `false` |
| T-1005 | `payment_activation` | `medium` | `pending_review` | `true` |
| T-1006 | `billing_dispute` | `medium` | `not_applicable` | `false` |
| T-1007 | `feature_request` | `low` | `pending_review` | `true` |
| T-1008 | `fraud` | `high` | `not_applicable` | `true` |
| T-1009 | `billing_dispute` | `medium` | `pending_review` | `true` |
| T-1010 | `invoice_request` | `medium` | `not_applicable` | `false` |
| T-1011 | `product_question` | `low` | `pending_review` | `true` |
| T-1012 | `general_complaint` | Not reported | `pending_review` | `true` |

The fixture-mode human-review rate was **8/12 (66.7%)**. This is a fixture-mode metric, not model accuracy. T-1007 has a `feature_request` category but `pending_review`; T-1011 has `product_question` and low severity but `pending_review`. These refund-review outcomes may be driven by backend purchase or billing signals and need inspection; the results alone do not establish that either is wrong.

The synthetic mocked-provider prompt-injection regression test passes and verifies that backend refund status and amount remain safe while an unsupported refund-approval draft is replaced with a neutral message. The real Gemini provider was not called on T-1003 or T-1011, so this fixture run does not establish how the model would behave on those tickets.

These results reflect fixture keyword heuristics and a constant `0.5` confidence. The demo rules approved no refunds. Successful HTTP responses show that requests were handled, not that classifications were accurate.

Run with `npm run build` followed by `npm start`. The service listens on port 3000 by default; set `PORT` to change it. No API key is needed. `GET /health` returns `{ "status": "ok" }`.
