import express, { type ErrorRequestHandler } from "express";
import { ticketRequestSchema, triageResponseSchema } from "./schemas/triage-schema.js";
import { createFixtureTriage } from "./triage-fixture.js";

const app = express();

app.use(express.json({ limit: "100kb" }));

app.get("/health", (_request, response) => {
  response.status(200).json({ status: "ok" });
});

app.post("/triage", (request, response) => {
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

  try {
    const responseResult = triageResponseSchema.safeParse(createFixtureTriage(requestResult.data));
    if (!responseResult.success) {
      response.status(500).json({
        error: { code: "INTERNAL_ERROR", message: "Unable to create a triage response." },
      });
      return;
    }
    response.status(200).json(responseResult.data);
  } catch {
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

export default app;
