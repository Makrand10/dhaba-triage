import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import { ticketRequestSchema, triageResponseSchema, type TicketRequest } from "./schemas/triage-schema.js";
import { createFixtureTriage } from "./triage-fixture.js";
import { createGeminiSuggestion, triageSuggestionSchema } from "./gemini-provider.js";

type AppOptions = {
  mode?: () => string | undefined;
  apiKey?: () => string | undefined;
  geminiProvider?: (ticket: TicketRequest) => Promise<unknown>;
};

function sendFixtureResponse(ticket: TicketRequest, response: express.Response): void {
  const fixtureResult = triageResponseSchema.safeParse(createFixtureTriage(ticket));
  if (!fixtureResult.success) {
    response.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Unable to create a triage response." },
    });
    return;
  }
  response.status(200).json(fixtureResult.data);
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  const getMode = options.mode ?? (() => process.env.TRIAGE_MODE);
  const getApiKey = options.apiKey ?? (() => process.env.GEMINI_API_KEY);
  const geminiProvider = options.geminiProvider ?? ((ticket: TicketRequest) => {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("Gemini API key is not configured.");
    return createGeminiSuggestion(ticket, apiKey);
  });

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
    const apiKey = getApiKey();
    const useGemini = getMode() === "gemini" && (Boolean(apiKey) || Boolean(options.geminiProvider));

    try {
      if (useGemini) {
        const suggestion = triageSuggestionSchema.safeParse(await geminiProvider(ticket));
        if (!suggestion.success) {
          sendFixtureResponse(ticket, response);
          return;
        }

        // Reuse backend-only policy rules; the provider never supplies refund or escalation fields.
        const policy = createFixtureTriage(ticket);
        const responseResult = triageResponseSchema.safeParse({
          ticket_id: ticket.id,
          ...suggestion.data,
          refund: policy.refund,
          needs_human:
            policy.needs_human ||
            suggestion.data.category === "fraud" ||
            suggestion.data.severity === "critical" ||
            suggestion.data.confidence < 0.7,
        });
        if (!responseResult.success) {
          sendFixtureResponse(ticket, response);
          return;
        }
        response.status(200).json(responseResult.data);
        return;
      }

      const responseResult = triageResponseSchema.safeParse(createFixtureTriage(ticket));
      if (!responseResult.success) {
        response.status(500).json({
          error: { code: "INTERNAL_ERROR", message: "Unable to create a triage response." },
        });
        return;
      }
      response.status(200).json(responseResult.data);
    } catch {
      if (useGemini) sendFixtureResponse(ticket, response);
      else {
        response.status(500).json({
          error: { code: "INTERNAL_ERROR", message: "Unable to create a triage response." },
        });
      }
    }
  });

  app.use((_request, response) => {
    response.status(404).json({
      error: { code: "NOT_FOUND", message: "Route not found." },
    });
  });

  const handleJsonErrors: ErrorRequestHandler = (error, _request, response, _next) => {
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
