import type { Metadata } from "next";
import Link from "next/link";
import { isStale } from "@/sources/lib/content/registry";
import { notFound } from "next/navigation";
import { getPublicOrigin, servesClinicianWorkspace } from "@/shared/lib/config";
import { buildShareUrl, medicationPath } from "@/doctor/lib/share";
import { ProvenancePanel } from "@/sources/components/ProvenancePanel";
import { LabelSection } from "@/sources/components/LabelSection";
import { ShareSection } from "@/doctor/components/ShareSection";
import { DoctorBar, TabBar } from "@/doctor/components/AppChrome";
import { listGuides, guideProductName, type Guide } from "@/sources/lib/content/catalogue";

export const metadata: Metadata = {
  title: "Patient Medication Guide | DocUpdate Integration Preview",
};

/**
 * Rendered per request so the F-06 deployment gate reads the live APP_MODE.
 *
 * Next prerendered this page at build time, which froze the gate into the
 * build output. Both deployments build from the same commit, so whether the
 * clinician workspace existed would then depend on APP_MODE being present
 * during the BUILD rather than at runtime - and a clinician deployment whose
 * variable is only set at runtime would ship a 404 as its home page.
 */
export const dynamic = "force-dynamic";

export default async function DoctorPage({ searchParams }: {
  searchParams: Promise<{ medication?: string | string[] }>;
}) {
  // F-06: the clinician workspace is not served on the patient deployment.
  // A patient following a shared link must not be able to walk into a screen
  // built for a prescriber. See servesClinicianWorkspace().
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
                {selected.mode === "authored" ? (
                  <p className="muted">{selected.authored.record.headline}</p>
                ) : (
                  <p className="muted">
                    No plain-language guide has been written for this product. The patient sees the
                    label&rsquo;s own words, and the page says so.
                  </p>
                )}
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
                {selected.mode === "authored" ? (
                  selected.authored.record.sections.map((section) => (
                    <details key={section.id} className="doctor-section" data-emphasis={section.emphasis}>
                      <summary>
                        <span>{section.title}</span>
                        {section.emphasis !== "normal" ? (
                          <span className="doctor-section-flag" data-emphasis={section.emphasis}>
                            {section.emphasis === "critical" ? "Boxed warning" : "Safety"}
                          </span>
                        ) : null}
                      </summary>
                      <div className="doctor-section-body">
                        {section.plain.map((p, i) => (
                          <p key={i}>{p}</p>
                        ))}
                        <p className="tiny">
                          {section.citations.length} citation{section.citations.length === 1 ? "" : "s"} from the FDA label.
                        </p>
                      </div>
                    </details>
                  ))
                ) : (
                  <>
                    {/*
                      Boxed warning first when the document has one. Its absence
                      is never stated: a section missing from a document is a
                      fact about the document, not about the drug.
                    */}
                    {selected.boxedWarning ? (
                      <details className="doctor-section" data-emphasis="critical" open>
                        <summary>
                          <span>{selected.boxedWarning.title ?? "FDA boxed warning"}</span>
                          <span className="doctor-section-flag" data-emphasis="critical">
                            Boxed warning
                          </span>
                        </summary>
                        <div className="doctor-section-body">
                          <LabelSection section={selected.boxedWarning} />
                        </div>
                      </details>
                    ) : null}

                    {/*
                      F-11: the same dosing limitation the patient sees.

                      The preview previously omitted it, so a clinician
                      reviewing before sharing saw a different framing from the
                      one the patient receives - in exactly the sentence that
                      constrains how the rest is read. Phrased for a clinician
                      rather than copying the patient card wholesale.
                    */}
                    <p className="tiny" style={{ marginBottom: 10 }}>
                      <strong>No dosing is shown to the patient.</strong> One SPL
                      commonly covers several products at different strengths, and
                      most sections are not bound to any one of them, so the guide
                      points the reader at their own prescription instead.
                    </p>
                    {selected.patientSections.map((section, i) => (
                      <details key={i} className="doctor-section">
                        <summary>
                          <span>{section.title ?? "From the label"}</span>
                        </summary>
                        <div className="doctor-section-body">
                          <LabelSection section={section} />
                        </div>
                      </details>
                    ))}

                    {/*
                      What this label carries that the page does not show.
                      A clinician in particular needs to know a section exists
                      and was withheld, rather than infer the label is silent.
                    */}
                    {selected.withheldSections.length > 0 ? (
                      <div className="tiny" style={{ marginTop: 10, opacity: 0.85 }}>
                        <strong>{selected.withheldSections.length}</strong> patient section
                        {selected.withheldSections.length === 1 ? "" : "s"} withheld:{" "}
                        {selected.withheldSections
                          .map(
                            (w) =>
                              `${w.title?.trim() ? w.title : "untitled"} (${
                                w.reason === "belongs-to-another-product"
                                  ? `assigned to ${
                                      w.appliesToProducts.length > 0
                                        ? w.appliesToProducts.join("; ")
                                        : "another product"
                                    }`
                                  : "product not specified by the document"
                              })`
                          )
                          .join(" \u00b7 ")}
                      </div>
                    ) : null}

                    <p className="tiny">
                      Label text, word for word. The patient page shows no doses for this product:
                      this one label covers {selected.label.document.productsInDocument.length}{" "}
                      products at different strengths, so a dose shown could belong to another one.
                    </p>
                  </>
                )}
              </div>

              {selected.mode === "authored" ? (
                <ProvenancePanel source={selected.authored.source} integrations={[{
                  id: "docupdate", name: "DocUpdate", status: "unconfigured",
                  capability: "Integration preview only. No DocUpdate or Impiricus connection exists.", requires: [],
                }]} />
              ) : (
                <div className="card card--flat stack">
                  <p className="card-label" style={{ color: "var(--text-muted)" }}>
                    Where this came from
                  </p>
                  <p className="tiny">
                    {selected.label.document.title}
                  </p>
                  <p className="tiny">
                    SPL v{selected.label.identifiers.splVersion ?? "?"}, effective{" "}
                    {selected.label.freshness.sourceEffectiveDate}. Retrieved{" "}
                    {selected.label.freshness.ingestedAt.slice(0, 10)}. Identity{" "}
                    {selected.label.verification.resolutionState}. No clinical review has been
                    performed.
                  </p>
                </div>
              )}
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
            originIsConfigured={publicReady} audience="doctor" /> : <>
            <h2 className="section-title">Ready when you are</h2>
            <p className="muted">Select a medication to preview and share its patient guide.</p>
            <button className="btn btn--primary btn--block" disabled>Share with Patient</button>
          </>}
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
