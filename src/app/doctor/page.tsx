import type { Metadata } from "next";
import Link from "next/link";
import { listMedications, productLabel, isStale } from "@/sources/lib/content/registry";
import { getPublicOrigin } from "@/shared/lib/config";
import { buildShareUrl, medicationPath } from "@/doctor/lib/share";
import { MedicationSection } from "@/patient/components/MedicationSection";
import { ProvenancePanel } from "@/sources/components/ProvenancePanel";
import { ShareSection } from "@/doctor/components/ShareSection";
import { AppBar, TabBar } from "@/doctor/components/AppChrome";

export const metadata: Metadata = {
  title: "MedBridge for HCPs — DocUpdate Integration Preview",
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
      <AppBar />
      <div className="doctor-hero">
        <p className="eyebrow">DocUpdate Integration Preview</p>
        <h1>Create a patient medication guide</h1>
        <p>Select medication education grounded in the FDA-approved label, preview the guide, and share it directly with a patient.</p>
        <p className="doctor-hero-note">Independent demo. No integration with or endorsement by DocUpdate or Impiricus.</p>
      </div>
      <ol className="doctor-steps" aria-label="Guide workflow">
        <li><span aria-hidden="true">1</span> Select</li>
        <li><span aria-hidden="true">2</span> Preview</li>
        <li><span aria-hidden="true">3</span> Share</li>
      </ol>
      <div className="doctor-workspace stack">
        <section className="card stack" aria-labelledby="select-heading">
          <p className="eyebrow">01 / Select</p>
          <h2 className="section-title" id="select-heading">Medication library</h2>
          <p className="muted">One supported strength and form in this demo.</p>
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
            <div><p className="eyebrow">02 / Preview</p><h2 id="preview-heading">Patient guide preview</h2></div>
            {selected ? <Link className="btn" href={medicationPath(selected.record.slug)} target="_blank" rel="noopener noreferrer">Open patient view ↗</Link> : null}
          </div>
          {selected ? <>
            <div className="card stack">
              <p className="eyebrow">FDA-approved label · plain language</p>
              <h3>{productLabel(selected.source)}</h3>
              <p>{selected.record.headline}</p>
              <p className="muted">{selected.record.scopeNote}</p>
            </div>
            {isStale(selected.source) ? <div className="card card--warning" role="status">Possibly out of date. Check the official label before relying on this content.</div> : null}
            {selected.record.sections.map((section) => <MedicationSection key={section.id} section={section} source={selected.source} />)}
            <ProvenancePanel source={selected.source} integrations={[{
              id: "docupdate", name: "DocUpdate", status: "unconfigured",
              capability: "Integration preview only. No DocUpdate or Impiricus connection exists.", requires: [],
            }]} />
          </> : <div className="card doctor-empty">
            <span aria-hidden="true" className="doctor-empty-icon">＋</span>
            <h3>{medication ? "Medication unavailable" : "Start with a medication"}</h3>
            <p className="muted">{medication ? "Choose a supported medication from the library." : "Select a medication to see the patient guide, including safety information and its supporting sources."}</p>
          </div>}
        </section>
        <section className="card doctor-share" aria-label="Share patient guide">
          <p className="eyebrow">03 / Share</p>
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
