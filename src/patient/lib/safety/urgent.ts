/**
 * Urgent-situation detection.
 *
 * This runs BEFORE retrieval and before any model call. If someone is
 * describing a crisis, they get help immediately — not after a provider form,
 * not after an insurance check, not after a paragraph of label text.
 *
 * Design note on false positives. This medication's boxed warning is about
 * suicidal thoughts and behavior, so people will legitimately ask informational
 * questions like "can it cause suicidal thoughts?". Blocking those with a
 * crisis interstitial would be both unhelpful and patronising. So detection is
 * tiered:
 *
 *   crisis      - first-person, present-tense statements of intent or ideation,
 *                 or a reported overdose. Answered with help resources only.
 *   urgent      - symptoms happening now that need emergency care.
 *   informational - "does it cause X" questions. Answered normally from the
 *                 label, with crisis resources shown alongside rather than
 *                 instead.
 */

export type UrgencyLevel = "crisis" | "urgent" | "none";

export type UrgencyKind =
  | "self-harm"
  | "overdose"
  | "severe-allergic-reaction"
  | "severe-breathing"
  | null;

export interface UrgencyAssessment {
  level: UrgencyLevel;
  kind: UrgencyKind;
  /** Region whose emergency numbers were used. */
  region: "US" | "unknown";
  /** True when the message merely asks *about* a serious risk. */
  informationalAboutRisk: boolean;
}

export interface UrgentResource {
  label: string;
  detail: string;
  /** tel: / sms: / https: destination, or null for guidance-only entries. */
  href: string | null;
  emphasis: "critical" | "normal";
}

/**
 * First-person present-tense self-harm indicators. Deliberately narrow.
 * "can it cause suicidal thoughts" must NOT match; "i am having suicidal
 * thoughts" must.
 */
const SELF_HARM_PATTERNS: RegExp[] = [
  /\bi\s+(want|wanna|plan|intend)\s+to\s+(die|kill\s+myself|end\s+(it|my\s+life))/i,
  /\bi(?:'m|\s+am)?\s+(?:am\s+)?(?:thinking|think)\s+about\s+(?:killing\s+myself|suicide|ending\s+(?:it|my\s+life))/i,
  /\bi(?:'m|\s+am)\s+(?:having|experiencing)\s+(?:suicidal|self[-\s]?harm)/i,
  /\bi\s+(?:have|'ve\s+been\s+having|am\s+having)\s+(?:thoughts\s+of\s+)?(?:suicidal\s+thoughts|killing\s+myself)/i,
  /\bi\s+don'?t\s+want\s+to\s+(?:be\s+alive|live\s+anymore|live\s+any\s+more)/i,
  /\bi\s+(?:feel\s+like\s+)?(?:want\s+to\s+)?hurt(?:ing)?\s+myself/i,
  /\b(?:my|our)\s+(?:child|son|daughter|kid|teen)\s+(?:is\s+)?(?:talking\s+about|threatening)\s+suicide/i,
  /\bgoing\s+to\s+kill\s+myself/i,
];

/** A dose was actually taken in excess — not a question about overdose in general. */
const OVERDOSE_PATTERNS: RegExp[] = [
  /\b(i|he|she|they|my\s+\w+)\s+(took|swallowed|had|ate)\s+(too\s+many|too\s+much|\d+\s+(?:tablets|pills|doses)|the\s+whole\s+(?:bottle|pack))/i,
  /\b(i|he|she|they)\s+(?:accidentally\s+)?(?:double[-\s]?dosed|overdosed)/i,
  /\btook\s+(?:an\s+)?extra\s+(?:\d+\s+)?(?:tablets?|pills?|doses?)\b.*\b(what|should|worried|help|scared)/i,
  /\b(?:my\s+)?(?:child|kid|toddler|son|daughter)\s+(?:got\s+into|ate|swallowed)\b/i,
];

/** Symptoms of a severe allergic reaction happening now. */
const ANAPHYLAXIS_PATTERNS: RegExp[] = [
  /\b(?:my|his|her|their)?\s*(?:face|lips|tongue|throat)\s+(?:is|are|started)\s+swell/i,
  /\bswelling\s+of\s+(?:my|the|his|her)\s+(?:face|lips|tongue|throat)/i,
  /\b(?:can'?t|cannot|trouble|difficulty)\s+(?:breathe|breathing|swallow|swallowing)\b/i,
  /\b(?:i|he|she|they)\s+(?:have|has|am\s+having|is\s+having)\s+(?:hives|anaphylaxis)\b/i,
  /\bthroat\s+(?:is\s+)?closing\b/i,
];

/** Severe asthma symptoms happening now. */
const SEVERE_BREATHING_PATTERNS: RegExp[] = [
  /\b(?:i|he|she|they)\s+(?:am|is|are)\s+having\s+(?:an?\s+)?(?:bad\s+)?asthma\s+attack\b/i,
  /\b(?:inhaler|rescue\s+inhaler)\s+(?:is\s+)?not\s+(?:working|helping)\b/i,
  /\bstruggling\s+to\s+breathe\b/i,
  /\blips\s+(?:are\s+)?(?:turning\s+)?blue\b/i,
];

/** Informational questions about a serious risk — answered, not intercepted. */
const INFORMATIONAL_RISK_PATTERNS: RegExp[] = [
  /\b(?:can|does|could|will|is\s+it\s+true\s+that)\b.*\b(?:cause|lead\s+to|linked\s+to|associated\s+with|trigger)\b/i,
  /\b(?:what|any)\b.*\b(?:side\s+effects?|risks?|warnings?)\b/i,
  /\bhow\s+(?:common|often|likely)\b/i,
  /\bwhy\s+(?:does|is)\b/i,
];

function anyMatch(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Assesses a user message for urgency.
 *
 * `text` is untrusted input. It is only pattern-matched here; it is never
 * interpreted as instructions.
 */
export function assessUrgency(text: string, region: "US" | "unknown" = "US"): UrgencyAssessment {
  const t = text.slice(0, 4000);
  const informational = anyMatch(INFORMATIONAL_RISK_PATTERNS, t);

  if (anyMatch(SELF_HARM_PATTERNS, t)) {
    return { level: "crisis", kind: "self-harm", region, informationalAboutRisk: informational };
  }
  if (anyMatch(OVERDOSE_PATTERNS, t)) {
    return { level: "crisis", kind: "overdose", region, informationalAboutRisk: informational };
  }
  if (anyMatch(ANAPHYLAXIS_PATTERNS, t)) {
    return {
      level: "urgent",
      kind: "severe-allergic-reaction",
      region,
      informationalAboutRisk: informational,
    };
  }
  if (anyMatch(SEVERE_BREATHING_PATTERNS, t)) {
    return {
      level: "urgent",
      kind: "severe-breathing",
      region,
      informationalAboutRisk: informational,
    };
  }
  return { level: "none", kind: null, region, informationalAboutRisk: informational };
}

/**
 * Verified public emergency destinations (United States).
 *
 * These are real, publicly operated services. Nothing here is a partner,
 * an integration, or a service this prototype connects to.
 */
export const US_RESOURCES = {
  emergency: {
    label: "Call 911",
    detail: "For a medical emergency in the United States.",
    href: "tel:911",
    emphasis: "critical" as const,
  },
  poison: {
    label: "Poison Help: 1-800-222-1222",
    detail:
      "Free, confidential, 24/7 guidance from the U.S. Poison Control Centers, including for a medication taken in excess.",
    href: "tel:18002221222",
    emphasis: "critical" as const,
  },
  crisisCall: {
    label: "Call or text 988",
    detail:
      "988 Suicide & Crisis Lifeline. Free and confidential, 24/7, across the United States.",
    href: "tel:988",
    emphasis: "critical" as const,
  },
  crisisText: {
    label: "Text HOME to 741741",
    detail: "Crisis Text Line, if you would rather text than talk.",
    href: "sms:741741?&body=HOME",
    emphasis: "normal" as const,
  },
} satisfies Record<string, UrgentResource>;

export interface UrgentGuidance {
  heading: string;
  body: string[];
  resources: UrgentResource[];
  /** Whether the assistant should also answer the underlying question. */
  continueToAnswer: boolean;
}

export function urgentGuidance(assessment: UrgencyAssessment): UrgentGuidance | null {
  if (assessment.level === "none") return null;

  switch (assessment.kind) {
    case "self-harm":
      return {
        heading: "Please get support right now",
        body: [
          "If you are thinking about harming yourself, you deserve immediate support from a real person, not a web page.",
          "If you are in immediate danger, call 911.",
        ],
        resources: [US_RESOURCES.crisisCall, US_RESOURCES.crisisText, US_RESOURCES.emergency],
        continueToAnswer: false,
      };
    case "overdose":
      return {
        heading: "Contact Poison Control now",
        body: [
          "If more of this medication was taken than prescribed, contact Poison Control immediately. Do not wait for symptoms to appear.",
          "If the person is unconscious, having a seizure, or having trouble breathing, call 911 first.",
        ],
        resources: [US_RESOURCES.poison, US_RESOURCES.emergency],
        continueToAnswer: false,
      };
    case "severe-allergic-reaction":
      return {
        heading: "This may be a medical emergency",
        body: [
          "Swelling of the face, lips, tongue or throat, or trouble breathing or swallowing, can be a severe allergic reaction. Call 911 now.",
          "Do not wait to see whether it improves on its own.",
        ],
        resources: [US_RESOURCES.emergency],
        continueToAnswer: false,
      };
    case "severe-breathing":
      return {
        heading: "Trouble breathing needs emergency care",
        body: [
          "Use your rescue inhaler if you have one and follow your asthma action plan. If breathing does not improve quickly, or is getting worse, call 911.",
          "This medication is not a rescue medication and does not relieve an asthma attack in progress.",
        ],
        resources: [US_RESOURCES.emergency],
        continueToAnswer: false,
      };
    default:
      return null;
  }
}

/**
 * Crisis resources shown alongside — not instead of — an answer, when someone
 * asks informationally about this medication's neuropsychiatric risks.
 */
export function shouldOfferCrisisFooter(text: string): boolean {
  return /\b(suicid|self[-\s]?harm|depress|kill\s+myself|mental\s+health|mood|behavio)/i.test(text);
}
