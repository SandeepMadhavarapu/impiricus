import "server-only";
import topRol from "@/sources/content/sources/toprol-xl-metoprolol-succinate-50mg-er-tablet.json";
import ozempic from "@/sources/content/sources/ozempic-semaglutide-1_34mg-per-ml-injection.json";
import { singulair10mgTablet } from "@/sources/content/medications/singulair-montelukast-10mg-tablet";
import { SourceRecordSchema, patientScopeNote, type PlainSection, type KeyPoint, type SourceRecord } from "./types";
import { guideProductName, type Guide } from "./catalogue";
import { displayStrength } from "./registry";

import { INFORMATION_PENDING } from "@/shared/lib/content-status";
export type PatientGuideSection = PlainSection & { pending?: boolean };
const references = new Map([topRol, ozempic].map(raw => {
  const source = SourceRecordSchema.parse(raw);
  return [source.recordId, source] as const;
}));

/** Source text is fetched separately from the authored patient summaries. */
export function guideSource(guide: Guide): SourceRecord {
  if (guide.mode === "authored") return guide.authored.source;
  const source = references.get(guide.slug);
  if (!source || source.document.splSetId !== guide.label.identifiers.splSetId ||
      source.product.productNdc !== guide.label.identifiers.productNdc) {
    throw new Error(`Missing or mismatched source for ${guide.slug}`);
  }
  return source;
}

export function patientGuide(guide: Guide) {
  const source = guideSource(guide);
  const authored = guide.mode === "authored" ? guide.authored.record : null;
  const strength = guide.mode === "authored" ? displayStrength(source) : guide.label.display.strengthDisplay;
  const scopeNote = authored ? patientScopeNote(authored) : guide.mode === "official-label" ? guide.scopeNote : "";
  const boxed = source.sections.find(s => s.id === "boxed_warning");
  const keyPoints: KeyPoint[] = authored?.keyPoints ?? [{
    text: boxed ? "This medication has an FDA boxed warning. Read the important safety information below."
      : "Read the important safety information and the full official label before relying on this guide.",
    emphasis: boxed ? "critical" : "warning",
    seeSectionId: "boxed-warning",
  }];
  // Same slots and component tree as the first guide. Never manufacture a
  // patient summary or reuse another medication's clinical claims to fill it.
  const sections: PatientGuideSection[] = authored?.sections ?? singulair10mgTablet.sections.map(template => {
    if (template.id === "boxed-warning") {
      return {
        id: template.id,
        title: boxed ? "FDA Boxed Warning: important safety information" : "Important safety information",
        emphasis: boxed ? "critical" as const : "warning" as const,
        plain: boxed ? [boxed.text] : [],
        detail: boxed ? [INFORMATION_PENDING] : undefined,
        pending: !boxed,
        citations: boxed ? [{ sectionId: boxed.id, quote: boxed.text }] : [],
      };
    }
    return { id: template.id, title: template.title, emphasis: template.emphasis, plain: [], citations: [], pending: true };
  });
  return {
    source, name: guideProductName(guide), strength, scopeNote, keyPoints, sections,
    brand: source.product.brandName.toLowerCase().replace(/^./, c => c.toUpperCase()),
    headline: authored?.headline ?? INFORMATION_PENDING,
    authored: Boolean(authored),
  };
}

/**
 * The new products use independently fetched, identity-checked openFDA text,
 * never the mixed-content SPL table export. Dosing/device documents remain
 * excluded until exact-product applicability is verified.
 */
export function chatGuide(guide: Guide) {
  const source = guideSource(guide);
  const scopeNote = guide.mode === "authored" ? guide.authored.record.scopeNote :
    `${guide.scopeNote} These excerpts describe the shared FDA label; they are not personal dosing or device instructions. Follow your own prescription.`;
  const excluded = new Set(["dosage_and_administration", "dosage_forms_and_strengths", "spl_medguide", "information_for_patients", "how_supplied"]);
  return {
    source: guide.mode === "authored" ? source : { ...source, recordId: `${source.recordId}:general-label`, sections: source.sections.filter(s => !excluded.has(s.id)) },
    scopeNote,
    name: guideProductName(guide),
  };
}
