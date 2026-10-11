import type { TicketRequest, TriageResponse } from "./schemas/triage-schema.js";

/** Deterministic keyword rules for the documented demo mode; this is not an AI classifier. */
export function createFixtureTriage(ticket: TicketRequest): TriageResponse {
  const text = `${ticket.subject} ${ticket.body}`.toLowerCase();
  const category = classifyCategory(text);
  const refundRequested =
    /\b(refund|money back|reimburse|chargeback)\b/.test(text) ||
    /\breverse (?:this )?(?:charge|transaction)\b/.test(text);
  const disputedOrUnauthorizedCharge =
    /\b(disputed|unauthorized|unrecognized|unrecognised)[\s-]+(?:credit card )?charges?\b/.test(text) ||
    /\bcharges?\s+(?:were )?(?:disputed|unauthorized|unrecognized|unrecognised)\b/.test(text);
  const renewalDispute =
    /\brenewal\b.{0,40}\b(dispute|charged|charge|refund)\b/.test(text) ||
    /\b(dispute|charged|charge|refund)\b.{0,40}\brenewal\b/.test(text);
  const stoppedAutopayButCharged = /\bstop(?:ped)? autopay\b.{0,50}\bcharged\b/.test(text);
  const hinglishPaymentActivation = /\b(paisa kat gaya|paise kat gaye|plan activate nahi hua)\b/.test(text);
  const ambiguousBilling =
    /\b(payment failed|charged twice|duplicate charge|paid but|money deducted|incorrect charge|charge dispute)\b/.test(text) ||
    disputedOrUnauthorizedCharge ||
    renewalDispute ||
    stoppedAutopayButCharged ||
    hinglishPaymentActivation ||
    ticket.purchases.some((purchase) => purchase.status === "initiated" || purchase.status === "failed");
  const refundPending = refundRequested || ambiguousBilling;
  const severe = /\b(urgent|critical|unable to access|completely broken|fraud|stolen)\b/.test(text);
  const severity = category === "fraud" || severe ? "high" : category === "feature_request" || category === "product_question" ? "low" : "medium";

  return {
    ticket_id: ticket.id,
    category,
    severity,
    refund: {
      status: refundPending ? "pending_review" : "not_applicable",
      amount_inr: 0,
      reason: refundPending
        ? "The demo rules detected a refund request or ambiguous billing signal; manual review is required."
        : "The demo rules detected no refund request or ambiguous billing signal.",
    },
    reply_draft: refundPending
      ? "This is a deterministic demo draft. A support agent should review the billing details before deciding on any refund."
      : "This is a deterministic demo draft. Thanks for contacting Dhaba; a support agent can help with your request.",
    needs_human: refundPending || category === "fraud" || severity === "high",
    confidence: 0.5,
  };
}

function classifyCategory(text: string): TriageResponse["category"] {
  if (/\b(fraud|scam|unauthorized|stolen)\b/.test(text)) return "fraud";
  if (/\b(paisa kat gaya|paise kat gaye|plan activate nahi hua|payment failed|not activated|activation)\b/.test(text)) {
    return "payment_activation";
  }
  if (/\bstop(?:ped)? autopay\b.{0,50}\bcharged\b/.test(text)) return "billing_dispute";
  if (/\brenewal\b.{0,40}\b(dispute|charged|charge|refund)\b/.test(text) || /\b(dispute|charged|charge|refund)\b.{0,40}\brenewal\b/.test(text)) {
    return "billing_dispute";
  }
  if (/\b(cancel|cancellation|unsubscribe|stop renewal)\b/.test(text)) return "cancellation";
  if (/\b(invoice|receipt|tax invoice)\b/.test(text)) return "invoice_request";
  if (/\b(feature|please add|would like to see)\b/.test(text)) return "feature_request";
  if (/\b(payment|activation|charged|charge|billing|deducted|renewal|autopay)\b/.test(text) || /\bpaisa kat gaya\b/.test(text)) {
    return "billing_dispute";
  }
  if (/\b(how do i|what is|how can i|pricing|plan)\b/.test(text)) return "product_question";
  if (/\b(error|bug|crash|unable to access|not working|sign in|login)\b/.test(text)) return "technical_issue";
  return "general_complaint";
}
