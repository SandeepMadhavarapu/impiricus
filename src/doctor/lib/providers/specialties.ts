/**
 * Shared vocabulary for the clinician lookup.
 *
 * Deliberately NOT server-only: the picker renders these in the browser and
 * the server validates against the same list, so a value the UI can offer is
 * exactly a value the server will accept. Two copies would drift, and the
 * drift would show up as a search that silently returns nothing.
 *
 * No lookup logic lives here. See ./clinicians for that, which is server-only
 * because it talks to the registry.
 */

/** Rendered with every result. Not optional, not removable by accident. */
export const LISTING_MEANS: readonly string[] = [
  "This is the federal provider register, not a recommendation and not a referral.",
  "Being listed does not mean a clinician is accepting new patients or takes your insurance.",
  "It does not confirm current licensure, board certification, or that they still practise here.",
  "Details are self-reported and can be out of date. Call before relying on any of it.",
];

/**
 * Specialties offered in the picker.
 *
 * Real NUCC taxonomy descriptions, spelled exactly as the registry spells them
 * - a near-miss returns nothing rather than an error. Chosen by measuring what
 * is actually populated: across ZIP codes in Virginia, New York and
 * California, Family Medicine, Internal Medicine, Nurse Practitioner,
 * Physician Assistant and Psychiatry are well covered everywhere, while
 * several specialties return zero in a given ZIP. Those are still offered,
 * because a zero is a truthful answer about a neighbourhood and the caller
 * says so plainly rather than showing an empty box.
 *
 * Family Medicine leads because primary care is a correct starting point for a
 * medication question whatever the medication, and because it has the broadest
 * coverage. The order is not clinical advice, and the list is not tailored to
 * the medication on the page: suggesting a cardiologist because someone is
 * reading about a beta blocker would be inferring a diagnosis from a page view.
 */
export const PATIENT_SPECIALTIES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "Family Medicine", label: "Family medicine" },
  { value: "Internal Medicine", label: "Internal medicine" },
  { value: "Nurse Practitioner", label: "Nurse practitioner" },
  { value: "Physician Assistant", label: "Physician assistant" },
  { value: "Pediatrics", label: "Pediatrics" },
  { value: "Cardiovascular Disease", label: "Cardiology" },
  { value: "Endocrinology, Diabetes & Metabolism", label: "Endocrinology / diabetes" },
  { value: "Pulmonary Disease", label: "Pulmonology (lungs)" },
  { value: "Allergy & Immunology", label: "Allergy & immunology" },
  { value: "Obstetrics & Gynecology", label: "Obstetrics & gynecology" },
  { value: "Psychiatry", label: "Psychiatry" },
];

/** Whether a submitted specialty is one this app actually offers. */
export function isOfferedSpecialty(value: string): boolean {
  return PATIENT_SPECIALTIES.some((s) => s.value === value);
}
