/**
 * Provider connection routes.
 *
 * This prototype has no authorised scheduling, referral or telehealth
 * integration. Rather than fake one, it does the strongest real thing
 * available: routes people to verified public destinations, and helps them
 * prepare for a conversation with their own clinician or pharmacist.
 *
 * Every destination below is a real, publicly operated service. Each was
 * checked to resolve on VERIFIED_ON. None is a partner, a sponsor, or an
 * integration — opening one of these links leaves this site.
 *
 * What is deliberately NOT here:
 *   - a provider directory with names, NPIs or availability. An NPI listing
 *     proves registration, not current licensure, not that a provider accepts
 *     new patients, and not that they take your insurance.
 *   - any "book now" flow, because nothing here can confirm an appointment.
 */

export const VERIFIED_ON = "2026-09-19";

export type ProviderIntent =
  | "existing-clinician"
  | "pharmacist"
  | "new-provider"
  | "telehealth";

export type RouteAvailability =
  /** A real external destination the user can act on. */
  | "verified-destination"
  /** No integration, but genuinely useful instructions. */
  | "guidance-only"
  /** Cannot be offered honestly at all. */
  | "unavailable";

export interface ProviderAction {
  label: string;
  detail: string;
  /** tel: or https: destination, or null for guidance the user performs. */
  href: string | null;
  /** Makes it unambiguous that a link leaves this site. */
  external: boolean;
}

export interface ProviderRoute {
  intent: ProviderIntent;
  title: string;
  /** Shown on the choice screen. */
  chooseLabel: string;
  description: string;
  availability: RouteAvailability;
  actions: ProviderAction[];
  /** What this route cannot do. Always stated. */
  limitations: string[];
  sources: Array<{ name: string; url: string; verifiedOn: string }>;
}

const MEDICARE_CARE_COMPARE = {
  name: "Medicare Care Compare (Centers for Medicare & Medicaid Services)",
  url: "https://www.medicare.gov/care-compare/",
  verifiedOn: VERIFIED_ON,
};

const HRSA_FIND_CENTER = {
  name: "Find a Health Center (Health Resources & Services Administration)",
  url: "https://findahealthcenter.hrsa.gov/",
  verifiedOn: VERIFIED_ON,
};

const FDA_MEDWATCH = {
  name: "FDA MedWatch adverse event reporting",
  url: "https://www.fda.gov/safety/medwatch-fda-safety-information-and-adverse-event-reporting-program",
  verifiedOn: VERIFIED_ON,
};

export const PROVIDER_ROUTES: ProviderRoute[] = [
  {
    intent: "existing-clinician",
    title: "Talk to the clinician you already see",
    chooseLabel: "My own doctor or prescriber",
    description:
      "The person who knows your history is the right person to answer whether this medication fits your situation. This prototype cannot contact them for you, but it can help you arrive prepared.",
    availability: "guidance-only",
    actions: [
      {
        label: "Call the number on your appointment card or member portal",
        detail:
          "Most practices will take a medication question by phone or secure message without needing a visit.",
        href: null,
        external: false,
      },
    ],
    limitations: [
      "This site cannot send a message to your clinician, book an appointment, or see your records.",
    ],
    sources: [],
  },

  {
    intent: "pharmacist",
    title: "Ask a pharmacist",
    chooseLabel: "A pharmacist",
    description:
      "Pharmacists answer medication questions without an appointment, usually free, and they can see your full medication list to check for interactions. For most questions about a medication, this is the fastest real answer.",
    availability: "guidance-only",
    actions: [
      {
        label: "Ask at the pharmacy counter where you fill prescriptions",
        detail:
          "Ask for the pharmacist rather than a technician. You can also call the pharmacy directly and ask to speak with them.",
        href: null,
        external: false,
      },
      {
        label: "Ask them to run a test claim while you are there",
        detail:
          "A pharmacy can submit a trial claim to your plan and tell you the actual amount you would pay, which no formulary document can tell you.",
        href: null,
        external: false,
      },
    ],
    limitations: [
      "This site has no connection to any pharmacy and cannot see your prescriptions.",
    ],
    sources: [],
  },

  {
    intent: "new-provider",
    title: "Find a new provider",
    chooseLabel: "I need to find a provider",
    description:
      "These are official government directories. They list registered providers and facilities, which is not the same as knowing who is accepting new patients or who takes your insurance.",
    availability: "verified-destination",
    actions: [
      {
        label: "Find a community health center",
        detail:
          "HRSA-funded health centers serve patients regardless of insurance status and charge on a sliding scale based on income.",
        href: HRSA_FIND_CENTER.url,
        external: true,
      },
      {
        label: "Medicare Care Compare",
        detail:
          "The official CMS directory of doctors, clinicians and facilities, searchable by location and specialty.",
        href: MEDICARE_CARE_COMPARE.url,
        external: true,
      },
    ],
    limitations: [
      "A directory listing does not mean a provider is accepting new patients.",
      "A directory listing does not confirm they participate in your insurance network.",
      "A listing does not confirm current licensure or appointment availability. Call to confirm before relying on it.",
    ],
    sources: [HRSA_FIND_CENTER, MEDICARE_CARE_COMPARE],
  },

  {
    intent: "telehealth",
    title: "Book a telehealth visit",
    chooseLabel: "A telehealth or booking service",
    description:
      "Not available. This prototype has no authorised scheduling or telehealth integration, so it cannot book, hold, or request an appointment on your behalf.",
    availability: "unavailable",
    actions: [
      {
        label: "Check whether your insurer offers telehealth",
        detail:
          "Many plans include a telehealth benefit at reduced or no cost. The member portal or the number on your insurance card is the place to check.",
        href: null,
        external: false,
      },
    ],
    limitations: [
      "No appointment can be created, requested or confirmed from this site.",
      "Any site that claims to have booked you an appointment without showing a confirmation from the practice has not booked you an appointment.",
    ],
    sources: [],
  },
];

export function getRoute(intent: ProviderIntent): ProviderRoute | null {
  return PROVIDER_ROUTES.find((r) => r.intent === intent) ?? null;
}

/** Reporting a suspected side effect — a real, useful public action. */
export const ADVERSE_EVENT_REPORTING = {
  title: "Report a side effect",
  description:
    "Reporting is how safety signals are found. The boxed warning on this medication exists because reports were collected and analysed.",
  actions: [
    {
      label: "FDA MedWatch",
      detail: "Report a suspected side effect directly to the FDA.",
      href: FDA_MEDWATCH.url,
      external: true,
    },
    {
      label: "Call the FDA at 1-800-FDA-1088",
      detail: "The reporting line listed in this medication's FDA label.",
      href: "tel:18003321088",
      external: false,
    },
  ] satisfies ProviderAction[],
  sources: [FDA_MEDWATCH],
};

