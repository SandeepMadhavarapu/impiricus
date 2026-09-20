import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  isStale,
  evidenceAgeDays,
} from "@/sources/lib/content/registry";
import { patientGuide } from "@/sources/lib/content/patient-guide";
import {
  getGuide,
  listGuideSlugs,
  guideProductName,
  type Guide,
} from "@/sources/lib/content/catalogue";
import { getPublicOrigin, getIntegrationStates } from "@/shared/lib/config";
import { buildShareUrl } from "@/doctor/lib/share";
import { MedicationSection } from "@/patient/components/MedicationSection";
import { ActionBar } from "@/patient/components/ActionBar";
import { ReadAloud } from "@/patient/components/ReadAloud";
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
  return listGuideSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const guide = getGuide(slug);
  if (!guide) return { title: "Medication not found" };

  const name = guideProductName(guide);
  // An authored guide has a headline written for a lay reader. A label-sourced
  // one does not, and a description is not worth inventing one for, so it
  // falls back to naming the product and what the page is.
  const description =
    guide.mode === "authored"
      ? guide.authored.record.headline
      : `Information about ${name}, taken from its FDA-approved label.`;

  return {
    title: `${name}: what it is, benefits and risks`,
    // Share previews carry product information only. Never a session, a
    // referrer, an identifier, or anything about the person sharing.
    description,
    openGraph: {
      title: `${name}`,
      description,
      url: buildShareUrl(getPublicOrigin().origin, slug),
      type: "article",
    },
    robots: { index: false, follow: false },
  };
}

export default async function MedicationPage({ params }: Params) {
  const { slug } = await params;
  const guide = getGuide(slug);

  // An unknown slug is a real 404. Never fall back to a different medication.
  if (!guide) notFound();

  return <PatientGuideView guide={guide} slug={slug} />;
}

/** All products share the authored guide's layout and interactive tools. */
function PatientGuideView({ guide, slug }: { guide: Guide; slug: string }) {
  const view = patientGuide(guide);
  const { source, name, strength, brand } = view;
  const { origin, source: originSource } = getPublicOrigin();
  const shareUrl = buildShareUrl(origin, slug);
  const stale = isStale(source);
  const ageDays = evidenceAgeDays(source);
  const integrations = getIntegrationStates();

  return (
    <>
      <PageOpenBeacon />
      <main className="page" id="main">
        <AppBar subtitle="Your medication guide" />
        <header className="med-header">
          <p className="eyebrow">From the FDA-approved label</p>
          <h1 className="med-title">{brand}</h1>
          <p className="med-generic">
            {source.product.genericName.toLowerCase()} · {strength}{" "}
            {source.product.dosageForm.toLowerCase()} · {source.product.route.join(", ").toLowerCase()}
          </p>
          <p className="med-headline">{view.headline}</p>

          {/*
            Fair balance. The headline states what the product is for; these
            carry what must travel with it. Critical points are listed first
            by the content schema and are never rendered smaller than the rest.
          */}
          {view.keyPoints.length > 0 ? (
            <ul className="key-points">
              {view.keyPoints.map((point, i) => (
                <li key={i} data-emphasis={point.emphasis}>
                  {point.seeSectionId ? (
                    <a href={`#sec-${point.seeSectionId}`}>{point.text}</a>
                  ) : (
                    point.text
                  )}
                </li>
              ))}
            </ul>
          ) : null}

          {/*
            Optional read-aloud, for the summary and key points ONLY.
            
            The same words that are on the screen, in the order they appear. It
            deliberately stops before the identity grid and the label sections:
            a dosage table read as a sentence stops being a table, and the
            professional labeling below is not written for a lay listener.
          */}
          <ReadAloud
            lang="en-US"
            label="this summary"
            text={[view.headline, ...view.keyPoints.map((p) => p.text)].join(" ")}
          />
        </header>

        <dl className="identity-grid">
          <div className="identity-cell">
            <dt>Strength</dt>
            <dd>{strength}</dd>
          </div>
          <div className="identity-cell">
            <dt>Form</dt>
            <dd style={{ textTransform: "capitalize" }}>{source.product.dosageForm.toLowerCase()}</dd>
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

        {/*
          Scope note sits above everything: this page is about ONE product.
          Patients get the plain version, written for someone reading in a
          second language or reading while unwell. See patientScopeNote().
        */}
        <section className="card card--info" style={{ marginTop: 18 }} aria-label="What this page covers">
          <p className="card-label" style={{ color: "var(--info-text)" }}>
            What this page covers
          </p>
          <p style={{ fontSize: 15 }}>{view.scopeNote}</p>
          {!view.authored ? <p className="tiny" style={{ marginTop: 10 }}>
            Patient summaries are still being prepared. Available source text is in the label’s own words.
            This page does not show doses. Follow your prescription and ask your pharmacist or prescriber about dosing.
          </p> : null}
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
          strength={strength}
          dosageForm={source.product.dosageForm}
        />

        <div className="stack" style={{ ["--gap" as string]: "14px" }}>
          {view.sections.map((section) => (
            <MedicationSection key={section.id} section={section} source={source} />
          ))}
        </div>

        <ShareSection
          slug={slug}
          shareUrl={shareUrl}
          productName={name}
          contentMode={guide.mode}
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
            This page provides information from the FDA-approved label. It does not include every possible risk or
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
