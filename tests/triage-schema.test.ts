import { describe, expect, it } from "vitest";
import {
  ticketRequestSchema,
  triageResponseSchema,
} from "../src/schemas/triage-schema.js";

const validTicket = {
  id: "ticket-example-001",
  received_at: "2026-01-15T09:30:00+05:30",
  subject: "Unable to access my account",
  body: "The app shows an error when I try to sign in.",
  purchases: [
    {
      id: "purchase-example-001",
      type: "renewal",
      amount_inr: 499,
      status: "successful",
      at: "2026-01-14T10:00:00+05:30",
    },
  ],
  app_opens_since_renewal: 3,
};

const validResponse = {
  ticket_id: "ticket-example-001",
  category: "technical_issue",
  severity: "medium",
  refund: {
    status: "not_applicable",
    amount_inr: 0,
    reason: "No refund decision is applicable to this request.",
  },
  reply_draft: "Thanks for reporting this. We are looking into the sign-in issue.",
  needs_human: false,
  confidence: 0.8,
};

describe("ticketRequestSchema", () => {
  it("accepts a ticket with purchases", () => {
    expect(ticketRequestSchema.safeParse(validTicket).success).toBe(true);
  });

  it("accepts an empty purchases array", () => {
    expect(ticketRequestSchema.safeParse({ ...validTicket, purchases: [] }).success).toBe(true);
  });

  it.each([
    ["type", "subscription"],
    ["status", "refunded"],
  ])("rejects invalid purchase %s", (field, value) => {
    const purchase = { ...validTicket.purchases[0], [field]: value };
    expect(ticketRequestSchema.safeParse({ ...validTicket, purchases: [purchase] }).success).toBe(false);
  });

  it("rejects negative purchase amounts and app-open counts", () => {
    const negativeAmount = {
      ...validTicket,
      purchases: [{ ...validTicket.purchases[0], amount_inr: -1 }],
    };
    expect(ticketRequestSchema.safeParse(negativeAmount).success).toBe(false);
    expect(ticketRequestSchema.safeParse({ ...validTicket, app_opens_since_renewal: -1 }).success).toBe(false);
  });

  it.each([1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects invalid purchase amount %s",
    (amount_inr) => {
      const ticket = {
        ...validTicket,
        purchases: [{ ...validTicket.purchases[0], amount_inr }],
      };
      expect(ticketRequestSchema.safeParse(ticket).success).toBe(false);
    },
  );

  it("rejects missing required purchase fields", () => {
    for (const field of ["id", "type", "amount_inr", "status", "at"] as const) {
      const purchase = { ...validTicket.purchases[0] };
      delete purchase[field];
      expect(ticketRequestSchema.safeParse({ ...validTicket, purchases: [purchase] }).success).toBe(false);
    }
  });

  it("rejects missing required fields and invalid timestamps", () => {
    const { subject: _subject, ...missingSubject } = validTicket;
    expect(ticketRequestSchema.safeParse(missingSubject).success).toBe(false);
    expect(ticketRequestSchema.safeParse({ ...validTicket, received_at: "yesterday" }).success).toBe(false);
    expect(
      ticketRequestSchema.safeParse({
        ...validTicket,
        purchases: [{ ...validTicket.purchases[0], at: "2026-01-14T10:00:00" }],
      }).success,
    ).toBe(false);
    expect(ticketRequestSchema.safeParse({ ...validTicket, received_at: "2026-02-30T09:30:00+05:30" }).success).toBe(false);
    expect(ticketRequestSchema.safeParse({ ...validTicket, received_at: "2026-01-15T09:30:00+25:00" }).success).toBe(false);
  });

  it("rejects empty required ticket strings and negative app-open counts", () => {
    for (const field of ["id", "subject", "body"] as const) {
      expect(ticketRequestSchema.safeParse({ ...validTicket, [field]: "" }).success).toBe(false);
    }
    expect(
      ticketRequestSchema.safeParse({
        ...validTicket,
        purchases: [{ ...validTicket.purchases[0], id: "" }],
      }).success,
    ).toBe(false);
    expect(ticketRequestSchema.safeParse({ ...validTicket, app_opens_since_renewal: -1 }).success).toBe(false);
  });

  it("strips unknown request fields by default", () => {
    const result = ticketRequestSchema.safeParse({
      ...validTicket,
      unexpected: "extra",
      purchases: [{ ...validTicket.purchases[0], unexpected: "extra" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("unexpected");
      expect(result.data.purchases[0]).not.toHaveProperty("unexpected");
    }
  });
});

describe("triageResponseSchema", () => {
  it.each([
    "billing_dispute",
    "payment_activation",
    "technical_issue",
    "cancellation",
    "feature_request",
    "fraud",
    "invoice_request",
    "product_question",
    "general_complaint",
  ])("accepts category %s", (category) => {
    expect(triageResponseSchema.safeParse({ ...validResponse, category }).success).toBe(true);
  });

  it.each(["low", "medium", "high", "critical"])("accepts severity %s", (severity) => {
    expect(triageResponseSchema.safeParse({ ...validResponse, severity }).success).toBe(true);
  });

  it.each([
    ["category", "other"],
    ["severity", "urgent"],
  ])("rejects invalid %s values", (field, value) => {
    expect(triageResponseSchema.safeParse({ ...validResponse, [field]: value }).success).toBe(false);
  });

  it("rejects missing required triage response fields", () => {
    for (const field of [
      "ticket_id",
      "category",
      "severity",
      "refund",
      "reply_draft",
      "needs_human",
      "confidence",
    ] as const) {
      const response = { ...validResponse };
      delete response[field];
      expect(triageResponseSchema.safeParse(response).success).toBe(false);
    }
  });

  it("rejects empty required response and refund strings", () => {
    expect(triageResponseSchema.safeParse({ ...validResponse, ticket_id: "" }).success).toBe(false);
    expect(triageResponseSchema.safeParse({ ...validResponse, reply_draft: "" }).success).toBe(false);
    expect(
      triageResponseSchema.safeParse({
        ...validResponse,
        refund: { ...validResponse.refund, reason: "" },
      }).success,
    ).toBe(false);
  });

  it("rejects invalid refund status values", () => {
    expect(
      triageResponseSchema.safeParse({
        ...validResponse,
        refund: { ...validResponse.refund, status: "denied" },
      }).success,
    ).toBe(false);
  });

  it("strips unknown response fields by default", () => {
    const result = triageResponseSchema.safeParse({ ...validResponse, unexpected: "extra" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty("unexpected");
  });

  it.each(["not_applicable", "not_eligible", "pending_review", "approved"])(
    "accepts refund status %s with a consistent amount",
    (status) => {
      const amount_inr = status === "approved" ? 1 : 0;
      expect(
        triageResponseSchema.safeParse({
          ...validResponse,
          refund: { ...validResponse.refund, status, amount_inr },
        }).success,
      ).toBe(true);
    },
  );

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid confidence %s", (confidence) => {
    expect(triageResponseSchema.safeParse({ ...validResponse, confidence }).success).toBe(false);
  });

  it("rejects inconsistent refund amount and status combinations", () => {
    for (const status of ["not_applicable", "not_eligible", "pending_review"]) {
      expect(
        triageResponseSchema.safeParse({
          ...validResponse,
          refund: { ...validResponse.refund, status, amount_inr: 1 },
        }).success,
      ).toBe(false);
    }

    expect(
      triageResponseSchema.safeParse({
        ...validResponse,
        refund: { ...validResponse.refund, status: "approved", amount_inr: 0 },
      }).success,
    ).toBe(false);

    for (const amount_inr of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        triageResponseSchema.safeParse({
          ...validResponse,
          refund: { ...validResponse.refund, status: "approved", amount_inr },
        }).success,
      ).toBe(false);
    }
  });
});
