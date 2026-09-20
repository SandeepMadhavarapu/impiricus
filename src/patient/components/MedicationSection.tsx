import type { PlainSection, SourceRecord } from "@/sources/lib/content/types";

/**
 * Renders one plain-language section with its supporting citations.
 *
 * Every citation is expandable to the exact label text it came from, so a
 * reader can check any claim without leaving the page. Benefits and risks use
 * the same card structure and the same prominence — risk information is never
 * smaller, collapsed by default, or pushed below promotional content.
 */
export function MedicationSection({
  section,
  source,
}: {
  section: PlainSection;
  source: SourceRecord;
}) {
  const cardClass =
    section.emphasis === "critical"
      ? "card card--critical"
      : section.emphasis === "warning"
        ? "card card--warning"
        : "card";

  return (
    <section className={cardClass} aria-labelledby={`sec-${section.id}`}>
      {section.emphasis === "critical" ? (
        <p className="card-label">
          <span aria-hidden="true">⚠</span> FDA Boxed Warning
        </p>
      ) : null}

      <h2 className="section-title" id={`sec-${section.id}`}>
        {section.title}
      </h2>

      {section.plain.map((paragraph, i) => (
        <p className="body-text" key={i}>
          {paragraph}
        </p>
      ))}

      {section.detail && section.detail.length > 0 ? (
        <details className="disclosure">
          <summary>More detail</summary>
          <div className="disclosure-body">
            {section.detail.map((paragraph, i) => (
              <p className="body-text muted" key={i}>
                {paragraph}
              </p>
            ))}
          </div>
        </details>
      ) : null}

      <details className="disclosure">
        <summary>
          Sources ({section.citations.length})
        </summary>
        <div className="disclosure-body">
          <ul className="cite-list">
            {section.citations.map((citation, i) => {
              const sourceSection = source.sections.find((s) => s.id === citation.sectionId);
              const ref = sourceSection?.labelSectionRef ?? citation.sectionId;
              const title = sourceSection?.title ?? "Label section";
              /*
               * The badge and the title are read as one string by a screen
               * reader. Without a separator that produced "12.1Mechanism of
               * Action", and where the two say the same thing it produced
               * "BOXED WARNINGBoxed Warning".
               *
               * So: compare them normalised, and when they are the same thing
               * show the title once. Otherwise keep the badge and separate the
               * two for assistive technology only - the visual design is
               * unchanged, because the gap is already drawn by CSS.
               */
              const sameThing =
                ref.replace(/[^a-z0-9]/gi, "").toLowerCase() ===
                title.replace(/[^a-z0-9]/gi, "").toLowerCase();
              return (
                <li key={i}>
                  <details className="cite">
                    <summary>
                      {sameThing ? null : <span className="cite-ref">{ref}</span>}
                      {sameThing ? null : <span className="visually-hidden">: </span>}
                      <span>{title}</span>
                    </summary>
                    <div className="cite-body">
                      <blockquote className="cite-quote">“{citation.quote}”</blockquote>
                      <p className="tiny">
                        From the FDA-approved label for {source.product.brandName}, version{" "}
                        {source.document.splVersion}, effective {source.document.effectiveDate}.
                      </p>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
          {/*
           * ONE source link per section, not one per citation.
           *
           * Every citation in a section resolved to the same DailyMed URL, so
           * the page carried 38 links with identical text and an identical
           * destination. In a screen reader's link list that is 38
           * indistinguishable entries; on a phone it is a wall of repeated
           * rows. The destination is unchanged - it is just reachable once,
           * and named for the section it belongs to.
           */}
          <p className="tiny cite-source-link">
            <a
              href={source.provenance.humanReadable.dailyMed}
              target="_blank"
              rel="noopener noreferrer"
              className="external-note"
            >
              Read &ldquo;{section.title}&rdquo; on DailyMed
            </a>
          </p>
        </div>
      </details>
    </section>
  );
}
