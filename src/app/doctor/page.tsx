import { NfcTapPoint } from "@/doctor/components/NfcTapPoint";
import { createNfcTarget } from "@/doctor/lib/nfc/target";
import type { Metadata } from "next";
import Link from "next/link";
import { isStale } from "@/sources/lib/content/registry";
import { notFound } from "next/navigation";
import { getPublicOrigin, servesClinicianWorkspace } from "@/shared/lib/config";
import { buildShareUrl, medicationPath } from "@/doctor/lib/share";
import { ProvenancePanel } from "@/sources/components/ProvenancePanel";
import { patientGuide, guideSource } from "@/sources/lib/content/patient-guide";
import { INFORMATION_PENDING } from "@/shared/lib/content-status";
import { ShareSection } from "@/doctor/components/ShareSection";
import { DoctorBar, TabBar } from "@/doctor/components/AppChrome";
import { listGuides, guideProductName, type Guide } from "@/sources/lib/content/catalogue";

/**
 * Rendered per request so the deployment gate reads the live APP_MODE rather
 * than whatever was set when the build ran. See servesClinicianWorkspace().
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Patient Medication Guide | DocUpdate Integration Preview",
};

export default async function DoctorPage({ searchParams }: {
  searchParams: Promise<{ medication?: string | string[] }>;
}) {
  // The clinician workspace is not served on the patient deployment. A patient
  // following a shared link must not be able to walk into a screen built for a
  // prescriber. See servesClinicianWorkspace().
  if (!servesClinicianWorkspace()) notFound();

  const { medication } = await searchParams;
  const guides = listGuides();
  // Only a registered product can be selected, and only by exact slug. No
  // fuzzy match and no default drug: showing the wrong medication is the most
  // damaging failure this product could produce.
  const selectedSlug = typeof medication === "string" ? medication : null;
  const selected = selectedSlug ? guides.find((g) => g.slug === selectedSlug) ?? null : null;

  const { origin, source: originSource } = getPublicOrigin();
  const publicReady = originSource === "configured" && new URL(origin).protocol === "https:"
    && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);

  return (
    <main className="doctor-page" id="main">
      <DoctorBar />

      <div className="doctor-intro">
        <h1>Patient Medication Guide</h1>
        <p>Send prescription data safely and securely.</p>
      </div>

      <div className="doctor-workspace stack">
        <section className="card stack" aria-labelledby="select-heading">
          <p className="step-label">Step 1</p>
          <h2 className="section-title" id="select-heading">Medication library</h2>
          {guides.map((guide) => (
            <Link
              key={guide.slug}
              href={`/doctor?medication=${guide.slug}`}
              className="doctor-medication"
              aria-current={selected?.slug === guide.slug ? "true" : undefined}
            >
              <strong>{guideProductName(guide)}</strong>
              <span>{sourcingLine(guide)}</span>
              <span>{effectiveLine(guide)}</span>
              <span>{selected?.slug === guide.slug ? "Selected ✓" : "Select medication →"}</span>
            </Link>
          ))}
          <p className="tiny">Source-backed education. No clinical review has been performed.</p>
        </section>

        <section className="doctor-preview stack" aria-labelledby="preview-heading">
          <div className="doctor-preview-heading">
            <p className="step-label">Step 2</p>
            <h2 id="preview-heading">Patient guide preview</h2>
          </div>

          {selected ? (
            <>
              <div className="card stack">
                <h3>{guideProductName(selected)}</h3>
                <p className="muted">{patientGuide(selected).headline}</p>
              </div>

              {staleFor(selected) ? (
                <div className="card card--warning" role="status">
                  Possibly out of date. Check the official label before relying on this content.
                </div>
              ) : null}

              <div className="btn-row doctor-preview-actions">
                <Link className="btn" href={medicationPath(selected.slug)} target="_blank" rel="noopener noreferrer">
                  Open patient preview ↗
                </Link>
                <a className="btn btn--primary" href="#share">Send to patient</a>
              </div>

              <div className="card stack" aria-label="What the patient will see">
                <p className="card-label" style={{ color: "var(--text-muted)" }}>
                  What the patient will see
                </p>
                {patientGuide(selected).sections.map((section) => (
                  <details key={section.id} className="doctor-section" data-emphasis={section.emphasis}>
                    <summary>
                      <span>{section.title}</span>
                      {section.emphasis !== "normal" ? <span className="doctor-section-flag" data-emphasis={section.emphasis}>
                        {section.emphasis === "critical" ? "Boxed warning" : "Safety"}
                      </span> : null}
                    </summary>
                    <div className="doctor-section-body">
                      {section.pending ? <p>{INFORMATION_PENDING}</p> : section.plain.map((p, i) => <p key={i}>{p}</p>)}
                      <p className="tiny">{section.citations.length} citation{section.citations.length === 1 ? "" : "s"} from the FDA label.</p>
                    </div>
                  </details>
                ))}
              </div>

              {/*
                Provenance only. The integration row that used to sit here
                announced an unconfigured connection that the screen never
                claims to have, so it answered a question nobody asked and
                read as a defect rather than as care.
              */}
              <ProvenancePanel source={guideSource(selected)} integrations={[]} />
            </>
          ) : (
            <div className="card doctor-empty">
              <span aria-hidden="true" className="doctor-empty-icon">＋</span>
              <h3>{medication ? "Medication unavailable" : "Start with a medication"}</h3>
              <p className="muted">{medication ? "Choose a supported medication from the library." : "Select a medication to see the patient guide, including safety information and its supporting sources."}</p>
            </div>
          )}
        </section>

        <section className="card doctor-share" id="share" aria-label="Share patient guide">
          <p className="step-label">Step 3</p>
          {selected ? <ShareSection key={selected.slug} slug={selected.slug}
            shareUrl={buildShareUrl(origin, selected.slug)} productName={guideProductName(selected)}
            originIsConfigured={publicReady} audience="doctor" contentMode={selected.mode} /> : <>
            <h2 className="section-title">Ready when you are</h2>
            <p className="muted">Select a medication to preview and share its patient guide.</p>
            <button className="btn btn--primary btn--block" disabled>Share with Patient</button>
          </>}
          <NfcTapPoint target={selected && publicReady ? createNfcTarget(selected.slug, origin) : null} />
        </section>
      </div>

      <footer className="site-footer">Public medication education only. No patient record is created. Shared links contain no patient information, doctor session, or prescription details. Education does not replace individualized clinical advice. The surrounding app frame is a visual mockup of where this screen would sit; only this screen is implemented.</footer>
      <TabBar />
    </main>
  );
}

/** What kind of content a patient will get, said plainly in the library row. */
function sourcingLine(guide: Guide): string {
  return guide.mode === "authored"
    ? "Plain-language guide · Citations available"
    : "FDA label text · Not yet rewritten";
}

function effectiveLine(guide: Guide): string {
  if (guide.mode === "authored") {
    return isStale(guide.authored.source)
      ? "Source refresh needed"
      : `Label effective ${guide.authored.source.document.effectiveDate}`;
  }
  return `Label effective ${guide.label.freshness.sourceEffectiveDate}`;
}

/** Staleness is only computed where the app tracks a retrieval timestamp. */
function staleFor(guide: Guide): boolean {
  return guide.mode === "authored" ? isStale(guide.authored.source) : false;
}
