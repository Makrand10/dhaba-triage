import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { triageResponseSchema } from "../src/schemas/triage-schema.js";

const validTicket = {
  id: "ticket-demo-1001",
  received_at: "2026-01-15T09:30:00+05:30",
  subject: "Unable to access my account",
  body: "The app shows an error when I try to sign in.",
  purchases: [
    {
      id: "purchase-demo-1001",
      type: "renewal",
      amount_inr: 499,
      status: "successful",
      at: "2026-01-14T10:00:00+05:30",
    },
  ],
  app_opens_since_renewal: 3,
};

describe("triage API", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createApp({ mode: () => "fixture" }).listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("returns a minimal health response", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns a schema-valid response for a valid ticket", async () => {
    const response = await fetch(`${baseUrl}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validTicket),
    });
    expect(response.status).toBe(200);
    const payload: unknown = await response.json();
    expect(triageResponseSchema.safeParse(payload).success).toBe(true);
  });

  it("escalates a benign low-confidence fixture response for human review", async () => {
    const ticket = {
      ...validTicket,
      subject: "A question about my account",
      body: "Could you explain how to use the app?",
    };
    const response = await fetch(`${baseUrl}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ticket),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.confidence).toBe(0.5);
    expect(payload.needs_human).toBe(true);
    expect(payload.refund).toMatchObject({ status: "not_applicable", amount_inr: 0 });
  });

  it("returns a consistent HTTP 400 JSON error for an invalid ticket", async () => {
    const response = await fetch(`${baseUrl}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "incomplete" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "VALIDATION_ERROR", message: "Request body does not match the ticket schema." },
    });
  });

  it("returns HTTP 400 for malformed JSON", async () => {
    const response = await fetch(`${baseUrl}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"id":',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "VALIDATION_ERROR", message: "Request body must be valid JSON." },
    });
  });

  it("returns a generic HTTP 413 for oversized JSON without exposing details", async () => {
    const oversizedTicket = { ...validTicket, body: "x".repeat(110 * 1024) };
    const response = await fetch(`${baseUrl}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(oversizedTicket),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the allowed size." },
    });
  });

  it("returns HTTP 404 for unknown routes", async () => {
    const response = await fetch(`${baseUrl}/missing`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found." } });
  });

  it("returns the same fixture result for repeated identical requests", async () => {
    const sendTicket = () =>
      fetch(`${baseUrl}/triage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validTicket),
      });
    const first = await sendTicket();
    const second = await sendTicket();
    expect(await first.json()).toEqual(await second.json());
  });

  it("runs fixture mode without model API keys", async () => {
    const keys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY"] as const;
    const previous = keys.map((key) => process.env[key]);
    const originalFetch = globalThis.fetch;
    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (!url.startsWith(baseUrl)) throw new Error("Unexpected external request in fixture mode test.");
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      for (const key of keys) delete process.env[key];
      const response = await fetch(`${baseUrl}/triage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validTicket),
      });
      expect(response.status).toBe(200);
      expect(triageResponseSchema.safeParse(await response.json()).success).toBe(true);
      expect(fetchedUrls).toEqual([`${baseUrl}/triage`]);
    } finally {
      globalThis.fetch = originalFetch;
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  });

  it("holds requested refunds for human review without assigning an amount", async () => {
    const response = await fetch(`${baseUrl}/triage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validTicket, subject: "Please refund my subscription" }),
    });
    const payload = await response.json();
    expect(payload.refund).toMatchObject({ status: "pending_review", amount_inr: 0 });
    expect(payload.needs_human).toBe(true);
  });
});
