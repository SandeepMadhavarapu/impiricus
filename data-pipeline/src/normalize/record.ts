import { resolveProduct, type ProductSpec } from "../identity/resolve.js";
import { enforcementForProduct, drugsFdaByApplication } from "../sources/openfda.js";
import { getSplHistory } from "../sources/dailymed.js";
import { countTables, walkSections } from "./spl.js";
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

  const appNumber = resolution.identity.applicationNumber;
  if (appNumber) {
    try {
      const res = await drugsFdaByApplication(appNumber, force);
      const app = res.applications[0];
      const matched = app?.products?.find(
        (p) => p.product_number === resolution.identity.fdaProductNumber
      );
      if (app && matched) {
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
          // Other products are listed so the reader can see the application is
          // broader than this product — never merged into it.
          otherProductsInApplication: (app.products ?? [])
            .filter((p) => p.product_number !== matched.product_number)
            .map((p) => ({
              productNumber: p.product_number,
              strength: p.active_ingredients?.[0]?.strength ?? "",
              dosageForm: p.dosage_form ?? "",
            })),
          submissions: (app.submissions ?? []).map((s) => ({
            type: s.submission_type ?? "",
            number: s.submission_number ?? "",
            status: s.submission_status ?? null,
            date: s.submission_status_date ?? null,
          })),
          provenance: res.provenance,
        };
      } else if (app) {
        approval = absent(
          "ambiguous-applicability",
          `Application ${appNumber} was found but no single product within it could be matched to this ` +
            `strength and dose form. Application-level facts are deliberately not transferred.`
        );
      } else {
        approval = absent("not-present-in-source", `No Drugs@FDA record for ${appNumber}.`);
      }
    } catch (err) {
      approval = absent("retrieval-failed", String(err));
    }
  }

  /* --- supplemental: recalls ------------------------------------------- */

  let enforcement: MedicationRecord["supplemental"]["enforcement"];
  try {
    const res = await enforcementForProduct(
      resolution.identity.genericName,
      resolution.identity.productNdc,
      force
    );
    enforcement =
      res.records.length > 0
        ? {
            present: true,
            note:
              "Supplemental recall records. Matching is by generic name unless matchedOnNdc is true; a " +
              "name match does NOT establish that this exact product was recalled. Not patient-facing.",
            records: res.records,
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

  return {
    schemaVersion: SCHEMA_VERSION,
    productKey: spec.productKey,
    resolution,
    identity: resolution.identity,
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
      sections: spl.sections,
      patientLabeling: spl.patientLabeling,
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
