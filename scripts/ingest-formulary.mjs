#!/usr/bin/env node
/**
 * RETIRED. The CMS Part D formulary snapshot is produced by the data-pipeline
 * package and synced into the app; this script no longer downloads anything.
 *
 * Why it was retired rather than kept as an alternative:
 *
 *   - It wrote a snapshot for ONE product's RXCUIs (the authored Singulair
 *     record's), where the app now serves three products and the lookup
 *     needs each product's exact and generic concepts.
 *   - It wrote the pre-`contractYear` shape, which the app's schema now
 *     rejects. Running it would have replaced the committed, validated
 *     snapshot with one that fails to parse, and every coverage check would
 *     have quietly gone back to "unable to verify".
 *   - It downloaded the full ~2.2 GB archive. The pipeline fetches the ~9 MB
 *     it needs by HTTP range request.
 *
 * The current path:
 *
 *   cd data-pipeline && npm run insurance:ingest   # fetch + normalize (needs network)
 *   cd .. && npm run content:sync                  # convert + vendor into src/
 *
 * The snapshot at src/sources/content/coverage/cms-part-d-snapshot.json IS
 * committed. See the comment in .gitignore and scripts/sync-label-exports.mjs.
 */

console.error(
  [
    "npm run coverage:ingest is retired.",
    "",
    "The formulary snapshot now comes from the data-pipeline package:",
    "",
    "  cd data-pipeline && npm run insurance:ingest",
    "  cd .. && npm run content:sync",
    "",
    "See scripts/ingest-formulary.mjs for why.",
  ].join("\n")
);
process.exit(1);
