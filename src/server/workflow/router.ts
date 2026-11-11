import crypto from "node:crypto";
import type {
  AvailabilitySchedule,
  CallCategory,
  CallUrgency,
  CanonicalSlot,
  DetectedLanguage,
  ExtractedCallData,
  OfficeTicket,
  OnCallAlert,
  RecordStatus,
  RoutingActionType,
} from "../../shared/types.js";
import {
  bookRegularSlot,
  cloneSchedule,
  isSlotFree,
  proposeNearestFreeSlots,
} from "./availabilityEngine.js";

/**
 *Contextual Required-Fields Validator (Pure TypeScript).
 * Determines `missing_fields` based on call intent so:
 * - Unreachable callers flag `phone_or_email`.
 * - Single-word first names (e.g. "Sandra" or "سارة") flag `caller_last_name`.
 * - Visits (appointment_requested OR urgent OR repair/maintenance) require `address`.
 * - Pure billing inquiries without a visit do NOT falsely require a street `address`.
 * - Normal appointment requests require `preferred_slot`, whereas urgent calls never book regular slots.
 */
export function computeMissingFields(params: {
  callerName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  category: CallCategory[];
  urgency: CallUrgency;
  appointmentRequested: boolean;
  preferredSlot: CanonicalSlot | null;
}): string[] {
  const missing: string[] = [];

  if (!params.callerName) {
    missing.push("caller_name");
  } else {
    const parts = params.callerName.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      missing.push("caller_last_name");
    }
  }

  if (!params.phone && !params.email) {
    missing.push("phone_or_email");
  }

  const requiresPhysicalVisit =
    params.urgency === "urgent" ||
    params.appointmentRequested ||
    params.category.includes("repair") ||
    params.category.includes("maintenance");

  if (requiresPhysicalVisit && !params.address) {
    missing.push("address");
  }

  if (params.urgency === "normal" && params.appointmentRequested && !params.preferredSlot) {
    missing.push("preferred_slot");
  }

  return missing;
}

export interface DeterministicRouteOutcome {
  status: RecordStatus;
  outcomeHeadline: string;
  routingActions: RoutingActionType[];
  bookedSlot: CanonicalSlot | null;
  proposedSlots: CanonicalSlot[];
  nextAvailability: AvailabilitySchedule;
  shouldDraftReply: boolean;
  officeCategories: CallCategory[];
  onCallAlert: OnCallAlert | null;
  officeTicket: OfficeTicket | null;
}

/**
 * Deterministic Truth-Table Router ("Judgments from Jev, Decisions in Code").
 * Applies all 5 routing situations from Challenge Page 4 cleanly and composably.
 */
export function executeRoutingTruthTable(params: {
  extracted: ExtractedCallData;
  language: DetectedLanguage;
  hazardFlags: string[];
  currentAvailability: AvailabilitySchedule;
}): DeterministicRouteOutcome {
  const { extracted, language, hazardFlags } = params;
  let nextAvailability = cloneSchedule(params.currentAvailability);

  const reachable = Boolean(extracted.phone || extracted.email);
  const routingActions: RoutingActionType[] = [];
  const officeCategories = extracted.category.filter(
    (c): c is CallCategory => c === "quote" || c === "billing"
  );

  let status: RecordStatus = "needs_review";
  let bookedSlot: CanonicalSlot | null = null;
  let proposedSlots: CanonicalSlot[] = [];
  let onCallAlert: OnCallAlert | null = null;
  let officeTicket: OfficeTicket | null = null;
  const headlineParts: string[] = [];

  // Rule 1: Urgent case -> ALWAYS notify on-call immediately, NEVER book a regular slot
  if (extracted.urgency === "urgent") {
    routingActions.push("notify_on_call");
    onCallAlert = {
      alert_id: `ALERT-${extracted.call_id}-${crypto.randomUUID().slice(0, 6)}`,
      call_id: extracted.call_id,
      created_at: new Date().toISOString(),
      caller_name: extracted.caller_name,
      phone: extracted.phone,
      address: extracted.address,
      hazard_flags: hazardFlags.length > 0 ? hazardFlags : ["urgent_escalation"],
      summary: extracted.summary,
      language,
    };

    if (!reachable || extracted.missing_fields.length > 0) {
      status = "needs_review";
      routingActions.push("flag_needs_review");
      headlineParts.push(
        `On-Call alerted immediately; flagged needs_review (missing: ${extracted.missing_fields.join(", ")})`
      );
    } else {
      status = "escalated_urgent";
      headlineParts.push("Escalated immediately to On-Call Team (regular slot bypassed)");
    }
  }
  // Rule 2: No way to reach caller -> needs_review, no reply draft
  else if (!reachable) {
    status = "needs_review";
    routingActions.push("flag_needs_review", "suppress_reply_unreachable");
    headlineParts.push(
      `Needs human review — caller unreachable (missing: ${extracted.missing_fields.join(", ")})`
    );
  }
  // Rule 3: Reachable, but required fields missing -> needs_review, do NOT book prematurely
  else if (extracted.missing_fields.length > 0) {
    status = "needs_review";
    routingActions.push("flag_needs_review");
    headlineParts.push(
      `Needs review — missing required info (${extracted.missing_fields.join(", ")}); follow-up reply drafted`
    );
  }
  // Rule 4: Normal appointment requested with complete fields -> check availability
  else if (extracted.appointment_requested && extracted.preferred_slot) {
    if (isSlotFree(nextAvailability, extracted.preferred_slot)) {
      nextAvailability = bookRegularSlot({
        schedule: nextAvailability,
        slot: extracted.preferred_slot,
        callId: extracted.call_id,
        callerName: extracted.caller_name,
      });
      bookedSlot = extracted.preferred_slot;
      status = "booked";
      routingActions.push("book_slot");
      headlineParts.push(`Booked free slot: ${extracted.preferred_slot}`);
    } else {
      proposedSlots = proposeNearestFreeSlots(nextAvailability, extracted.preferred_slot, 2);
      status = "awaiting_slot_choice";
      routingActions.push("propose_nearest_slots");
      headlineParts.push(
        `${extracted.preferred_slot} taken — proposed ${proposedSlots.join(" & ") || "office callback"}`
      );
    }
  }
  // Rule 5: Non-appointment complete call (e.g. pure billing or quote inquiry)
  else if (officeCategories.length > 0) {
    status = "forwarded_to_office";
  } else {
    status = "needs_review";
    routingActions.push("flag_needs_review");
    headlineParts.push("Routed to operator review (no actionable booking or office category)");
  }

  // Additive Rule: Quote or Billing -> ALWAYS forward to Office Queue with summary
  if (officeCategories.length > 0) {
    routingActions.push("forward_office_queue");
    officeTicket = {
      ticket_id: `OFF-${extracted.call_id}-${crypto.randomUUID().slice(0, 6)}`,
      call_id: extracted.call_id,
      created_at: new Date().toISOString(),
      categories: officeCategories,
      caller_name: extracted.caller_name,
      contact: extracted.email ?? extracted.phone,
      summary: extracted.summary,
      linked_booking: bookedSlot,
    };
    headlineParts.push(`Forwarded [${officeCategories.join(", ")}] summary to Office Queue`);
  }

  if (!reachable && !routingActions.includes("suppress_reply_unreachable")) {
    routingActions.push("suppress_reply_unreachable");
  }

  return {
    status,
    outcomeHeadline: headlineParts.join(" · "),
    routingActions,
    bookedSlot,
    proposedSlots,
    nextAvailability,
    shouldDraftReply: reachable,
    officeCategories,
    onCallAlert,
    officeTicket,
  };
}
