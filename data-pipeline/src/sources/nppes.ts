import { fetchSource } from "./http.js";
import { SOURCES } from "../config/sources.js";
import { PARSER_VERSION, type Provenance } from "../schemas/index.js";

/**
 * NPPES NPI Registry adapter — OPTIONAL and entirely separate from medication
 * ingestion. Nothing in the medication pipeline imports this module.
 *
 * What NPPES is: a public directory of enumerated National Provider
 * Identifiers with self-reported names, taxonomies and practice locations.
 *
 * What NPPES is NOT, and what this module refuses to imply:
 *   - proof of current licensure
 *   - credentialing, privileges or board certification
 *   - identity authentication of the person
 *   - evidence a provider accepts new patients or any insurance
 *   - evidence of any relationship between a provider and a patient
 *
 * Those limitations travel with every result in `limitations`, so a consumer
 * cannot render a directory hit as a verified clinician without discarding the
 * field deliberately.
 *
 * Targeted queries only. Bulk harvesting is not implemented: the registry
 * publishes a full-file download for that purpose, and scraping the API for it
 * would be both rude and pointless.
 */

const BASE = SOURCES.nppes.baseUrl;

/** Returned with every lookup. Not optional, not removable by accident. */
export const NPPES_LIMITATIONS: readonly string[] = [
  "NPPES enumeration is not proof of current licensure.",
  "NPPES does not credential providers or verify privileges.",
  "NPPES does not authenticate that a person is who the record says they are.",
  "NPPES says nothing about accepting new patients or participating in any insurance network.",
  "NPPES establishes no relationship between a provider and any patient.",
  "Addresses and taxonomies are self-reported by the provider and may be out of date.",
];

export interface NppesProvider {
  npi: string;
  enumerationType: "NPI-1" | "NPI-2" | string;
  isIndividual: boolean;
  name: string;
  credential: string | null;
  primaryTaxonomy: { code: string; description: string; primary: boolean } | null;
  allTaxonomies: Array<{ code: string; description: string; primary: boolean; state: string | null }>;
  practiceLocation: {
    city: string | null;
    state: string | null;
    postalCode: string | null;
    telephone: string | null;
  } | null;
  enumerationDate: string | null;
  lastUpdated: string | null;
  status: string | null;
}

export interface NppesLookupResult {
  query: Record<string, string>;
  resultCount: number;
  providers: NppesProvider[];
  limitations: readonly string[];
  provenance: Provenance;
}

interface RawNppesResult {
  number: number | string;
  enumeration_type?: string;
  basic?: {
    first_name?: string;
    last_name?: string;
    organization_name?: string;
    credential?: string;
    enumeration_date?: string;
    last_updated?: string;
    status?: string;
  };
  taxonomies?: Array<{ code: string; desc: string; primary: boolean; state?: string }>;
  addresses?: Array<{
    address_purpose?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    telephone_number?: string;
  }>;
}

function normalizeProvider(raw: RawNppesResult): NppesProvider {
  const basic = raw.basic ?? {};
  const isIndividual = (raw.enumeration_type ?? "") === "NPI-1";
  const name = isIndividual
    ? [basic.first_name, basic.last_name].filter(Boolean).join(" ")
    : (basic.organization_name ?? "");

  const taxonomies = (raw.taxonomies ?? []).map((t) => ({
    code: t.code,
    description: t.desc,
    primary: Boolean(t.primary),
    state: t.state ?? null,
  }));

  // LOCATION addresses are the practice address; MAILING is not.
  const location = (raw.addresses ?? []).find((a) => a.address_purpose === "LOCATION");

  return {
    npi: String(raw.number),
    enumerationType: raw.enumeration_type ?? "unknown",
    isIndividual,
    name,
    credential: basic.credential ?? null,
    primaryTaxonomy: taxonomies.find((t) => t.primary) ?? null,
    allTaxonomies: taxonomies,
    practiceLocation: location
      ? {
          city: location.city ?? null,
          state: location.state ?? null,
          postalCode: location.postal_code ?? null,
          telephone: location.telephone_number ?? null,
        }
      : null,
    enumerationDate: basic.enumeration_date ?? null,
    lastUpdated: basic.last_updated ?? null,
    status: basic.status ?? null,
  };
}

export interface NppesQuery {
  number?: string;
  firstName?: string;
  lastName?: string;
  organizationName?: string;
  taxonomyDescription?: string;
  state?: string;
  city?: string;
  postalCode?: string;
  limit?: number;
}

/**
 * Targeted NPPES lookup.
 *
 * Requires at least one selective criterion. A query with only a state would
 * return thousands of providers for no legitimate purpose here, so it is
 * rejected rather than paginated.
 */
export async function lookupProviders(
  query: NppesQuery,
  force = false
): Promise<NppesLookupResult> {
  const selective =
    query.number ||
    query.lastName ||
    query.organizationName ||
    (query.taxonomyDescription && (query.state || query.city || query.postalCode));

  if (!selective) {
    throw new Error(
      "NPPES lookup requires a selective criterion: an NPI number, a last name, an organization " +
        "name, or a taxonomy combined with a location. Broad harvesting is not supported."
    );
  }

  const params = new URLSearchParams({ version: "2.1" });
  if (query.number) params.set("number", query.number);
  if (query.firstName) params.set("first_name", query.firstName);
  if (query.lastName) params.set("last_name", query.lastName);
  if (query.organizationName) params.set("organization_name", query.organizationName);
  if (query.taxonomyDescription) params.set("taxonomy_description", query.taxonomyDescription);
  if (query.state) params.set("state", query.state);
  if (query.city) params.set("city", query.city);
  if (query.postalCode) params.set("postal_code", query.postalCode);
  params.set("limit", String(Math.min(query.limit ?? 10, 50)));

  const url = `${BASE}/?${params.toString()}`;
  const { data, capture } = await fetchSource<{
    result_count?: number;
    results?: RawNppesResult[];
    Errors?: Array<{ description?: string }>;
  }>("nppes", url, { label: `nppes-${query.number ?? query.lastName ?? "search"}`, force });

  if (data.Errors?.length) {
    throw new Error(`NPPES rejected the query: ${data.Errors.map((e) => e.description).join("; ")}`);
  }

  return {
    query: Object.fromEntries(params.entries()),
    resultCount: data.result_count ?? 0,
    providers: (data.results ?? []).map(normalizeProvider),
    limitations: NPPES_LIMITATIONS,
    provenance: {
      sourceId: "nppes",
      sourceName: SOURCES.nppes.name,
      url: capture.sanitizedUrl,
      retrievedAt: capture.retrievedAt,
      // NPPES rows carry their own last_updated; the response has no global one.
      sourceEffectiveDate: null,
      sourceIdentifier: query.number ?? null,
      sourceVersion: "2.1",
      rawPath: capture.rawPath,
      contentHash: capture.contentHash,
      captureId: capture.captureId,
      locator: "npiregistry/api",
      parserVersion: PARSER_VERSION,
    },
  };
}
