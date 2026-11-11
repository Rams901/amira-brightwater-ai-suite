import type {
  AvailabilitySchedule,
  AvailabilitySlot,
  CanonicalSlot,
} from "../../shared/types.js";
import { ALL_CANONICAL_SLOTS } from "../../shared/schemas.js";

/**
 * Pure deterministic Technician Availability Engine.
 * Arithmetic and slot adjacency belong strictly in code, never in an LLM prompt.
 */
export function cloneSchedule(schedule: AvailabilitySchedule): AvailabilitySchedule {
  return {
    note: schedule.note,
    slots: schedule.slots.map((s) => ({ ...s })),
  };
}

export function getSlotIndex(slot: CanonicalSlot): number {
  return ALL_CANONICAL_SLOTS.indexOf(slot);
}

export function findScheduleSlot(
  schedule: AvailabilitySchedule,
  slot: CanonicalSlot
): AvailabilitySlot | undefined {
  return schedule.slots.find((s) => `${s.day} ${s.period}` === slot);
}

export function isSlotFree(
  schedule: AvailabilitySchedule,
  slot: CanonicalSlot
): boolean {
  const found = findScheduleSlot(schedule, slot);
  return found?.status === "free";
}

/**
 * Books a free regular slot on a cloned copy of the availability schedule.
 * Throws if the slot is not free (guard against double-booking).
 */
export function bookRegularSlot(params: {
  schedule: AvailabilitySchedule;
  slot: CanonicalSlot;
  callId: string;
  callerName: string | null;
}): AvailabilitySchedule {
  const next = cloneSchedule(params.schedule);
  const entry = findScheduleSlot(next, params.slot);
  if (!entry || entry.status !== "free") {
    throw new Error(`Cannot book slot ${params.slot}: slot is not free.`);
  }
  entry.status = "booked";
  entry.booked_by_call_id = params.callId;
  entry.booked_caller_name = params.callerName;
  entry.updated_at = new Date().toISOString();
  return next;
}

/**
 * Computes up to `count` (default 2) chronologically nearest `"free"` slots
 * relative to `requestedSlot` WITHOUT mutating the schedule.
 * Distance is measured in half-day steps across Monday morning (0) .. Friday afternoon (9).
 * Ties break symmetrically (earlier adjacent + later adjacent, or chronological order).
 */
export function proposeNearestFreeSlots(
  schedule: AvailabilitySchedule,
  requestedSlot: CanonicalSlot,
  count = 2
): CanonicalSlot[] {
  const targetIdx = getSlotIndex(requestedSlot);
  const freeCandidates = schedule.slots
    .filter((s) => s.status === "free")
    .map((s) => {
      const canonical = `${s.day} ${s.period}` as CanonicalSlot;
      const idx = getSlotIndex(canonical);
      const distance = Math.abs(idx - targetIdx);
      return { canonical, idx, distance };
    })
    .sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.idx - b.idx;
    });

  return freeCandidates.slice(0, count).map((c) => c.canonical);
}
