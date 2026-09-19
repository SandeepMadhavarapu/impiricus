import { writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { SOURCE_REGISTER } from "../config/sourceRegister.js";
import { DEMO_PLANS } from "../config/demoPlans.js";
import { INSURANCE_SCHEMA_VERSION, SourceRegisterSchema } from "../schemas/insurance.js";
import { loadPartDSnapshot, snapshotProvenance } from "./snapshot.js";
import { lookupCoverage } from "./lookup.js";
import { rxcuisForProduct, listProductKeys } from "./cli.js";

import { SUPPORTED_SCOPE } from "../config/scope.js";

/**
 * Insurance exports for the app.
 *
 * Three artifacts, all dependency-free JSON:
 *   source-register.json   what we discovered vs what we actually retrieved
 *   plans.json             exact plan identities with their formulary mapping
 *   coverage-examples.json real lookup responses for UI teammates
 */

async function atomicWrite(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, file);
}

const OUT = path.join(process.cwd(), "data", "exports", "insurance");

export async function exportInsurance(): Promise<string[]> {
  const written: string[] = [];

  /* 1. Source register */
  const register = SourceRegisterSchema.parse({
    schemaVersion: INSURANCE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    supportedScope: SUPPORTED_SCOPE,
    note:
      "retrievalStatus separates DISCOVERY from RETRIEVAL. Only entries marked retrieved-validated or " +
      "verified-against-original contributed data to any export. Entries marked discovered or " +
      "not-attempted are documented leads, and nothing depends on them.",
    entries: SOURCE_REGISTER,
  });
  const regPath = path.join(OUT, "source-register.json");
  await atomicWrite(regPath, JSON.stringify(register, null, 2) + "\n");
  written.push(regPath);

  const snapshot = loadPartDSnapshot();
  if (!snapshot) return written;

  /* 2. Plans, limited to those carrying our drugs */
  const plansPath = path.join(OUT, "plans.json");
  await atomicWrite(
    plansPath,
    JSON.stringify(
      {
        schemaVersion: INSURANCE_SCHEMA_VERSION,
        market: "medicare-part-d",
        sourceRelease: snapshot.release,
        contractYear: snapshot.contractYear,
        retrievedAt: snapshot.retrievedAt,
        note:
          "Plan identity requires contract id + plan id + segment id + year. A plan NAME is not an " +
          "identifier: 39 plans in this release share the name 'AARP Medicare Rx Preferred from UHC (PDP)'.",
        planCount: snapshot.plans.length,
        plans: snapshot.plans.map((p) => ({
          planKey: `medicare-partd-${snapshot.contractYear}-${p.contractId}-${p.planId}-${p.segmentId ?? "000"}`,
          contractId: p.contractId,
          planId: p.planId,
          segmentId: p.segmentId,
          formularyId: p.formularyId,
          organizationName: p.organizationName,
          planName: p.planName,
        })),
      },
      null,
      2
    ) + "\n"
  );
  written.push(plansPath);

  /* 3. Real example lookups for every product x demo plan */
  const provenance = snapshotProvenance(snapshot);
  const examples = [];
  for (const productKey of listProductKeys()) {
    const { exactRxcui, related } = rxcuisForProduct(productKey);
    for (const plan of DEMO_PLANS) {
      examples.push({
        scenario: `${productKey} on ${plan.label}`,
        exercises: plan.exercises,
        request: {
          productKey,
          contractId: plan.contractId,
          planId: plan.planId,
          segmentId: plan.segmentId,
          planYear: plan.planYear,
        },
        response: lookupCoverage(
          snapshot,
          {
            productKey,
            exactRxcui,
            relatedRxcuis: related,
            planYear: plan.planYear,
            contractId: plan.contractId,
            planId: plan.planId,
            segmentId: plan.segmentId,
          },
          provenance
        ),
      });
    }
  }

  // Counterexample: a plan NAME must not resolve a plan.
  const firstProduct = listProductKeys()[0]!;
  const fp = rxcuisForProduct(firstProduct);
  examples.push({
    scenario: "Counterexample: resolving by insurer/plan NAME only",
    exercises:
      "A plan name is not an identifier. This must return ambiguous-plan with candidates and the " +
      "missing disambiguators, never a coverage answer.",
    request: { productKey: firstProduct, planNameQuery: "AARP Medicare Rx Preferred", planYear: 2026 },
    response: lookupCoverage(
      snapshot,
      {
        productKey: firstProduct,
        exactRxcui: fp.exactRxcui,
        relatedRxcuis: fp.related,
        planYear: 2026,
        planNameQuery: "AARP Medicare Rx Preferred",
      },
      provenance
    ),
  });

  const examplesPath = path.join(OUT, "coverage-examples.json");
  await atomicWrite(
    examplesPath,
    JSON.stringify(
      {
        schemaVersion: INSURANCE_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        note:
          "Real responses produced from the committed CMS snapshot. memberBenefitVerified is false on " +
          "every one: this pipeline has no authorised member-specific integration.",
        examples,
      },
      null,
      2
    ) + "\n"
  );
  written.push(examplesPath);

  return written;
}
