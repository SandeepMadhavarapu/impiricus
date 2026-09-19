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
              const href =
                citation.sectionId === "spl_medguide"
                  ? source.provenance.humanReadable.medicationGuide
                  : source.provenance.humanReadable.dailyMed;
              return (
                <li key={i}>
                  <details className="cite">
                    <summary>
                      <span className="cite-ref">
                        {sourceSection?.labelSectionRef ?? citation.sectionId}
                      </span>
                      <span>{sourceSection?.title ?? "Label section"}</span>
                    </summary>
                    <div className="cite-body">
                      <blockquote className="cite-quote">“{citation.quote}”</blockquote>
                      <p className="tiny">
                        From the FDA-approved label for {source.product.brandName}, version{" "}
                        {source.document.splVersion}, effective {source.document.effectiveDate}.{" "}
                        <a href={href} target="_blank" rel="noopener noreferrer" className="external-note">
                          Read this section on DailyMed
                        </a>
                      </p>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        </div>
      </details>
    </section>
  );
}
