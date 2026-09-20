import type { LabelSectionView } from "@/sources/lib/content/label";

/**
 * Renders one section of an FDA label, verbatim.
 *
 * Three things this does that a naive renderer gets wrong:
 *
 *   Hierarchy is preserved. "5.1 Neuropsychiatric Events" is a subsection of
 *   "5 WARNINGS AND PRECAUTIONS". Flattening loses which warning belongs to
 *   which topic.
 *
 *   Tables stay tables. Table content is NOT duplicated into `paragraphs`, so
 *   a renderer that only walks paragraphs silently drops the dosing table. A
 *   dosing table flattened to prose loses which dose belongs to which age
 *   group, which is how a paediatric row becomes an adult instruction.
 *
 *   Highlights are marked as highlights. The FDA's own "Highlights of
 *   Prescribing Information" states it does not include all the information
 *   needed, so it renders as a summary and never as the section body.
 *
 * Nothing here rewords, summarises, or reorders. The words are the label's.
 */
export function LabelSection({
  section,
  depth = 0,
}: {
  section: LabelSectionView;
  depth?: number;
}) {
  // Labels are inconsistent about this: some put the section number only in
  // printedNumber, others repeat it at the start of the title. Prefixing
  // blindly produced headings like "17 17 PATIENT COUNSELING INFORMATION".
  const title = section.title?.trim() ?? "";
  const number = section.printedNumber?.trim() ?? "";
  const alreadyNumbered = number.length > 0 && new RegExp(`^${number}\\b`).test(title);
  const heading = [alreadyNumbered ? "" : number, title].filter(Boolean).join(" ").trim();
  const Heading = depth === 0 ? "h3" : "h4";

  return (
    <section className="label-section" data-depth={depth}>
      {heading ? <Heading className="label-section-title">{heading}</Heading> : null}

      {section.highlights.length > 0 ? (
        <div className="label-highlights">
          <p className="card-label">Highlights</p>
          {section.highlights.map((h, i) => (
            <p key={i}>{h}</p>
          ))}
          <p className="tiny">
            The FDA label states its highlights do not include all the information needed to use
            this medicine safely.
          </p>
        </div>
      ) : null}

      {section.paragraphs.map((p, i) => (
        <p key={i} className="body-text">
          {p}
        </p>
      ))}

      {section.tables.map((t, i) => (
        /*
         * A horizontally scrolling region has to be reachable by keyboard.
         *
         * On a phone these label tables are wider than the screen and the wrap
         * scrolls sideways - by touch only. Without tabindex nobody using a
         * keyboard or a switch could scroll it, so the columns past the right
         * edge were simply unreadable to them. These are dosing and strength
         * tables off an FDA label, so "unreadable" is not cosmetic.
         *
         * role="region" plus a name is what makes a focus stop announce itself
         * as something scrollable rather than as an unexplained empty stop. The
         * name prefers the table's own caption, which is the label's wording.
         */
        <div
          className="label-table-wrap"
          key={i}
          tabIndex={0}
          role="region"
          aria-label={t.caption?.trim() ? `Table: ${t.caption.trim()}` : "Table from the FDA label, scrolls sideways"}
        >
          <table className="label-table">
            {t.caption ? <caption>{t.caption}</caption> : null}
            {t.headers.length > 0 ? (
              <thead>
                {t.headers.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <th key={c} scope="col">
                        {cell}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
            ) : null}
            <tbody>
              {t.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {section.subsections.map((sub, i) => (
        <LabelSection key={i} section={sub} depth={depth + 1} />
      ))}
    </section>
  );
}
