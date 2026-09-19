/**
 * Official next steps, as published.
 *
 * Every entry here was read from the document it cites. Nothing is inferred
 * from what a process "usually" looks like, and no turnaround time appears
 * unless the source states it and says whom it binds.
 *
 * Each template carries the literal content; the policy builder attaches the
 * retrieval evidence (hash, retrieval date, link-check result) so that a
 * citation always reflects an actual retrieval rather than this file.
 *
 * Two markets are covered, and they are covered at different scopes:
 *
 *   MEDICARE PART D  The coverage-determination and appeal process is set by
 *     federal regulation and CMS publishes model forms for it. The process
 *     therefore applies to every Part D plan, which is why these actions are
 *     scoped `verified-for-this-market-segment` rather than to one plan. What
 *     it does NOT give is a plan's own clinical criteria - those live in
 *     insurer documents and are not included.
 *
 *   VIRGINIA MEDICAID FEE-FOR-SERVICE  The state publishes its service
 *     authorization, appeal and emergency-supply policies directly. These do
 *     not apply to Virginia Medicaid MANAGED CARE plans, which publish their
 *     own.
 */

import type { AccessAction } from "../schemas/access.js";

type Actor = AccessAction["actor"];
type ActionBasis = AccessAction["basis"];

/** An action minus the provenance, which is attached at build time. */
export interface AccessActionTemplate {
  id: string;
  actor: Actor;
  basis: ActionBasis;
  action: string;
  formType?: AccessAction["formType"];
  routeApplicability?: AccessAction["routeApplicability"];
  formTitle?: string | null;
  formUrl?: string | null;
  submissionUrl?: string | null;
  submissionFax?: string | null;
  submissionPhone?: string | null;
  documentsMentioned?: string[];
  statedTimeframes?: Array<{ label: string; value: string; appliesTo: string }>;
  expedited?: { available: boolean; statedText: string } | null;
  /** The source's own words that back this action. */
  quotation: string;
  /** Page or section within the cited document. */
  locator: string;
  /** Which document in the source set this came from. */
  documentKey: string;
}

/* ------------------------------------------------------- Medicare Part D */

export const MEDICARE_PART_D_FORMS_URL =
  "https://www.cms.gov/medicare/appeals-grievances/prescription-drug/forms";

export const PART_D_ACTIONS: AccessActionTemplate[] = [
  {
    id: "partd-coverage-determination",
    actor: "prescriber",
    basis: "source-directed",
    action:
      "Request a coverage determination from the plan, including an exception request when the " +
      "drug is restricted or not on the formulary. CMS publishes a MODEL form for this. It is a " +
      "generic template, not this plan's form: check the plan's own materials for the form it " +
      "accepts and the address, fax or portal it wants it sent to.",
    formType: "generic-model-template",
    routeApplicability: "market-segment-standard-plan-form-may-differ",
    formTitle: "Model Coverage Determination Request Form (with instructions)",
    formUrl:
      "https://www.cms.gov/medicare/appeals-and-grievances/medprescriptdrugapplgriev/downloads/modcovdetreqform-and-instrctns-feb-2019-508-.zip",
    submissionUrl: MEDICARE_PART_D_FORMS_URL,
    documentsMentioned: [
      "Prescriber's supporting statement, where an exception is requested",
    ],
    quotation:
      "An enrollee, an enrollee's representative, or an enrollee's prescriber may use this model " +
      "form to request a coverage determination, including an exception, from a plan sponsor.",
    locator: "CMS Part D coverage determination and appeal forms page",
    documentKey: "cms-part-d-forms",
  },
  {
    id: "partd-redetermination",
    actor: "patient",
    basis: "source-directed",
    action:
      "If the plan denies the coverage determination, request a redetermination - the first level " +
      "of appeal, decided by the plan itself. The CMS model form is a generic template; the plan " +
      "may publish its own and will specify where to send it.",
    formType: "generic-model-template",
    routeApplicability: "market-segment-standard-plan-form-may-differ",
    formTitle: "Model Redetermination Request Form (with instructions)",
    formUrl:
      "https://www.cms.gov/files/zip/model-redetermination-request-form-and-instructionseff010125v508.zip",
    submissionUrl: MEDICARE_PART_D_FORMS_URL,
    quotation:
      "An enrollee, an enrollee's representative, or an enrollee's prescriber may use this model " +
      "form to request a redetermination from a plan sponsor.",
    locator: "CMS Part D coverage determination and appeal forms page",
    documentKey: "cms-part-d-forms",
  },
  {
    id: "partd-ire-reconsideration",
    actor: "patient",
    basis: "source-directed",
    action:
      "If the plan upholds its denial on redetermination, request reconsideration by the " +
      "Independent Review Entity, which is outside the plan. This level is handled by the IRE " +
      "rather than the plan, so the CMS form is the operative one.",
    formType: "generic-model-template",
    routeApplicability: "verified-for-this-plan",
    formTitle: "Request for Reconsideration of Medicare Prescription Drug Denial",
    formUrl:
      "https://www.cms.gov/files/zip/request-reconsideration-prescription-drug-denial-eff-010125.zip",
    submissionUrl: MEDICARE_PART_D_FORMS_URL,
    quotation:
      "An enrollee or an enrollee's representative may use this model form to request a " +
      "reconsideration from the Independent Review Entity.",
    locator: "CMS Part D coverage determination and appeal forms page",
    documentKey: "cms-part-d-forms",
  },
  {
    id: "partd-appoint-representative",
    actor: "patient",
    basis: "source-directed",
    action:
      "To let someone else act on the enrollee's behalf, file an Appointment of Representative " +
      "form. Required before a representative can pursue a request or appeal.",
    formType: "generic-model-template",
    routeApplicability: "verified-for-this-plan",
    formTitle: "CMS-1696 Appointment of Representative",
    formUrl: "https://www.cms.gov/medicare/cms-forms/cms-forms/cms-forms-items/cms012207",
    quotation:
      "Form CMS-1696 is used to appoint a representative to file grievances, request coverage " +
      "determinations, and file appeals.",
    locator: "CMS forms catalogue, CMS-1696",
    documentKey: "cms-1696",
  },
  {
    id: "partd-appeal-overview",
    actor: "patient",
    basis: "pipeline-suggested-navigation",
    action:
      "Read Medicare's own plain-language explanation of the appeal levels before starting. " +
      "This is our navigation suggestion, not a step any plan document directs.",
    formType: "not-a-form",
    routeApplicability: "market-segment-standard-plan-form-may-differ",
    submissionUrl: "https://www.medicare.gov/claims-appeals/how-do-i-file-an-appeal",
    quotation:
      "Medicare publishes a public explanation of how to file an appeal and what the levels are.",
    locator: "Medicare.gov appeals section",
    documentKey: "medicare-appeals",
  },
];

/* ------------------------------------------ Virginia Medicaid fee-for-service */

export const VA_AUTHORIZATIONS_URL =
  "https://www.virginiamedicaidpharmacyservices.com/provider/authorizations";

export const VA_MEDICAID_FFS_ACTIONS: AccessActionTemplate[] = [
  {
    id: "va-ffs-service-authorization",
    formType: "not-a-form",
    routeApplicability: "verified-for-this-plan",
    actor: "prescriber",
    basis: "source-directed",
    action:
      "Submit a service authorization (SA) request. Non-preferred drugs require one. Requests may " +
      "be submitted by fax, by phone, or through WebPA / e-PA.",
    submissionUrl: VA_AUTHORIZATIONS_URL,
    submissionFax: "800-932-6651",
    submissionPhone: "800-932-6648",
    expedited: {
      available: true,
      statedText: "For urgent requests, please call 800-932-6648.",
    },
    quotation:
      "Non-preferred drugs require a SA. SAs may be submitted by fax, phone or WebPA, e-PA. For " +
      "urgent requests, please call 800-932-6648.",
    locator: "page 1, General Information",
    documentKey: "va-pdl",
  },
  {
    id: "va-ffs-72-hour-supply",
    formType: "not-a-form",
    routeApplicability: "verified-for-this-plan",
    actor: "pharmacy",
    basis: "source-directed",
    action:
      "If the prescriber cannot be reached - including after hours, weekends and holidays - the " +
      "pharmacist may dispense a 72-hour supply when, in their professional judgement, the " +
      "patient's health would be compromised without it. Processing requires a phone call.",
    submissionPhone: "800-932-6648",
    quotation:
      "the pharmacist may dispense a 72-Hour Supply of the prescribed medication if the physician " +
      "is not available to consult with the pharmacist, including after hours, weekends, holidays, " +
      "and the pharmacist, in his professional judgment consistent with current standards of " +
      "practice, feels that the patient's health would be compromised without the benefit of the drug.",
    locator: "page 1",
    documentKey: "va-72-hour",
  },
  {
    id: "va-ffs-appeal",
    formType: "not-a-form",
    routeApplicability: "verified-for-this-plan",
    actor: "patient",
    basis: "source-directed",
    action:
      "If the service authorization is denied, file an appeal. A prescriber filing on the " +
      "recipient's behalf needs the recipient's explicit written authorization.",
    submissionUrl: VA_AUTHORIZATIONS_URL,
    documentsMentioned: [
      "Explicit written authorization from the recipient, if the prescriber files on their behalf",
    ],
    statedTimeframes: [
      {
        label: "Deadline to file an appeal",
        value: "30 days",
        appliesTo: "the physician or recipient filing",
      },
      {
        label: "Appeal decision",
        value: "21 days from receipt",
        appliesTo: "the Appeals division issuing an opinion",
      },
    ],
    quotation:
      "Physician/Recipient has 30 days to file an appeal, unless good cause is met for the untimely " +
      "filing of the appeal. A physician must provide explicit written authorization from the " +
      "recipient in order to file an appeal on the recipient's behalf",
    locator: "page 1, Appeal, item 1",
    documentKey: "va-appeal",
  },
  {
    id: "va-ffs-interim-supply-on-denial",
    formType: "not-a-form",
    routeApplicability: "verified-for-this-plan",
    actor: "plan-or-insurer",
    basis: "source-directed",
    action:
      "On issuing a denial, the programme itself authorises any pharmacy to dispense up to a " +
      "34-day supply, without waiting for an appeal to be filed. The patient does not need to act " +
      "for this to happen.",
    quotation:
      "At the time the Lead Pharmacist issues the PA denial, the Lead Pharmacist enters a PA in " +
      "the system that authorizes any pharmacy to dispense the prescribed amount, up to a 34-day " +
      "supply of the prescribed medication. Prime does not wait until an appeal is filed to " +
      "authorize this dispensing.",
    locator: "page 1, Process, item 2",
    documentKey: "va-appeal",
  },
];

/**
 * Documents the actions cite, with the URLs to verify.
 *
 * `documentKey` on a template points here, so a citation names a retrievable
 * document rather than a vague authority.
 */
export const ACCESS_SOURCE_DOCUMENTS: Record<
  string,
  { title: string; owner: string; url: string }
> = {
  "cms-part-d-forms": {
    title: "Medicare Part D coverage determination, exception and appeal model forms",
    owner: "Centers for Medicare & Medicaid Services",
    url: MEDICARE_PART_D_FORMS_URL,
  },
  "cms-1696": {
    title: "Form CMS-1696, Appointment of Representative",
    owner: "Centers for Medicare & Medicaid Services",
    url: "https://www.cms.gov/medicare/cms-forms/cms-forms/cms-forms-items/cms012207",
  },
  "medicare-appeals": {
    title: "How do I file an appeal?",
    owner: "Medicare.gov (U.S. Department of Health and Human Services)",
    url: "https://www.medicare.gov/claims-appeals/how-do-i-file-an-appeal",
  },
  "va-pdl": {
    title: "Virginia's Medicaid Preferred Drug List (PDL) / Common Core Formulary",
    owner: "Virginia Department of Medical Assistance Services",
    url: "https://www.virginiamedicaidpharmacyservices.com/provider/preferred-drug-list",
  },
  "va-appeal": {
    title: "Preferred Drug List (PDL) Appeal Process",
    owner: "Virginia Department of Medical Assistance Services",
    url: "https://www.virginiamedicaidpharmacyservices.com/provider/external/medicaid/vamps/doc/en-us/VAMPS_PDL_Appeal_Process.pdf",
  },
  "va-72-hour": {
    title: "Preferred Drug List (PDL) Policy on 72 Hour Supply of Prescribed Medications",
    owner: "Virginia Department of Medical Assistance Services",
    url: "https://www.virginiamedicaidpharmacyservices.com/provider/external/medicaid/vamps/doc/en-us/VAMPS_PDL_72_Hour_Supply_Policy.pdf",
  },
};
