import type { LabelGuide } from "@/sources/lib/content/catalogue";
import { displayCase } from "@/sources/lib/content/label";
import type { IntegrationState } from "@/shared/lib/config";
import { LabelSection } from "@/sources/components/LabelSection";
import { ShareSection } from "@/doctor/components/ShareSection";
import { ActionBar } from "@/patient/components/ActionBar";
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
  // One casing rule for the whole app. A local lowercase-then-capitalise here
  // rendered "TOPROL XL" as "Toprol xl" even after the shared helper was fixed,
  // because it was a third, separate implementation.
  const brand = displayCase(label.display.brandName ?? label.display.genericName);

  /**
   * The same hero format as an authored guide, built only from facts this page
   * already establishes elsewhere.
   *
   * An authored guide's key points are written by a person. There is no such
   * layer here, and generating plain-language medical prose from a label is
   * precisely what this codebase exists not to do - a generated bullet would be
   * indistinguishable, to a reader, from one a clinician wrote.
   *
   * So every bullet below is either a structural fact about the document (it
   * carries a boxed warning; it covers N products) or a statement about what
   * this page does (it shows no doses). Each already appears further down the
   * page; surfacing it here changes the layout, not the claims. Where the label
   * has a boxed warning, its OWN heading is quoted rather than summarised.
   */
  const otherProducts = label.document.productsInDocument.length - 1;
  const boxedTitle = guide.boxedWarning?.title?.trim();

  const keyPoints: Array<{
    text: string;
    emphasis: "normal" | "warning" | "critical";
    href?: string;
  }> = [];

  if (guide.boxedWarning) {
    keyPoints.push({
      text: boxedTitle
        ? `This medication has an FDA boxed warning, the FDA\u2019s most serious warning. The label titles it \u201c${boxedTitle}\u201d.`
        : "This medication has an FDA boxed warning, the FDA\u2019s most serious warning.",
      emphasis: "critical",
      href: "#boxed-warning",
    });
  }

  if (otherProducts > 0) {
    keyPoints.push({
      text: `The same FDA label also covers ${otherProducts} other product${
        otherProducts === 1 ? "" : "s"
      } at different strengths or in different forms. Those are taken differently.`,
      emphasis: "warning",
    });
  }

  keyPoints.push({
    text: "This page does not show doses. Follow the directions on your own prescription.",
    emphasis: "normal",
  });

  if (guide.withheldSections.length > 0) {
    keyPoints.push({
      text: `${guide.withheldSections.length} section${
        guide.withheldSections.length === 1 ? "" : "s"
      } of this label are not shown here, because the document ties them to a different product.`,
      emphasis: "normal",
      href: "#not-shown",
    });
  }

  return (
    <>
      <PageOpenBeacon />
      <main className="page" id="main">
        <AppBar subtitle="Your medication guide" />

        <div className="med-header">
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

          {/*
            Same markup and same class as an authored guide's key points, so the
            two kinds of page present identically. Only the source of the
            bullets differs, and that difference is stated in the headline above.
          */}
          {keyPoints.length > 0 ? (
            <ul className="key-points">
              {keyPoints.map((point, i) => (
                <li key={i} data-emphasis={point.emphasis}>
                  {point.href ? <a href={point.href}>{point.text}</a> : point.text}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

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
            id="boxed-warning"
            className="card card--critical"
            style={{ marginTop: 14 }}
            aria-labelledby="boxed-warning-heading"
          >
            <h2 className="card-label">FDA boxed warning</h2>
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

        {/*
          Sections this label carries that are NOT shown here.

          Withholding silently is its own failure: a reader cannot tell "the
          label says nothing about using the device" apart from "we decided not
          to show you what it says". The count and the reason are stated, and
          the full label is linked below.
        */}
        {guide.withheldSections.length > 0 ? (
          <section id="not-shown" className="card" style={{ marginTop: 14 }} aria-label="Not shown here">
            <p className="card-label" style={{ color: "var(--text-muted)" }}>
              Not shown on this page
            </p>
            <p style={{ fontSize: 15 }}>
              This FDA label also contains {guide.withheldSections.length} patient
              section{guide.withheldSections.length === 1 ? "" : "s"} that{" "}
              {guide.withheldSections.length === 1 ? "is" : "are"} not shown here, because the
              document ties {guide.withheldSections.length === 1 ? "it" : "them"} to a different
              product or does not say which product {guide.withheldSections.length === 1 ? "it" : "they"}{" "}
              apply to.
            </p>
            <ul className="tiny" style={{ marginTop: 10, paddingLeft: 18 }}>
              {guide.withheldSections.map((w, i) => (
                <li key={i} style={{ marginBottom: 6 }}>
                  {w.title?.trim() ? w.title : "Untitled section"} &mdash;{" "}
                  {w.reason === "belongs-to-another-product"
                    ? `the label assigns this to ${
                        w.appliesToProducts.length > 0
                          ? w.appliesToProducts.join(", ")
                          : "another product"
                      }`
                    : "the label does not say which product this applies to"}
                </li>
              ))}
            </ul>
            <p className="tiny" style={{ marginTop: 10 }}>
              If you have one of those products, read its own instructions. Device instructions
              differ between pens and strengths.
            </p>
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

        {/*
          Coverage and the provider step work for any product: they need the
          slug, name, strength and form, all of which a label-sourced guide has.
          Only the assistant needs an authored layer, so only it is withheld.
        */}
        <ActionBar
          slug={guide.slug}
          productName={guide.productName}
          strength={label.display.strengthDisplay}
          dosageForm={label.display.dosageForm}
          assistant="no-authored-layer"
        />

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
          <p style={{ marginTop: 10 }}>In a medical emergency in the US:</p>
          {/*
           * F-05: all three numbers are dialable, equally sized targets.
           *
           * Previously 911 was plain text, Poison Help was a 38px target that
           * collapsed to 17px on a phone, and 988 - the crisis line, on a page
           * whose boxed warning concerns neuropsychiatric events - was a 21x17
           * target at 13px. That is precision tapping for the reader least able
           * to do it.
           *
           * Rendered as a list of tel: links so each has a >=44px hit area at
           * every width, with the purpose beside the number rather than hidden
           * behind it.
           */}
          <ul className="emergency-list">
            <li>
              <a className="emergency-tel" href="tel:911">
                <span className="emergency-tel__number">911</span>
                <span className="emergency-tel__what">Emergency services</span>
              </a>
            </li>
            <li>
              <a className="emergency-tel" href="tel:18002221222">
                <span className="emergency-tel__number">1-800-222-1222</span>
                <span className="emergency-tel__what">Poison Help &mdash; suspected overdose</span>
              </a>
            </li>
            <li>
              <a className="emergency-tel" href="tel:988">
                <span className="emergency-tel__number">988</span>
                <span className="emergency-tel__what">Mental-health crisis support (call or text)</span>
              </a>
            </li>
          </ul>
        </footer>
      </main>
    </>
  );
}
