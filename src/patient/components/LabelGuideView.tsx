import type { LabelGuide } from "@/sources/lib/content/catalogue";
import type { IntegrationState } from "@/shared/lib/config";
import { LabelSection } from "@/sources/components/LabelSection";
import { ShareSection } from "@/doctor/components/ShareSection";
import { PageOpenBeacon } from "@/patient/components/PageOpenBeacon";
import { AppBar } from "@/shared/components/AppBar";

/**
 * Patient page for a product with no authored plain-language layer.
 *
 * The difference from the authored page is the whole point, so the page says
 * it in the first thing under the title: these are the label's own words, not
 * a rewrite. Presenting label text in the same voice as a carefully authored
 * guide would be a claim about the work that went into it.
 *
 * What is deliberately NOT here:
 *
 *   No dosing and no administration steps. One FDA label routinely covers
 *   several products dosed differently, and most sections are not bound to
 *   any one of them, so a dose shown here could belong to another strength.
 *   The page sends the reader to their own prescription and to the full
 *   label instead.
 *
 *   No "no boxed warning" and no other absence claim. A section missing from
 *   a document is a fact about the document, not about the drug.
 *
 *   No headline and no key points. Those are written by a person on the
 *   authored path, and there is nobody to write them here.
 */
export function LabelGuideView({
  guide,
  slug,
  shareUrl,
  originIsConfigured,
  integrations,
}: {
  guide: LabelGuide;
  slug: string;
  shareUrl: string;
  originIsConfigured: boolean;
  integrations: IntegrationState[];
}) {
  const { label } = guide;
  const brand = (label.display.brandName ?? label.display.genericName)
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());

  return (
    <>
      <PageOpenBeacon />
      <main className="page" id="main">
        <AppBar subtitle="Your medication guide" />

        <header className="med-header">
          <p className="eyebrow">From the FDA-approved label</p>
          <h1 className="med-title">{brand}</h1>
          <p className="med-generic">
            {label.display.genericName.toLowerCase()} · {label.display.strengthDisplay}{" "}
            {label.display.dosageForm.toLowerCase()} ·{" "}
            {label.display.route.join(", ").toLowerCase()}
          </p>
          <p className="med-headline">
            This page shows what the official FDA label says about this medicine, in the label&rsquo;s
            own words. Nobody has rewritten it into simpler language yet.
          </p>
        </header>

        <dl className="identity-grid">
          <div className="identity-cell">
            <dt>Strength</dt>
            <dd>{label.display.strengthDisplay}</dd>
          </div>
          <div className="identity-cell">
            <dt>Form</dt>
            <dd style={{ textTransform: "capitalize" }}>
              {label.display.dosageForm.toLowerCase()}
            </dd>
          </div>
          <div className="identity-cell">
            <dt>Route</dt>
            <dd style={{ textTransform: "capitalize" }}>
              {label.display.route.join(", ").toLowerCase()}
            </dd>
          </div>
          <div className="identity-cell">
            <dt>FDA application</dt>
            <dd>{label.identifiers.applicationNumber ?? "Not available"}</dd>
          </div>
        </dl>

        <section
          className="card card--info"
          style={{ marginTop: 18 }}
          aria-label="What this page covers"
        >
          <p className="card-label" style={{ color: "var(--info-text)" }}>
            What this page covers
          </p>
          <p style={{ fontSize: 15 }}>{guide.scopeNote}</p>
        </section>

        {/*
          Rendered only when the document actually carries a boxed warning.
          Its absence is never stated: see boxedWarning() in
          src/sources/lib/content/label.ts.
        */}
        {guide.boxedWarning ? (
          <section
            className="card card--critical"
            style={{ marginTop: 14 }}
            aria-labelledby="boxed-warning-heading"
          >
            <p className="card-label">FDA boxed warning</p>
            <p className="tiny" style={{ marginBottom: 10 }}>
              The FDA&rsquo;s most serious type of warning, shown here word for word.
            </p>
            <div id="boxed-warning-heading">
              <LabelSection section={guide.boxedWarning} />
            </div>
          </section>
        ) : null}

        {/* Dosing is deliberately absent. See the note at the top of this file. */}
        <section className="card card--warning" style={{ marginTop: 14 }}>
          <p className="card-label">How much to take</p>
          <p style={{ fontSize: 15 }}>
            This page does not show doses. One FDA label often covers several products at different
            strengths, taken in different ways, so a dose shown here might belong to a different
            one. Follow the directions on your own prescription, and ask your pharmacist or
            prescriber if anything is unclear.
          </p>
        </section>

        {guide.patientSections.length > 0 ? (
          <section className="stack" style={{ marginTop: 18 }} aria-label="From the label">
            <h2 className="section-title">What the label tells patients</h2>
            <p className="tiny">
              Official text from the label, word for word. It is written for clinical accuracy
              rather than for easy reading.
            </p>
            {guide.patientSections.map((section, i) => (
              <div className="card" key={i}>
                <LabelSection section={section} />
              </div>
            ))}
          </section>
        ) : null}

        <section className="card" style={{ marginTop: 18 }}>
          <p className="card-label" style={{ color: "var(--text-muted)" }}>
            Read the full label
          </p>
          <p style={{ fontSize: 15 }}>
            Everything on this page comes from the official label. You can read all of it, including
            the parts not shown here.
          </p>
          <div className="btn-row" style={{ marginTop: 14 }}>
            <a
              className="btn"
              href={label.document.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Full label on DailyMed
            </a>
            <a
              className="btn"
              href={label.document.medicationGuideUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Medication Guide
            </a>
          </div>
        </section>

        <ShareSection
          slug={slug}
          shareUrl={shareUrl}
          productName={guide.productName}
          originIsConfigured={originIsConfigured}
        />

        <section className="card card--flat" style={{ marginTop: 18 }}>
          <p className="card-label" style={{ color: "var(--text-muted)" }}>
            Where this came from
          </p>
          <dl className="identity-grid" style={{ marginTop: 0 }}>
            <div className="identity-cell">
              <dt>Label effective</dt>
              <dd>{label.freshness.sourceEffectiveDate}</dd>
            </div>
            <div className="identity-cell">
              <dt>Retrieved</dt>
              <dd>{label.freshness.ingestedAt.slice(0, 10)}</dd>
            </div>
            <div className="identity-cell">
              <dt>Label version</dt>
              <dd>SPL v{label.identifiers.splVersion ?? "?"}</dd>
            </div>
            <div className="identity-cell">
              <dt>Clinically reviewed</dt>
              <dd>No</dd>
            </div>
          </dl>
          <p className="tiny" style={{ marginTop: 12 }}>
            {label.clinicalReview.note}
          </p>
          {label.notProvided.length > 0 ? (
            <>
              <p className="tiny" style={{ marginTop: 12, fontWeight: 600 }}>
                This page does not establish:
              </p>
              <ul className="checklist">
                {label.notProvided.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="tiny" style={{ marginTop: 12 }}>
            Connected integrations:{" "}
            {integrations.filter((i) => i.status === "configured").length} of {integrations.length}.
          </p>
        </section>

        <footer className="site-footer">
          <p>
            <strong>This is an independent prototype built for a hackathon.</strong> It is not
            affiliated with, endorsed by, or connected to any manufacturer, insurer or regulator.
            Nothing here has been reviewed by a clinician.
          </p>
          <p style={{ marginTop: 10 }}>
            This page reproduces parts of an FDA-approved label. It does not include every possible
            risk or answer every medical question, and it is not a substitute for advice from a
            qualified healthcare professional who knows your history. Never start, stop or change a
            medication based on a web page.
          </p>
          <p style={{ marginTop: 10 }}>
            In a medical emergency in the US, call 911. For a suspected overdose, call Poison Help
            at <a href="tel:18002221222">1-800-222-1222</a>. For mental-health crisis support, call
            or text <a href="tel:988">988</a>.
          </p>
        </footer>
      </main>
    </>
  );
}
