import { z } from "zod";

const isoTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .superRefine((timestamp, context) => {
    const offsetPart = /([+-])(\d{2}):(\d{2})$/.exec(timestamp);
    if (offsetPart) {
      const offsetHours = Number(offsetPart[2]);
      const offsetMinutes = Number(offsetPart[3]);
      if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Timestamp must contain a valid ISO 8601 timezone offset.",
        });
      }
    }

    const datePart = /^(\d{4})-(\d{2})-(\d{2})T/.exec(timestamp);
    if (!datePart) return;

    const [, yearText, monthText, dayText] = datePart;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

    if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Timestamp must contain a valid calendar date.",
      });
    }
  });

export const purchaseSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["trial", "renewal"]),
  amount_inr: z.number().int().nonnegative(),
  status: z.enum(["initiated", "failed", "successful"]),
  at: isoTimestampSchema,
});

export const ticketRequestSchema = z.object({
  id: z.string().min(1),
  received_at: isoTimestampSchema,
  subject: z.string().min(1),
  body: z.string().min(1),
  purchases: z.array(purchaseSchema),
  app_opens_since_renewal: z.number().int().nonnegative(),
});

export const refundSchema = z
  .object({
    status: z.enum(["not_applicable", "not_eligible", "pending_review", "approved"]),
    amount_inr: z.number().int().nonnegative(),
    reason: z.string().min(1),
  })
  .superRefine((refund, context) => {
    if (refund.status === "approved" && refund.amount_inr === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount_inr"],
        message: "Approved refunds must have a positive amount.",
      });
    }

    if (refund.status !== "approved" && refund.amount_inr !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount_inr"],
        message: "Refund amount must be zero unless status is approved.",
      });
    }
  });

export const triageResponseSchema = z.object({
  ticket_id: z.string().min(1),
  category: z.enum([
    "billing_dispute",
    "payment_activation",
    "technical_issue",
    "cancellation",
    "feature_request",
    "fraud",
    "invoice_request",
    "product_question",
    "general_complaint",
  ]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  refund: refundSchema,
  reply_draft: z.string().min(1),
  needs_human: z.boolean(),
  confidence: z.number().min(0).max(1),
});

export type Purchase = z.infer<typeof purchaseSchema>;
export type TicketRequest = z.infer<typeof ticketRequestSchema>;
export type Refund = z.infer<typeof refundSchema>;
export type TriageResponse = z.infer<typeof triageResponseSchema>;
