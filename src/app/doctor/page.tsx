import type { Metadata } from "next";
import Link from "next/link";
import { listMedications, productLabel, isStale } from "@/sources/lib/content/registry";
import { getPublicOrigin } from "@/shared/lib/config";
import { buildShareUrl, medicationPath } from "@/doctor/lib/share";
import { ProvenancePanel } from "@/sources/components/ProvenancePanel";
import { ShareSection } from "@/doctor/components/ShareSection";
import { DoctorBar, TabBar } from "@/doctor/components/AppChrome";

export const metadata: Metadata = {
  title: "Patient Medication Guide | DocUpdate Integration Preview",
};

export default async function DoctorPage({ searchParams }: {
  searchParams: Promise<{ medication?: string | string[] }>;
}) {
  const { medication } = await searchParams;
  const medications = listMedications();
  // Only registered products can be selected. No fuzzy match or default drug.
  const selected = medications.find(({ record }) => record.slug === medication);
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
          {medications.map(({ record, source }) => (
            <Link key={record.slug} href={`/doctor?medication=${record.slug}`} className="doctor-medication"
              aria-current={selected?.record.slug === record.slug ? "true" : undefined}>
              <strong>{productLabel(source)}</strong>
              <span>FDA-label sourced · Citations available</span>
              <span>{isStale(source) ? "Source refresh needed" : `Label effective ${source.document.effectiveDate}`}</span>
              <span>{selected?.record.slug === record.slug ? "Selected ✓" : "Select medication →"}</span>
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
              {/*
                The clinician already knows this drug. They are checking what
                the patient will be shown, so the identity line stays short and
                the content itself collapses to headings: scannable in a
                consult, expandable when something needs checking.
              */}
              <div className="card stack">
                <h3>{productLabel(selected.source)}</h3>
                <p className="muted">{selected.record.headline}</p>
              </div>

              {isStale(selected.source) ? (
                <div className="card card--warning" role="status">
                  Possibly out of date. Check the official label before relying on this content.
                </div>
              ) : null}

              <div className="btn-row doctor-preview-actions">
                <Link className="btn" href={medicationPath(selected.record.slug)} target="_blank" rel="noopener noreferrer">
                  Open patient preview ↗
                </Link>
                {/*
                  Sends by handing the guide to the share step below, which is
                  the only delivery this app actually has. It does not claim to
                  transmit anything to a patient record.
                */}
                <a className="btn btn--primary" href="#share">Send to patient</a>
              </div>

              <div className="card stack" aria-label="What the patient will see">
                <p className="card-label" style={{ color: "var(--text-muted)" }}>
                  What the patient will see
                </p>
                {selected.record.sections.map((section) => (
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
                ))}
              </div>

              <ProvenancePanel source={selected.source} integrations={[{
                id: "docupdate", name: "DocUpdate", status: "unconfigured",
                capability: "Integration preview only. No DocUpdate or Impiricus connection exists.", requires: [],
              }]} />
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
          {selected ? <ShareSection key={selected.record.slug} slug={selected.record.slug}
            shareUrl={buildShareUrl(origin, selected.record.slug)} productName={productLabel(selected.source)}
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
