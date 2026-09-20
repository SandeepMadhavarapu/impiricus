#!/usr/bin/env node
/**
 * Records, for each published product, the RxNorm concept it actually IS and
 * the same-presentation generic concept it is interchangeable with.
 *
 * WHY THIS EXISTS
 * ---------------
 * The authored source record carries a flat `product.rxcui` array. For
 * Singulair that array holds EIGHT concepts spanning four presentations:
 *
 *   153892  SBD  montelukast 10 MG Oral Tablet [Singulair]   <- the page
 *   200224  SCD  montelukast 10 MG Oral Tablet               <- its generic
 *   153893  SBD  montelukast 5 MG Chewable Tablet [Singulair]
 *   242438  SCD  montelukast 5 MG Chewable Tablet
 *   261367  SBD  montelukast 4 MG Chewable Tablet [Singulair]
 *   311759  SCD  montelukast 4 MG Chewable Tablet
 *   351246  SCD  montelukast 4 MG Oral Granules
 *   404406  SBD  montelukast 4 MG Oral Granules [Singulair]
 *
 * Passing that whole array into a formulary lookup answers a question about a
 * 10 mg film-coated tablet using, potentially, a row for 4 mg oral granules -
 * a different strength, a different form, and for a child rather than an adult.
 * It also collapses brand and generic: the "Tier 1, no prior authorisation,
 * 30 per 30 days" a reader saw on the Singulair page was row 200224, the
 * GENERIC. Brand Singulair is not on that plan's list at all.
 *
 * A name string cannot be used to tell these apart safely, so nothing here
 * guesses. Both facts come from RxNav:
 *
 *   TTY          /REST/rxcui/{id}/property.json?propName=TTY
 *   generic of   /REST/rxcui/{id}/related.json?tty=SCD
 *
 * RxNorm's own relationship is what defines "same drug, same strength, same
 * form, without the brand". That is the only claim this file supports.
 *
 * Usage:  node scripts/fetch-rxnorm-concepts.mjs
 * Output: src/sources/content/rxnorm/product-concepts.json
 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

const BASE = "https://rxnav.nlm.nih.gov/REST";
const UA = "medbridge-hackathon-prototype/0.1 (rxnorm concept resolution)";
const EXPORTS = path.join("src", "sources", "content", "label-exports");
const OUT = path.join("src", "sources", "content", "rxnorm", "product-concepts.json");

async function rxnav(url) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function property(rxcui, propName) {
  const d = await rxnav(`${BASE}/rxcui/${rxcui}/property.json?propName=${encodeURIComponent(propName)}`);
  return d?.propConceptGroup?.propConcept?.[0]?.propValue ?? null;
}

async function relatedByTty(rxcui, tty) {
  const d = await rxnav(`${BASE}/rxcui/${rxcui}/related.json?tty=${tty}`);
  const out = [];
  for (const g of d?.relatedGroup?.conceptGroup ?? []) {
    for (const c of g?.conceptProperties ?? []) out.push({ rxcui: c.rxcui, tty: c.tty, name: c.name });
  }
  return out;
}

/*
 * The artifact that is already shipping. Read BEFORE anything is fetched, so a
 * failed or partial run can leave it exactly as it was: a half-written identity
 * map joined to refreshed label data would describe a different product than
 * the page does.
 */
let previous = null;
try {
  previous = JSON.parse(await readFile(OUT, "utf8"));
} catch {
  // First run, or no readable artifact. Nothing to preserve.
}

const files = (await readdir(EXPORTS)).filter((f) => f.endsWith(".json") && f !== "manifest.json");
const products = {};
/** Anything that could not be resolved. A non-empty list means nothing is written. */
const failures = [];

for (const file of files.sort()) {
  const exp = JSON.parse(await readFile(path.join(EXPORTS, file), "utf8"));
  const slug = exp.productKey;
  const rxcui = exp.identifiers?.rxcui;

  if (!rxcui) {
    // A real state, not an error: openFDA did not harmonise an RXCUI for this
    // product. Recorded so a consumer can say "cannot be looked up" rather
    // than fall back to some related concept.
    products[slug] = { exact: null, genericEquivalent: null, note: "the label export carries no RXCUI" };
    console.log(`${slug}: no RXCUI on the label export`);
    continue;
  }

  let tty;
  let name;
  try {
    [tty, name] = await Promise.all([property(rxcui, "TTY"), property(rxcui, "RxNorm Name")]);
  } catch (err) {
    // Recorded, not swallowed, and not turned into a null concept: "RxNav was
    // unreachable" and "this product has no concept" are different facts, and
    // only one of them is safe to write.
    failures.push(`${slug}: ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  if (!tty || !name) {
    failures.push(`${slug}: RxNav returned no TTY or name for RXCUI ${rxcui}`);
    continue;
  }
  const exact = { rxcui, tty, name };

  /*
   * Only a branded concept has a distinct generic equivalent worth recording.
   * Asking RxNav for the SCD of a concept that already IS the SCD returns
   * itself, which would make "the generic of X" and "X" the same row and
   * defeat the distinction this file exists to preserve.
   */
  let genericEquivalent = null;
  if (tty === "SBD") {
    let scds;
    try {
      scds = await relatedByTty(rxcui, "SCD");
    } catch (err) {
      failures.push(
        `${slug}: generic lookup failed: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    if (scds.length === 1) {
      genericEquivalent = scds[0];
    } else if (scds.length > 1) {
      // Ambiguous, so nothing is recorded. Picking one would be the guess
      // this whole file exists to avoid.
      console.log(`${slug}: ${scds.length} candidate generics, recording none`);
    }
  }

  products[slug] = { exact, genericEquivalent };
  console.log(
    `${slug}\n  exact   ${exact.rxcui} ${exact.tty} ${exact.name}` +
      (genericEquivalent
        ? `\n  generic ${genericEquivalent.rxcui} ${genericEquivalent.tty} ${genericEquivalent.name}`
        : `\n  generic (none recorded)`)
  );
}

const doc = {
  schemaVersion: 1,
  source: {
    name: "RxNorm, via the RxNav REST API",
    owner: "U.S. National Library of Medicine",
    url: `${BASE}/`,
    retrievedAt: new Date().toISOString(),
  },
  note:
    "The concept each published product IS, and the same-strength same-form generic " +
    "RxNorm relates it to. Nothing here is inferred from a name. A coverage answer " +
    "about the branded product must use `exact`; `genericEquivalent` is a DIFFERENT " +
    "product and its formulary status must never be presented as the brand's.",
  products,
};

/*
 * All or nothing.
 *
 * Writing only the products that succeeded would silently drop the ones that
 * did not, and `productConcepts` returns null for a missing entry - which the
 * coverage flow reports as "unable to verify" with nothing failing anywhere.
 * A partial identity map is worse than yesterday's complete one.
 */
if (failures.length > 0) {
  console.error(
    `\nRxNorm identity NOT written. ${failures.length} product(s) could not be resolved:\n` +
      failures.map((f) => `  - ${f}`).join("\n") +
      `\n\nThe existing ${OUT} is unchanged.`
  );
  process.exitCode = 1;
} else {
  /*
   * A changed clinical identity is staged, not accepted.
   *
   * RxNorm reorganises, and a product quietly acquiring a different concept is
   * exactly the change that must not ride along with a data refresh. The file
   * is still written - it is a candidate, and the workflow opens a pull
   * request rather than publishing - but the change is called out so a person
   * reviews it instead of skimming a green run.
   */
  const changes = [];
  if (previous?.products) {
    for (const [key, next] of Object.entries(products)) {
      const prev = previous.products[key];
      if (!prev) continue;
      if (prev.exact?.rxcui !== next.exact?.rxcui) {
        changes.push(`${key}: concept ${prev.exact?.rxcui ?? "none"} -> ${next.exact?.rxcui ?? "none"}`);
      }
      if (prev.genericEquivalent?.rxcui !== next.genericEquivalent?.rxcui) {
        changes.push(
          `${key}: generic ${prev.genericEquivalent?.rxcui ?? "none"} -> ${next.genericEquivalent?.rxcui ?? "none"}`
        );
      }
    }
  }

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(doc, null, 2) + "\n", "utf8");
  console.log(`\nwrote ${OUT}`);

  if (changes.length > 0) {
    console.log(`\n::warning::IDENTITY CHANGED - needs review before merge:`);
    for (const c of changes) console.log(`  ${c}`);
  }
}
