import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { triageResponseSchema, type TicketRequest } from "../src/schemas/triage-schema.js";
import { createFixtureTriage } from "../src/triage-fixture.js";

const validTicket: TicketRequest = {
  id: "gemini-mock-ticket-01",
  received_at: "2026-02-10T09:30:00+05:30",
  subject: "Need help with my account",
  body: "I have a question about using the app.",
  purchases: [
    {
      id: "gemini-mock-purchase-01",
      type: "renewal",
      amount_inr: 499,
      status: "successful",
      at: "2026-02-09T09:30:00+05:30",
    },
  ],
  app_opens_since_renewal: 2,
};

const validSuggestion = {
  category: "product_question",
  severity: "low",
  reply_draft: "This is a mock draft for the customer's question.",
  confidence: 0.74,
};

describe("Gemini-mode API with a mocked provider", () => {
  let server: Server;
  let baseUrl: string;
  let providerCalls: TicketRequest[];
  let mockOutput: unknown;
  let providerFailure: Error | null;

  beforeEach(async () => {
    providerCalls = [];
    mockOutput = validSuggestion;
    providerFailure = null;
    const app = createApp({
      mode: () => "gemini",
      // The injected mock deliberately works without an API key.
      geminiProvider: async (ticket) => {
        providerCalls.push(ticket);
        if (providerFailure) throw providerFailure;
        return mockOutput;
      },
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("uses the mock suggestion and returns a schema-valid response without any API key", async () => {
    const previousKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const response = await fetch(`${baseUrl}/triage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validTicket),
      });
      const payload: unknown = await response.json();
      expect(response.status).toBe(200);
      expect(triageResponseSchema.safeParse(payload).success).toBe(true);
      expect(payload).toMatchObject({
        category: "product_question",
        severity: "low",
        reply_draft: validSuggestion.reply_draft,
        refund: { status: "not_applicable", amount_inr: 0 },
        needs_human: false,
      });
      expect(providerCalls).toEqual([validTicket]);
    } finally {
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
    }
  });

  it("keeps refund policy in the backend when Gemini suggests only triage fields", async () => {
    const response = await fetch(`${baseUrl}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validTicket, subject: "Please refund this purchase" }),
    });
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.refund).toMatchObject({ status: "pending_review", amount_inr: 0 });
    expect(payload.needs_human).toBe(true);
  });

  it("keeps unauthorized-charge complaints under human review despite a benign suggestion", async () => {
    mockOutput = {
      ...validSuggestion,
      category: "product_question",
      severity: "low",
      confidence: 0.99,
    };
    const ticket = { ...validTicket, subject: "I did not authorize a charge" };
    const response = await fetch(`${baseUrl}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ticket),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.category).toBe("product_question");
    expect(payload.severity).toBe("low");
    expect(payload.confidence).toBe(0.99);
    expect(payload.refund).toMatchObject({ status: "pending_review", amount_inr: 0 });
    expect(payload.needs_human).toBe(true);
  });

  it.each([
    "Your account has been cancelled.",
    "The issue is fixed.",
  ])("replaces unsupported action claims in the draft: %s", async (reply_draft) => {
    mockOutput = { ...validSuggestion, reply_draft };
    const response = await fetch(`${baseUrl}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validTicket),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.reply_draft).toBe("A support agent will review your request and share an update.");
  });

  it("preserves a normal customer-facing draft", async () => {
    mockOutput = { ...validSuggestion, reply_draft: "Thanks for contacting us. How can I help?" };
    const response = await fetch(`${baseUrl}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validTicket),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.reply_draft).toBe("Thanks for contacting us. How can I help?");
  });

  it.each([
    ["pending_review", { ...validTicket, subject: "Please refund this purchase" }],
    ["not_applicable", validTicket],
  ] as const)("replaces an unsupported approval claim when refund status is %s", async (status, ticket) => {
    mockOutput = { ...validSuggestion, reply_draft: "Your refund has been approved." };
    const response = await fetch(`${baseUrl}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ticket),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.refund).toMatchObject({ status, amount_inr: 0 });
    expect(payload.reply_draft).toBe("A support agent will review your request and share an update.");
  });

  it("rejects malformed suggestions and model attempts to provide refund fields", async () => {
    for (const invalidOutput of [
      { ...validSuggestion, category: "made_up_category" },
      { ...validSuggestion, refund: { status: "approved", amount_inr: 499, reason: "model said so" } },
    ]) {
      mockOutput = invalidOutput;
      const response = await fetch(`${baseUrl}/triage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validTicket),
      });
      const payload: unknown = await response.json();
      expect(response.status).toBe(200);
      expect(payload).toEqual(createFixtureTriage(validTicket));
      expect(triageResponseSchema.safeParse(payload).success).toBe(true);
    }
  });

  it.each(["provider failure", "timeout"])("falls back to the validated fixture on %s", async (failure) => {
    providerFailure = new Error(`mock ${failure}`);
    const response = await fetch(`${baseUrl}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validTicket),
    });
    const payload: unknown = await response.json();
    expect(response.status).toBe(200);
    expect(payload).toEqual(createFixtureTriage(validTicket));
    expect(triageResponseSchema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({
      confidence: 0.5,
      needs_human: true,
      refund: { status: "not_applicable", amount_inr: 0 },
    });
  });

  it("forces human review when Gemini confidence is below 0.70", async () => {
    mockOutput = { ...validSuggestion, confidence: 0.69 };
    const response = await fetch(`${baseUrl}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validTicket),
    });
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.needs_human).toBe(true);
    expect(payload.confidence).toBe(0.69);
    expect(payload.refund).toMatchObject({ status: "not_applicable", amount_inr: 0 });
  });
});
