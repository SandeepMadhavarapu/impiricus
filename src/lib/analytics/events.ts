/**
 * Minimal awareness measurement.
 *
 * What we want to know: does a shared link lead to someone learning something
 * and taking a real next step?
 *
 * What we must never collect: chat text, insurance details, health information,
 * or anything that links a person to an interest in a specific medication.
 *
 * Event names are an allow-list and properties are whitelisted per event. An
 * unknown event or an unexpected property is dropped rather than forwarded.
 */

export const ANALYTICS_EVENTS = [
  "medication_page_opened",
  "learn_more_opened",
  "share_initiated",
  "share_dismissed",
  "share_fallback_used",
  "qr_shown",
  "provider_cta_clicked",
  "provider_route_selected",
  "coverage_flow_started",
  "coverage_flow_completed",
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

/**
 * Properties each event may carry. Everything is low-cardinality and
 * non-identifying. Note there is no medication slug on any event: pairing a
 * person with a specific drug is exactly the linkage to avoid.
 */
const ALLOWED_PROPERTIES: Record<AnalyticsEvent, readonly string[]> = {
  medication_page_opened: ["referrer_kind"],
  learn_more_opened: [],
  share_initiated: ["method"],
  share_dismissed: ["method"],
  share_fallback_used: ["method"],
  qr_shown: [],
  provider_cta_clicked: [],
  provider_route_selected: ["intent"],
  coverage_flow_started: [],
  coverage_flow_completed: ["evidence_state"],
};

/** Values permitted for each property. Anything else is dropped. */
const ALLOWED_VALUES: Record<string, readonly string[]> = {
  referrer_kind: ["direct", "qr", "external"],
  method: ["web-share", "clipboard", "manual"],
  intent: ["existing-clinician", "pharmacist", "new-provider", "telehealth"],
  evidence_state: [
    "member-benefit-response",
    "formulary-listed",
    "restrictions-indicated",
    "not-listed-on-checked-formulary",
    "unable-to-verify",
  ],
};

export interface SanitizedEvent {
  event: AnalyticsEvent;
  properties: Record<string, string>;
}

export function isAnalyticsEvent(name: string): name is AnalyticsEvent {
  return (ANALYTICS_EVENTS as readonly string[]).includes(name);
}

/**
 * Sanitises an inbound event.
 *
 * Returns null for anything not explicitly permitted. This is deliberately a
 * whitelist: a future contributor adding a "question_text" property gets it
 * silently dropped rather than accidentally shipping chat content to analytics.
 */
export function sanitizeEvent(name: string, properties: unknown): SanitizedEvent | null {
  if (!isAnalyticsEvent(name)) return null;

  const allowed = ALLOWED_PROPERTIES[name];
  const out: Record<string, string> = {};

  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      if (!allowed.includes(key)) continue;
      if (typeof value !== "string") continue;
      const permitted = ALLOWED_VALUES[key];
      if (permitted && !permitted.includes(value)) continue;
      out[key] = value;
    }
  }

  return { event: name, properties: out };
}

/**
 * Naming guard used by tests: no event may describe a share as delivered or a
 * provider click as a booked appointment.
 */
export const FORBIDDEN_EVENT_SEMANTICS = [
  "delivered",
  "received",
  "opened_by_recipient",
  "appointment_booked",
  "appointment_confirmed",
  "coverage_confirmed",
  "airdrop",
  "quick_share",
];
