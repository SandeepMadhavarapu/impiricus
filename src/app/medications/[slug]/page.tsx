import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getMedication,
  listMedicationSlugs,
  productLabel,
  displayStrength,
  displayDosageForm,
  isStale,
  evidenceAgeDays,
} from "@/sources/lib/content/registry";
import { getPublicOrigin, getIntegrationStates } from "@/shared/lib/config";
import { buildShareUrl } from "@/doctor/lib/share";
import { MedicationSection } from "@/patient/components/MedicationSection";
import { ActionBar } from "@/patient/components/ActionBar";
import { ShareSection } from "@/doctor/components/ShareSection";
import { ProvenancePanel } from "@/sources/components/ProvenancePanel";
import { PageOpenBeacon } from "@/patient/components/PageOpenBeacon";
import { AppBar } from "@/shared/components/AppBar";

export const dynamic = "force-static";
export const revalidate = 3600;

interface Params {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return listMedicationSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const resolved = getMedication(slug);
  if (!resolved) return { title: "Medication not found" };

  const name = productLabel(resolved.source);
  return {
    title: `${name} — what it is, benefits and risks`,
    // Share previews carry product information only. Never a session, a
    // referrer, an identifier, or anything about the person sharing.
    description: resolved.record.headline,
    openGraph: {
      title: `${name}`,
      description: resolved.record.headline,
      url: buildShareUrl(getPublicOrigin().origin, slug),
      type: "article",
    },
    robots: { index: false, follow: false },
  };
}

export default async function MedicationPage({ params }: Params) {
  const { slug } = await params;
  const resolved = getMedication(slug);

  // An unknown slug is a real 404. Never fall back to a different medication.
  if (!resolved) notFound();

  const { record, source } = resolved;
  const { origin, source: originSource } = getPublicOrigin();
  const shareUrl = buildShareUrl(origin, slug);
  const name = productLabel(source);
  const stale = isStale(source);
  const ageDays = evidenceAgeDays(source);
  const integrations = getIntegrationStates();

  const brand = source.product.brandName
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());

  return (
    <>
      <PageOpenBeacon />
      <main className="page" id="main">
        <AppBar subtitle="Your medication guide" />
        <header className="med-header">
          <p className="eyebrow">FDA-approved label · plain language</p>
          <h1 className="med-title">{brand}</h1>
          <p className="med-generic">
            {source.product.genericName.toLowerCase()} · {displayStrength(source)}{" "}
            {displayDosageForm(source)} · {source.product.route.join(", ").toLowerCase()}
          </p>
          <p className="med-headline">{record.headline}</p>
        </header>

        <dl className="identity-grid">
          <div className="identity-cell">
            <dt>Strength</dt>
            <dd>{displayStrength(source)}</dd>
          </div>
          <div className="identity-cell">
            <dt>Form</dt>
            <dd style={{ textTransform: "capitalize" }}>{displayDosageForm(source)}</dd>
          </div>
          <div className="identity-cell">
            <dt>Route</dt>
            <dd style={{ textTransform: "capitalize" }}>
              {source.product.route.join(", ").toLowerCase()}
            </dd>
          </div>
          <div className="identity-cell">
            <dt>FDA application</dt>
            <dd>{source.product.applicationNumber}</dd>
          </div>
        </dl>

        {/* Scope note sits above everything: this page is about ONE product. */}
        <section className="card card--info" style={{ marginTop: 18 }} aria-label="What this page covers">
          <p className="card-label" style={{ color: "var(--info-text)" }}>
            What this page covers
          </p>
          <p style={{ fontSize: 15 }}>{record.scopeNote}</p>
        </section>

        {stale ? (
          <section className="card card--warning" style={{ marginTop: 14 }} role="status">
            <p className="card-label">Possibly out of date</p>
            <p style={{ fontSize: 15 }}>
              This content was retrieved {ageDays} days ago. Drug labels change. Check the official
              label linked at the bottom of this page before relying on it.
            </p>
          </section>
        ) : null}

        <ActionBar
          slug={slug}
          productName={name}
          strength={displayStrength(source)}
          dosageForm={source.product.dosageForm}
        />

        <div className="stack" style={{ ["--gap" as string]: "14px" }}>
          {record.sections.map((section) => (
            <MedicationSection key={section.id} section={section} source={source} />
          ))}
        </div>

        <ShareSection
          slug={slug}
          shareUrl={shareUrl}
          productName={name}
          originIsConfigured={originSource === "configured"}
        />

        <ProvenancePanel source={source} integrations={integrations} />

        <footer className="site-footer">
          <p>
            <strong>This is an independent prototype built for a hackathon.</strong> It is not
            affiliated with, endorsed by, or connected to Organon, Impiricus, the FDA, or any
            insurer. Nothing here has been reviewed by a clinician.
          </p>
          <p style={{ marginTop: 10 }}>
            This page summarises the FDA-approved label. It does not include every possible risk or
            answer every medical question, and it is not a substitute for advice from a qualified
            healthcare professional who knows your history. Never start, stop or change a medication
            based on a web page.
          </p>
          <p style={{ marginTop: 10 }}>
            Read the full official label at{" "}
            <a href={source.provenance.humanReadable.dailyMed} target="_blank" rel="noopener noreferrer">
              DailyMed
            </a>
            {" · "}
            <a
              href={source.provenance.humanReadable.medicationGuide}
              target="_blank"
              rel="noopener noreferrer"
            >
              Medication Guide
            </a>
          </p>
          <p style={{ marginTop: 10 }}>
            In a medical emergency in the US, call 911. For a suspected overdose, call Poison Help at{" "}
            <a href="tel:18002221222">1-800-222-1222</a>. For mental-health crisis support, call or
            text <a href="tel:988">988</a>.
          </p>
        </footer>
      </main>
    </>
  );
}
