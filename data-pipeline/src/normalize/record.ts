import { resolveProduct, type ProductSpec } from "../identity/resolve.js";
import { enforcementForProduct, drugsFdaByApplication } from "../sources/openfda.js";
import { getSplHistory } from "../sources/dailymed.js";
import { countTables, walkSections } from "./spl.js";
import { scopeSections, applicabilityCounts } from "./applicability.js";
import { buildInteractionEvidence, type InteractionEvidence } from "./interactions.js";
import { buildRecallEvidence, type RecallEvidence } from "./recalls.js";
import { matchApprovalProduct, volumeFromRxNormName } from "../identity/approval.js";
import {
  absent,
  PARSER_VERSION,
  SCHEMA_VERSION,
  type Conflict,
  type MedicationRecord,
} from "../schemas/index.js";

/**
 * Assembles a MedicationRecord from resolved evidence.
 *
 * Nothing here invents a value. Every branch either carries a traced fact or an
 * explicit absence reason, and a product that did not resolve to a
 * verified-match is marked `blocked` rather than exported as if it had.
 */

export async function buildRecord(
  spec: ProductSpec,
  force = false
): Promise<MedicationRecord> {
  const { resolution, inputs } = await resolveProduct(spec, force);
  const { spl, splProduct, rxnorm, ndcEntry } = inputs;
  const conflicts: Conflict[] = [];

  /* --- conflict detection ---------------------------------------------- */

  // Strength disagreement between the harmonized block and the SPL is the
  // Toprol XL case: openfda.rxcui on a 50 mg product points at 100/200 mg
  // concepts. Detect it explicitly rather than letting one side win.
  if (rxnorm && splProduct?.activeIngredients?.[0]) {
    const splStrength = Number(splProduct.activeIngredients[0].numeratorValue);
    const rxNameHasStrength = rxnorm.concept.name.match(/([\d.]+)\s*MG/i);
    const rxStrength = rxNameHasStrength ? Number(rxNameHasStrength[1]) : null;
    if (rxStrength !== null && Number.isFinite(splStrength) && rxStrength !== splStrength) {
      conflicts.push({
        field: "identity.strength",
        claims: [
          {
            value: `${splStrength} ${splProduct.activeIngredients[0].numeratorUnit}`,
            sourceId: "dailymed",
            sourceEffectiveDate: spl?.effectiveDate ?? null,
            sourceVersion: spl?.splVersion ?? null,
            rawPath: inputs.provenance.find((p) => p.sourceId === "dailymed")?.rawPath ?? "",
          },
          {
            value: `${rxStrength} mg (from RxNorm concept "${rxnorm.concept.name}")`,
            sourceId: "rxnav",
            sourceEffectiveDate: null,
            sourceVersion: null,
            rawPath: inputs.provenance.find((p) => p.sourceId === "rxnav")?.rawPath ?? "",
          },
        ],
        assessment: "identity-mismatch",
        blocksExport: true,
        note:
          "The RxNorm concept strength does not match the SPL product strength. This usually means the " +
          "RXCUI was inherited from a harmonized block covering several strengths. The record is blocked " +
          "rather than published with a strength we cannot attribute.",
      });
    }
  }

  // Dosage form disagreement between the NDC directory and the SPL.
  if (ndcEntry?.dosage_form && splProduct?.formDisplay) {
    const a = ndcEntry.dosage_form.toLowerCase();
    const b = splProduct.formDisplay.toLowerCase();
    if (a !== b) {
      conflicts.push({
        field: "identity.dosageForm",
        claims: [
          {
            value: ndcEntry.dosage_form,
            sourceId: "openfda",
            sourceEffectiveDate: null,
            sourceVersion: null,
            rawPath: inputs.provenance.find((p) => p.sourceId === "openfda")?.rawPath ?? "",
          },
          {
            value: splProduct.formDisplay,
            sourceId: "dailymed",
            sourceEffectiveDate: spl?.effectiveDate ?? null,
            sourceVersion: spl?.splVersion ?? null,
            rawPath: inputs.provenance.find((p) => p.sourceId === "dailymed")?.rawPath ?? "",
          },
        ],
        assessment: "genuine-disagreement",
        blocksExport: false,
        note:
          "NDC directory and SPL render the dose form differently. Both are retained; the SPL value is " +
          "used for display because it is the labeling document of record.",
      });
    }
  }

  /* --- approval, product-scoped ---------------------------------------- */

  let approval: MedicationRecord["approval"] = absent(
    "not-retrieved",
    "No application number was available to query Drugs@FDA."
  );
  /** How the product within the application was selected, or why it was not. */
  let approvalEvidence: string[] = [];

  const appNumber = resolution.identity.applicationNumber;
  if (appNumber) {
    try {
      const res = await drugsFdaByApplication(appNumber, force);
      const app = res.applications[0];
      if (!app) {
        approval = absent("not-present-in-source", `No Drugs@FDA record for ${appNumber}.`);
      } else {
        // Package volume from the RxNorm concept name is what separates two
        // presentations that share a concentration.
        const packageVolume = volumeFromRxNormName(rxnorm?.concept.name ?? null);
        const strength = resolution.identity.strength[0];
        const match = matchApprovalProduct(app, {
          strengthValue: strength?.numeratorValue ?? 0,
          strengthUnit: strength?.numeratorUnit ?? "",
          denominatorUnit: strength?.denominatorUnit ?? null,
          dosageForm: resolution.identity.dosageForm,
          route: resolution.identity.route[0] ?? null,
          packageVolume,
        });

        if (match.kind === "exact") {
          const matched = match.product;
          approval = {
            present: true,
            applicationNumber: app.application_number,
            sponsorName: app.sponsor_name ?? null,
            matchedProduct: {
              productNumber: matched.product_number,
              strength: matched.active_ingredients?.[0]?.strength ?? "",
              dosageForm: matched.dosage_form ?? "",
              route: matched.route ?? null,
              marketingStatus: matched.marketing_status ?? null,
            },
            otherProductsInApplication: match.others.map((o) => ({
              productNumber: o.productNumber,
              strength: o.strength,
              dosageForm: o.dosageForm,
            })),
            submissions: (app.submissions ?? []).map((sub) => ({
              type: sub.submission_type ?? "",
              number: sub.submission_number ?? "",
              status: sub.submission_status ?? null,
              date: sub.submission_status_date ?? null,
            })),
            provenance: res.provenance,
          };
          approvalEvidence = match.evidence;
        } else if (match.kind === "ambiguous") {
          approval = absent("ambiguous-applicability", match.reason);
          approvalEvidence = match.candidates.map(
            (c) => `candidate product ${c.productNumber}: ${c.strength} (${c.marketingStatus ?? "status unknown"}) - ${c.why}`
          );
        } else {
          approval = absent("not-present-in-source", match.reason);
          approvalEvidence = match.candidates.map(
            (c) => `product ${c.productNumber}: ${c.strength} ${c.dosageForm}`
          );
        }
      }
    } catch (err) {
      approval = absent("retrieval-failed", String(err));
    }
  }

  /* --- supplemental: recalls ------------------------------------------- */

  let enforcement: MedicationRecord["supplemental"]["enforcement"];
  let recallEvidence: RecallEvidence | null = null;
  try {
    const res = await enforcementForProduct(
      resolution.identity.genericName,
      resolution.identity.productNdc,
      force
    );
    recallEvidence = buildRecallEvidence(res.raw as never[], resolution.identity);
    enforcement =
      res.records.length > 0
        ? {
            present: true,
            note:
              `Discovered by generic name. ${recallEvidence.verified.length} verified as this product, ` +
              `${recallEvidence.candidates.length} unverified candidate(s). ` +
              "Only entries in the verified tier are recalls of this exact product. Not patient-facing.",
            records: recallEvidence.verified.concat(recallEvidence.candidates).map((c) => ({
              recallNumber: c.recallNumber,
              status: c.status,
              classification: c.classification,
              reason: c.reason,
              reportDate: c.reportDate,
              productDescription: c.productDescription,
              matchedOnNdc: c.tier !== "discovery-candidate",
            })),
            provenance: res.provenance,
          }
        : absent("not-present-in-source", "No enforcement records matched this generic name.");
  } catch (err) {
    enforcement = absent("retrieval-failed", String(err));
  }

  /* --- label ------------------------------------------------------------ */

  if (!spl) {
    throw new Error(
      `Cannot build a record for ${spec.productKey}: no SPL was retrieved. ` +
        `Failures: ${inputs.failures.map((f) => `${f.sourceId}: ${f.detail}`).join("; ") || "none reported"}`
    );
  }

  let dailyMedPublishedDate: string | null = null;
  try {
    const hist = await getSplHistory(spl.setId, force);
    dailyMedPublishedDate = hist.history[0]?.publishedDate ?? null;
  } catch {
    dailyMedPublishedDate = null;
  }

  /* --- readiness -------------------------------------------------------- */

  const blocking = conflicts.filter((c) => c.blocksExport);
  const readiness: MedicationRecord["readiness"] =
    resolution.state !== "verified-match" || blocking.length > 0
      ? "blocked"
      : walkSections(spl.sections).length < 5
        ? "partial"
        : "app-ready";

  // Scope every section against the product set before export. Sections the
  // document does not scope stay "document-level-unresolved" and must not be
  // presented as product-specific dosing.
  const scopedSections = splProduct
    ? scopeSections(spl.sections, { selected: splProduct, allProducts: spl.products })
    : spl.sections;
  const scopedPatient = splProduct
    ? scopeSections(spl.patientLabeling, { selected: splProduct, allProducts: spl.products })
    : spl.patientLabeling;

  const interactions = buildInteractionEvidence(scopedSections);

  return {
    schemaVersion: SCHEMA_VERSION,
    productKey: spec.productKey,
    resolution,
    identity: resolution.identity,
    approvalEvidence,
    interactions,
    recalls: recallEvidence,
    applicability: applicabilityCounts(scopedSections),
    label: {
      splSetId: spl.setId,
      splVersion: spl.splVersion,
      splEffectiveDate: spl.effectiveDate,
      dailyMedPublishedDate,
      documentTitle: spl.title,
      productsInDocument: spl.products.map(
        (p) =>
          `${p.name ?? "?"} ${p.activeIngredients[0]?.numeratorValue ?? "?"}${p.activeIngredients[0]?.numeratorUnit ?? ""} ${p.formDisplay ?? ""} (NDC ${p.ndc ?? "?"})`
      ),
      sections: scopedSections,
      patientLabeling: scopedPatient,
      provenance: inputs.provenance.filter((p) => p.sourceId === "dailymed"),
    },
    rxnorm: rxnorm
      ? {
          present: true,
          rxcui: rxnorm.concept.rxcui,
          tty: rxnorm.concept.tty,
          name: rxnorm.concept.name,
          isCurrent: rxnorm.isCurrent,
          status: rxnorm.status,
          related: rxnorm.related,
          ndc11: rxnorm.ndc11,
          provenance: rxnorm.provenance,
        }
      : absent("not-retrieved", "No RXCUI could be established for this product."),
    approval,
    supplemental: { enforcement },
    conflicts,
    readiness,
    clinicalReview: {
      reviewed: false,
      reviewedAt: null,
      reviewedBy: null,
      note:
        "No clinician has reviewed this record. 'app-ready' means structurally consumable, NOT clinically approved.",
    },
    ingestedAt: new Date().toISOString(),
    parserVersion: PARSER_VERSION,
  };
}

/** Summary used by the completeness report. */
export function summarize(record: MedicationRecord) {
  return {
    productKey: record.productKey,
    resolutionState: record.resolution.state,
    readiness: record.readiness,
    sectionsTop: record.label.sections.length,
    sectionsTotal: walkSections(record.label.sections).length,
    tables: countTables(record.label.sections),
    patientDocs: record.label.patientLabeling.length,
    productsInDocument: record.label.productsInDocument.length,
    rxnorm: record.rxnorm.present ? record.rxnorm.rxcui : `absent (${record.rxnorm.reason})`,
    approval: record.approval.present
      ? `${record.approval.applicationNumber} product ${record.approval.matchedProduct.productNumber}`
      : `absent (${record.approval.reason})`,
    conflicts: record.conflicts.length,
    blockingConflicts: record.conflicts.filter((c) => c.blocksExport).length,
  };
}
