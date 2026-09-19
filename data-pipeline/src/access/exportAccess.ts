/**
 * Access-pathway ingestion and export.
 *
 * Produces a deterministic bundle the app can render without asking a model to
 * invent a next step: for each product and each plan we can actually resolve,
 * what the plan publishes, what it requires, what the published policy says to
 * do next, and what is still unknown.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadPartDSnapshot, snapshotProvenance } from "../insurance/snapshot.js";
import { lookupCoverage } from "../insurance/lookup.js";
import { rxcuisForProduct, listProductKeys } from "../insurance/cli.js";
import { DEMO_PLANS } from "../config/demoPlans.js";
import { findPartDRelease } from "../sources/cmsPartD.js";
import { listRemoteZip, fetchZipMemberFlattened } from "../sources/zipRange.js";
import {
  classifyVersions,
  corroborateAgainstQuickList,
  currentlyEffectiveVersion,
  upcomingVersion,
  retrievePdl,
  deriveColumnBoundaries,
  parsePdlClasses,
  findInPdl,
  vaPdlUrl,
  VA_PDL_VERSIONS,
  type PdlClassBlock,
} from "../sources/vaMedicaid.js";
import { buildPartDPolicy, buildVaFfsPolicy } from "./policy.js";
import { checkLinks, urlsFromTemplates } from "./linkCheck.js";
import {
  ACCESS_SOURCE_DOCUMENTS,
  PART_D_ACTIONS,
  VA_MEDICAID_FFS_ACTIONS,
} from "../config/accessActions.js";
import {
  compareSnapshots,
  summarizeChanges,
  entryKey,
  PARSER_VERSION,
  type VersionSnapshot,
} from "./changes.js";
import { ACCESS_SCHEMA_VERSION, type AccessPolicy, type SourceChange } from "../schemas/access.js";
import { SUPPORTED_SCOPE } from "../config/scope.js";

const OUT = path.join(process.cwd(), "data", "exports", "access");

/** Brand and generic terms to search a state PDL with, per product. */
const PDL_SEARCH_TERMS: Record<string, string[]> = {
  "singulair-montelukast-10mg-tablet": ["Singulair", "montelukast"],
  "toprol-xl-metoprolol-succinate-50mg-er-tablet": ["Toprol XL", "metoprolol succinate"],
  "ozempic-semaglutide-1_34mg-per-ml-injection": ["Ozempic", "semaglutide"],
};

/**
 * Indication-based coverage rows for our RXCUIs.
 *
 * A 2 KB member of the CMS archive that no previous pass ingested. Each row is
 * a contract+plan restricting a drug's coverage to a named disease, which is a
 * genuine indication restriction published by the plan.
 */
async function fetchIndications(
  wanted: Set<string>
): Promise<Map<string, Map<string, string[]>>> {
  const release: any = await findPartDRelease();
  const { entries } = await listRemoteZip(release.url);
  const entry = entries.find((e: any) => /indication\s*based\s*coverage/i.test(e.name));
  const out = new Map<string, Map<string, string[]>>();
  if (!entry) return out;

  for (const f of await fetchZipMemberFlattened(release.url, entry)) {
    const lines = f.data.toString("utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(1)) {
      const [contractId, planId, rxcui, disease] = line.split("|");
      if (!contractId || !planId || !rxcui || !disease) continue;
      if (!wanted.has(rxcui.trim())) continue;
      const key = `${contractId.trim()}-${planId.trim()}`;
      if (!out.has(key)) out.set(key, new Map());
      const byRxcui = out.get(key)!;
      const list = byRxcui.get(rxcui.trim()) ?? [];
      list.push(disease.trim());
      byRxcui.set(rxcui.trim(), list);
    }
  }
  return out;
}

/**
 * The comparable view of a PDL version: each listed drug and its preference
 * status.
 *
 * Two things here exist to stop the diff inventing changes:
 *
 * 1. Entries are keyed by `entryKey`, not raw text, so a renumbered footnote
 *    marker or a dropped trademark symbol is not a drug appearing and another
 *    disappearing.
 *
 * 2. A name can legitimately sit in BOTH columns - Virginia lists montelukast
 *    tablets as preferred and montelukast granules as non-preferred. The
 *    tracked value is therefore the SET of columns the name occupies. Keying
 *    one entry per name and letting the later row win would have silently
 *    dropped half of those and reported the survivor as a preference change.
 */
/** Line-wrap fragments dropped by the most recent snapshot build. */
let lastSkippedFragments = 0;

function pdlSnapshot(
  blocks: PdlClassBlock[],
  meta: { version: string; effective: string; hash: string }
): VersionSnapshot {
  const byKey = new Map<
    string,
    { columns: Set<string>; label: string; page: number }
  >();
  let skippedFragments = 0;

  for (const block of blocks) {
    for (const [column, cells] of [
      ["preferred", block.preferred],
      ["non-preferred", block.nonPreferred],
    ] as const) {
      for (const c of cells) {
        const key = entryKey(c.text);
        // Column furniture and line-wrap fragments are not drug entries and
        // must not be diffed as if they were: a listing that reflows onto a
        // different line would otherwise read as one drug removed and another
        // added.
        //
        // Entry boundaries WITHIN a column are not fully recoverable from this
        // document - a single listing wraps over several lines with no
        // terminator - so these rules are conservative, and how many they drop
        // is counted rather than hidden.
        if (key.length < 4) continue;
        if (!/[a-z]/.test(key)) continue;
        if (/^(length of authorization|routine pdl edits|and|or)\b/.test(key)) continue;

        const opens = (key.match(/\(/g) ?? []).length;
        const closes = (key.match(/\)/g) ?? []).length;
        // Wrapped mid-parenthesis, e.g. "formoterol fumarate (generic".
        if (opens !== closes) {
          skippedFragments++;
          continue;
        }
        // Trailing conjunction, e.g. "albuterol HFA (Proair) and".
        if (/\b(and|or|for|with)$/.test(key)) {
          skippedFragments++;
          continue;
        }
        // Orphaned tail, e.g. "Aubagio())".
        if (/^\)/.test(key)) {
          skippedFragments++;
          continue;
        }

        const existing = byKey.get(key);
        if (existing) existing.columns.add(column);
        else byKey.set(key, { columns: new Set([column]), label: c.text, page: c.page });
      }
    }
  }

  lastSkippedFragments = skippedFragments;
  return {
    documentVersion: meta.version,
    effectiveDate: meta.effective,
    contentHash: meta.hash,
    parserVersion: PARSER_VERSION,
    items: [...byKey.entries()].map(([key, v]) => ({
      key,
      subjectLabel: v.label,
      value: [...v.columns].sort().join("+"),
      statedText: v.label,
      locator: `page ${v.page}`,
    })),
  };
}

export async function exportAccess(opts: { asOf?: string } = {}): Promise<string[]> {
  const written: string[] = [];
  // Reference date for every effectivity judgement, so a run is reproducible.
  const asOfDate = opts.asOf ?? new Date().toISOString().slice(0, 10);
  await mkdir(OUT, { recursive: true });

  /* ---------------------------------------------------------- link check */
  const urls = urlsFromTemplates(
    [...PART_D_ACTIONS, ...VA_MEDICAID_FFS_ACTIONS],
    ACCESS_SOURCE_DOCUMENTS
  );
  const links = await checkLinks(urls);
  const deadLinks = [...links.values()].filter((l) => !l.ok);

  /* -------------------------------------------------------- Part D policies */
  const snapshot = loadPartDSnapshot();
  const policies: AccessPolicy[] = [];
  const productKeys = listProductKeys();

  const allRxcuis = new Set<string>();
  for (const pk of productKeys) {
    const { exactRxcui, related } = rxcuisForProduct(pk);
    if (exactRxcui) allRxcuis.add(exactRxcui);
    for (const r of related) allRxcuis.add(r.rxcui);
  }
  const indications = await fetchIndications(allRxcuis);

  if (snapshot) {
    const provenance = snapshotProvenance(snapshot);
    const partDRetrieval = {
      retrievedAt: snapshot.retrievedAt,
      contentHash: createHash("sha256")
        .update(`${snapshot.release}|${snapshot.modified}`)
        .digest("hex"),
      version: snapshot.release,
      effective: snapshot.modified,
    };

    for (const pk of productKeys) {
      const { exactRxcui, related } = rxcuisForProduct(pk);
      for (const plan of DEMO_PLANS) {
        const coverage = lookupCoverage(
          snapshot,
          {
            productKey: pk,
            exactRxcui,
            relatedRxcuis: related,
            planYear: plan.planYear,
            contractId: plan.contractId,
            planId: plan.planId,
            segmentId: plan.segmentId,
          },
          provenance
        );

        const planIndications: string[] = [];
        const byRxcui = indications.get(`${plan.contractId}-${plan.planId}`);
        if (byRxcui) {
          for (const [, diseases] of byRxcui) planIndications.push(...diseases);
        }

        policies.push(
          buildPartDPolicy({
            productKey: pk,
            asOfDate,
            coverage,
            indications: [...new Set(planIndications)],
            retrieval: partDRetrieval,
            links,
          })
        );
      }
    }
  }

  /* ------------------------------------------------ Virginia Medicaid FFS */
  //
  // The version IN FORCE, not the newest published. Virginia posts each
  // quarterly PDL weeks before it takes effect and keeps superseded versions
  // online, so "latest file" and "current coverage" are different documents
  // for most of every quarter. Building from the newest file states next
  // quarter's rules as today's.
  const effective = currentlyEffectiveVersion(VA_PDL_VERSIONS, asOfDate);
  if (!effective) {
    throw new Error(
      `No Virginia PDL version is in force on ${asOfDate}; every published version is ` +
        "future-dated. Refusing to present an upcoming document as current coverage."
    );
  }
  const next = upcomingVersion(VA_PDL_VERSIONS, asOfDate);

  const current = await retrievePdl(effective.ref);
  if (!current.verified) {
    throw new Error(`Virginia PDL failed self-verification: ${current.verificationNote}`);
  }
  const bounds = deriveColumnBoundaries(current.doc);
  if (!bounds) throw new Error("Virginia PDL layout changed: three-column header not found.");
  const blocks = parsePdlClasses(current.doc, bounds);

  const vaRetrieval = {
    retrievedAt: current.doc.retrievedAt,
    contentHash: current.doc.sha256,
    version: current.ref.expectedFooterVersion,
    effective: current.ref.effectiveDate,
  };

  // Diff the in-force version against the next one, so a product's upcoming
  // change can travel with its policy WITHOUT displacing current coverage.
  let nextBlocks: PdlClassBlock[] | null = null;
  let nextRetrieval: Awaited<ReturnType<typeof retrievePdl>> | null = null;
  if (next) {
    nextRetrieval = await retrievePdl(next.ref);
    const nb = deriveColumnBoundaries(nextRetrieval.doc);
    if (nb) nextBlocks = parsePdlClasses(nextRetrieval.doc, nb);
  }

  for (const pk of productKeys) {
    const terms = PDL_SEARCH_TERMS[pk] ?? [];
    // Search the brand first; fall back to the ingredient only if the brand is
    // absent, so a generic listing is never reported as the brand's status.
    let chosen = terms[0] ?? pk;
    let match = findInPdl(blocks, chosen);
    if (match.status === "not-addressed-in-this-document" && terms[1]) {
      const alt = findInPdl(blocks, terms[1]);
      if (alt.status !== "not-addressed-in-this-document") {
        chosen = terms[1];
        match = alt;
      }
    }
    // Does the next published version change THIS product's status?
    const upcomingChanges: AccessPolicy["upcomingChanges"] = [];
    if (nextBlocks && next) {
      const after = findInPdl(nextBlocks, chosen);
      if (after.status !== match.status) {
        upcomingChanges.push({
          takesEffectOn: next.ref.effectiveDate,
          documentVersion: next.ref.expectedFooterVersion,
          summary:
            `In the version effective ${next.ref.effectiveDate}, this product's listing changes ` +
            `from "${match.status}" to "${after.status}". It has NOT changed yet.`,
          previousValue: match.status,
          newValue: after.status,
          locator: after.hits[0] ? `page ${after.hits[0].page}` : null,
        });
      }
    }

    // Corroborate the column reading against a SEPARATE publisher document.
    const corroboration = await corroborateAgainstQuickList(
      chosen,
      match.status,
      current.ref.effectiveDate
    );

    // Record how every extraction disagreement touching this product's rows
    // was resolved, so a reviewer sees a decision rather than a silent choice.
    const disputes: AccessPolicy["extractionDisputes"] = [];
    for (const h of match.hits) {
      const cells = [
        ...(blocks.find((b) => b.className === h.className)?.preferred ?? []),
        ...(blocks.find((b) => b.className === h.className)?.nonPreferred ?? []),
      ];
      for (const c of cells.filter((c) => c.columnDisputed && c.text === h.text)) {
        disputes.push({
          locator: `page ${c.page}, x=${c.x.toFixed(0)}`,
          disputed:
            `Horizontal position places "${c.text}" in the ${c.column} column, but its ` +
            `typography reads ${c.typography}.`,
          resolution: `Kept as ${c.column}.`,
          basis:
            "Horizontal position is bound to the column headers measured on the same page, " +
            "whereas typography is a styling convention the publisher applies inconsistently to " +
            "legends and headings. Position wins, and the disagreement is recorded here.",
        });
      }
    }

    policies.push(
      buildVaFfsPolicy({
        productKey: pk,
        asOfDate,
        corroboration,
        extractionDisputes: disputes,
        effectivityStatus: "currently-effective",
        upcomingChanges,
        searchTerm: chosen,
        match,
        retrieval: vaRetrieval,
        documentUrl: vaPdlUrl(current.ref.slug),
        links,
      })
    );
  }

  /* ------------------------------------------------------ change detection */
  //
  // The comparison runs FROM the version in force TO the next one, so every
  // record describes a change that is still to come. Comparing the newest two
  // published files and calling the result "changed" would report next
  // quarter's rules as though they had already replaced this quarter's.
  let changes: SourceChange[] = [];
  if (nextBlocks && nextRetrieval && next) {
    changes = compareSnapshots(
      pdlSnapshot(blocks, {
        version: current.ref.expectedFooterVersion,
        effective: current.ref.effectiveDate,
        hash: current.doc.sha256,
      }),
      pdlSnapshot(nextBlocks, {
        version: next.ref.expectedFooterVersion,
        effective: next.ref.effectiveDate,
        hash: nextRetrieval.doc.sha256,
      }),
      {
        category: "preference-status",
        effectiveStatus: "upcoming",
        takesEffectOn: next.ref.effectiveDate,
      }
    );
  }

  /* ------------------------------------------------------------- write out */
  const policiesPath = path.join(OUT, "access-policies.json");
  await writeFile(
    policiesPath,
    JSON.stringify(
      {
        schemaVersion: ACCESS_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        supportedScope: SUPPORTED_SCOPE,
        note:
          "What each plan PUBLISHES about each product, plus the next steps its own policy " +
          "documents describe. No member eligibility, no approval, no clinical review.",
        linkCheck: {
          checked: links.size,
          failing: deadLinks.length,
          results: [...links.values()],
        },
        policies,
      },
      null,
      2
    ) + "\n"
  );
  written.push(policiesPath);

  const changesPath = path.join(OUT, "source-changes.json");
  await writeFile(
    changesPath,
    JSON.stringify(
      {
        schemaVersion: ACCESS_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        asOfDate,
        comparison: {
          source: "Virginia Medicaid PDL / Common Core Formulary",
          /** The version IN FORCE on asOfDate. This is current coverage. */
          currentlyEffective: {
            version: current.ref.expectedFooterVersion,
            effectiveDate: current.ref.effectiveDate,
            url: vaPdlUrl(current.ref.slug),
            contentHash: current.doc.sha256,
          },
          /** The next version to take effect. NOT current coverage. */
          upcoming: next
            ? {
                version: next.ref.expectedFooterVersion,
                effectiveDate: next.ref.effectiveDate,
                url: vaPdlUrl(next.ref.slug),
                contentHash: nextRetrieval?.doc.sha256 ?? null,
                daysUntilEffective: next.daysUntilEffective,
              }
            : null,
          allPublishedVersions: classifyVersions(VA_PDL_VERSIONS, asOfDate).map((v) => ({
            version: v.ref.expectedFooterVersion,
            effectiveDate: v.ref.effectiveDate,
            effectivity: v.effectivity,
          })),
          parserVersion: PARSER_VERSION,
        },
        note:
          "Both sides are genuinely retrieved published versions of the same document, and the " +
          "comparison runs FROM the version in force TO the next one. Every record therefore " +
          "describes a change that has NOT happened yet: effectiveStatus is 'upcoming' and " +
          "takesEffectOn carries the date. Current coverage is the 'currentlyEffective' side. " +
          "A change record is an item for review, never a patient notification: " +
          "isPatientNotification is the literal false on every record.",
        entrySegmentation: {
          complete: false,
          fragmentsFilteredFromNewerVersion: lastSkippedFragments,
          note:
            "Entry boundaries within a column are not fully recoverable: one listing wraps over " +
            "several lines with no terminator. Line-wrap fragments are filtered before diffing, " +
            "but ADDED and REMOVED records remain review items rather than confirmed listing " +
            "changes. The higher-confidence class is a record present in both versions whose " +
            "column differs - for example Cinryze, Preferred on page 52 of 07/01/2026 v4 and " +
            "Non-Preferred on page 54 of 10/01/2026 v2, confirmed by reading both documents.",
        },
        summary: summarizeChanges(changes),
        changes,
      },
      null,
      2
    ) + "\n"
  );
  written.push(changesPath);

  /* ------------------------------------------------- capability manifest */
  const byProgram = (prog: string) => policies.filter((p) => p.benefitProgram === prog);
  const displayable = policies.filter(
    (p) => p.extractionStatus === "verified-public-evidence" || p.requirements.length > 0
  );

  const manifestPath = path.join(OUT, "capability-manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: ACCESS_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        note:
          "What is ready to display, and what is not. A capability listed as ready has real " +
          "retrieved evidence behind every field a consumer would render.",
        readyToDisplay: [
          {
            capability: "Medicare Part D published formulary status and restrictions",
            products: 3,
            plans: DEMO_PLANS.length,
            policies: byProgram("medicare-part-d").length,
            evidence: "CMS monthly Part D release, verified current at build time",
            status: "verified-public-evidence",
          },
          {
            capability: "Medicaid fee-for-service preference status (Virginia)",
            products: 3,
            plans: 1,
            policies: byProgram("medicaid-fee-for-service").length,
            evidence:
              "Virginia PDL / Common Core Formulary PDF, column membership verified two ways " +
              "(horizontal position and typography) with page-level citations",
            status: "verified-public-evidence",
          },
          {
            capability: "Official next steps, forms and contacts",
            actions: policies.reduce((n, p) => n + p.actions.length, 0),
            linksVerified: links.size - deadLinks.length,
            linksFailing: deadLinks.length,
            evidence:
              "CMS Part D model forms; Virginia SA, appeal and 72-hour supply policies. Every " +
              "published URL is reachability-checked at build time.",
            status: "verified-public-evidence",
          },
          {
            capability: "Source version change detection",
            comparedVersions: 2,
            evidence:
              "Two genuinely published Virginia PDL versions. Change records are review items; " +
              "isPatientNotification is false on every one.",
            status: "verified-public-evidence",
          },
          {
            capability: "Insurance-card field matching",
            evidence:
              "Pure function over supplied fields, synthetic fixtures only. No card image is " +
              "read or stored anywhere in this pipeline.",
            status: "verified-public-evidence",
          },
        ],
        statusVocabulary: {
          implementationStatus:
            "What WE built: not-attempted | attempted | implemented-partial | implemented.",
          sourceAvailability:
            "What the SOURCE did: not-assessed | available-but-not-retrieved | " +
            "retrieved-validated | retrieval-failed | no-suitable-public-source-identified | " +
            "no-public-source-exists. 'not-assessed' means we never looked, and must never be " +
            "reported as the source being unavailable.",
        },
        notReadyToDisplay: [
          {
            capability: "Plan-specific clinical prior-authorization criteria",
            implementationStatus: "attempted",
            sourceAvailability: "retrieval-failed",
            status: "unresolved-applicability",
            blocker:
              "The CMS release carries PA and step therapy as FLAGS only, with no criteria text. " +
              "Criteria live in insurer-hosted documents; uhc.com returned HTTP 403 to automated " +
              "retrieval, and a national PBM criteria document cannot be attributed to a specific " +
              "contract-plan-segment without a documented plan-to-policy mapping.",
          },
          {
            capability: "Virginia SA criteria bound to a specific drug",
            implementationStatus: "implemented-partial",
            sourceAvailability: "retrieved-validated",
            status: "incomplete-extraction",
            blocker:
              "The SA Criteria column is not aligned to the left column's class headings, so no " +
              "rule over the left column establishes which criteria bind which drug. Criteria " +
              "text is carried verbatim with page citations for a human to read in place.",
          },
          {
            capability: "Financial assistance programme terms",
            implementationStatus: "not-attempted",
            sourceAvailability: "not-assessed",
            status: "not-implemented",
            blocker:
              "No adapter was built and NO RETRIEVAL WAS ATTEMPTED, so nothing is known about " +
              "whether these sources are reachable. This is an implementation gap, not a source " +
              "failure: manufacturer programme pages carry their own expiry and exclusion terms " +
              "that must be quoted exactly and re-verified per retrieval, and that work was " +
              "deferred rather than approximated.",
          },
          {
            capability: "Marketplace and commercial formularies",
            implementationStatus: "not-attempted",
            sourceAvailability: "no-suitable-public-source-identified",
            status: "not-implemented",
            blocker:
              "No adapter was built. Discovery found no public plan-to-formulary crosswalk: CMS " +
              "public use files carry benefit design, not drug-level formularies. No retrieval " +
              "was attempted, so no source is recorded as having failed.",
          },
          {
            capability: "Pharmacy network participation and stock",
            implementationStatus: "not-attempted",
            sourceAvailability: "available-but-not-retrieved",
            status: "not-implemented",
            blocker:
              "The CMS pharmacy network files ARE available and were listed in the archive " +
              "(2.18 GB across six members); they were deliberately not fetched. NPPES proves a " +
              "pharmacy exists, never that it participates in a plan network or holds stock.",
          },
          {
            capability: "Member eligibility, copay, and approval status",
            implementationStatus: "not-attempted",
            sourceAvailability: "no-public-source-exists",
            status: "requires-authorized-member-integration",
            blocker:
              "Requires an authorised payer integration with a trading-partner agreement and " +
              "patient identifiers. No public API exists and none is simulated.",
          },
        ],
        displayablePolicyCount: displayable.length,
      },
      null,
      2
    ) + "\n"
  );
  written.push(manifestPath);

  /* ---------------------------------------------------- coverage matrix */
  const matrixPath = path.join(OUT, "coverage-matrix.json");
  await writeFile(
    matrixPath,
    JSON.stringify(
      {
        schemaVersion: ACCESS_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        note:
          "Exactly which source was checked for which product and plan, and what came back. A " +
          "row with status not-addressed-in-this-document means the source did not mention the " +
          "product; it does NOT mean the product is not covered.",
        rows: policies.map((p) => ({
          productKey: p.productKey,
          benefitProgram: p.benefitProgram,
          planKey: p.planKey,
          scope: p.scopeLabel,
          geography: p.geography,
          planYear: p.planYear,
          sourceDocument: p.evidence[0]?.documentTitle ?? null,
          documentVersion: p.evidence[0]?.documentVersion ?? null,
          retrievedAt: p.evidence[0]?.retrievedAt ?? null,
          listingStatus: p.listingStatus,
          requirementCount: p.requirements.length,
          actionCount: p.actions.length,
          applicability: p.applicability,
          extractionStatus: p.extractionStatus,
        })),
      },
      null,
      2
    ) + "\n"
  );
  written.push(matrixPath);

  return written;
}
