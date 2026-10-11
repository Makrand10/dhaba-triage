import "dotenv/config";
import { createHash } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import { ticketRequestSchema, triageResponseSchema, type TicketRequest, type TriageResponse } from "./schemas/triage-schema.js";
import { createFixtureTriage } from "./triage-fixture.js";
import { createGeminiSuggestion, triageSuggestionSchema } from "./gemini-provider.js";

type AppOptions = {
  mode?: () => string | undefined;
  apiKey?: () => string | undefined;
  geminiProvider?: (ticket: TicketRequest) => Promise<unknown>;
};

type IdempotencyEntry = {
  fingerprint: string;
  response: Promise<TriageResponse | null>;
  completed: boolean;
};

// Process-local cache bound: evict the least-recently-used completed result when full.
const maxIdempotencyEntries = 10_000;

function fingerprintTicket(ticket: TicketRequest): string {
  const canonicalTicket = {
    id: ticket.id,
    received_at: ticket.received_at,
    subject: ticket.subject,
    body: ticket.body,
    purchases: ticket.purchases.map((purchase) => ({
      id: purchase.id,
      type: purchase.type,
      amount_inr: purchase.amount_inr,
      status: purchase.status,
      at: purchase.at,
    })),
    app_opens_since_renewal: ticket.app_opens_since_renewal,
  };
  return createHash("sha256").update(JSON.stringify(canonicalTicket)).digest("hex");
}

function createValidatedFixtureResponse(ticket: TicketRequest): TriageResponse | null {
  const result = triageResponseSchema.safeParse(createFixtureTriage(ticket));
  return result.success ? result.data : null;
}

const refundApprovalClaimPattern =
  /\b(?:refund|reimbursement|money back)\b.{0,40}\b(?:approve(?:d|s|al)?|process(?:ed|ing)?|initiated|issued|sent|credited|on its way)\b|\b(?:approved|processed|initiated|issued|sent|credited)\b.{0,40}\b(?:refund|reimbursement|money back)\b/i;
const unsupportedActionClaimPattern =
  /\b(?:account|subscription)\b.{0,35}\b(?:has been|was|is)\s+(?:cancelled|canceled)\b|\b(?:cancelled|canceled)\b.{0,35}\b(?:account|subscription)\b|\b(?:issue|problem|bug|error)\b.{0,35}\b(?:is|was|has been)\s+(?:fixed|resolved)\b|\b(?:fixed|resolved)\b.{0,35}\b(?:issue|problem|bug|error)\b/i;
const neutralRefundDraft = "A support agent will review your request and share an update.";

function protectUnapprovedRefundDraft(draft: string, refundStatus: string): string {
  if (
    (refundStatus !== "approved" && refundApprovalClaimPattern.test(draft)) ||
    unsupportedActionClaimPattern.test(draft)
  ) {
    return neutralRefundDraft;
  }
  return draft;
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  const idempotencyCache = new Map<string, IdempotencyEntry>();
  const getMode = options.mode ?? (() => process.env.TRIAGE_MODE);
  const getApiKey = options.apiKey ?? (() => process.env.GEMINI_API_KEY);
  const geminiProvider = options.geminiProvider ?? ((ticket: TicketRequest) => {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("Gemini API key is not configured.");
    return createGeminiSuggestion(ticket, apiKey);
  });

  async function createTriageResponse(ticket: TicketRequest): Promise<TriageResponse | null> {
    try {
      const apiKey = getApiKey();
      const useGemini = getMode() === "gemini" && (Boolean(apiKey) || Boolean(options.geminiProvider));
      if (!useGemini) return createValidatedFixtureResponse(ticket);

      const suggestion = triageSuggestionSchema.safeParse(await geminiProvider(ticket));
      if (!suggestion.success) return createValidatedFixtureResponse(ticket);

      // Reuse backend-only policy rules; the provider never supplies refund or escalation fields.
      const policy = createFixtureTriage(ticket);
      const responseResult = triageResponseSchema.safeParse({
        ticket_id: ticket.id,
        ...suggestion.data,
        reply_draft: protectUnapprovedRefundDraft(suggestion.data.reply_draft, policy.refund.status),
        refund: policy.refund,
        needs_human:
          policy.refund.status === "pending_review" ||
          policy.category === "fraud" ||
          policy.severity === "high" ||
          suggestion.data.category === "fraud" ||
          suggestion.data.severity === "critical" ||
          suggestion.data.confidence < 0.7,
      });
      return responseResult.success ? responseResult.data : createValidatedFixtureResponse(ticket);
    } catch {
      return createValidatedFixtureResponse(ticket);
    }
  }

  function touchEntry(ticketId: string, entry: IdempotencyEntry): void {
    if (idempotencyCache.get(ticketId) !== entry) return;
    idempotencyCache.delete(ticketId);
    idempotencyCache.set(ticketId, entry);
  }

  function removeEntryIfCurrent(ticketId: string, entry: IdempotencyEntry): void {
    if (idempotencyCache.get(ticketId) === entry) idempotencyCache.delete(ticketId);
  }

  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  app.post("/triage", async (request, response) => {
    const requestResult = ticketRequestSchema.safeParse(request.body);
    if (!requestResult.success) {
      response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request body does not match the ticket schema.",
        },
      });
      return;
    }

    const ticket = requestResult.data;
    const fingerprint = fingerprintTicket(ticket);
    let entry = idempotencyCache.get(ticket.id);

    if (entry && entry.fingerprint !== fingerprint) {
      response.status(409).json({
        error: { code: "IDEMPOTENCY_CONFLICT", message: "Ticket ID was already used with a different request." },
      });
      return;
    }

    if (entry) {
      touchEntry(ticket.id, entry);
    } else {
      if (idempotencyCache.size >= maxIdempotencyEntries) {
        const oldestCompleted = [...idempotencyCache.entries()].find(([, cached]) => cached.completed);
        if (oldestCompleted) idempotencyCache.delete(oldestCompleted[0]);
        else {
          response.status(503).json({
            error: { code: "IDEMPOTENCY_CAPACITY", message: "Triage capacity is temporarily unavailable." },
          });
          return;
        }
      }

      // Defer work one microtask so the in-flight reservation is in the map first.
      const responsePromise = Promise.resolve().then(() => createTriageResponse(ticket));
      entry = { fingerprint, response: responsePromise, completed: false };
      idempotencyCache.set(ticket.id, entry);
      const reservedEntry = entry;
      void responsePromise.then(
        (result) => {
          if (!result) {
            removeEntryIfCurrent(ticket.id, reservedEntry);
            return;
          }
          reservedEntry.completed = true;
          touchEntry(ticket.id, reservedEntry);
        },
        () => removeEntryIfCurrent(ticket.id, reservedEntry),
      );
    }

    try {
      const result = await entry.response;
      if (!result) {
        removeEntryIfCurrent(ticket.id, entry);
        response.status(500).json({
          error: { code: "INTERNAL_ERROR", message: "Unable to create a triage response." },
        });
        return;
      }
      response.status(200).json(result);
    } catch {
      removeEntryIfCurrent(ticket.id, entry);
      response.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "Unable to create a triage response." },
      });
    }
  });

  app.use((_request, response) => {
    response.status(404).json({
      error: { code: "NOT_FOUND", message: "Route not found." },
    });
  });

  const handleJsonErrors: ErrorRequestHandler = (error, _request, response, _next) => {
    if (
      error instanceof Error &&
      "type" in error &&
      error.type === "entity.too.large" &&
      "status" in error &&
      error.status === 413
    ) {
      response.status(413).json({
        error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the allowed size." },
      });
      return;
    }
    if (error instanceof SyntaxError && "status" in error && error.status === 400) {
      response.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "Request body must be valid JSON." },
      });
      return;
    }
    response.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "An internal error occurred." },
    });
  };

  app.use(handleJsonErrors);

  return app;
}

export default createApp();
