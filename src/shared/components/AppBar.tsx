/**
 * The app's top bar, shared by the HCP screen and the patient guide.
 *
 * Both screens are presented as part of one product delivered through
 * DocUpdate's app — the clinician builds the guide there, the patient opens
 * what was sent — so they carry the same bar. It is MedBridge's own name and
 * mark: nothing here uses DocUpdate's logo, wordmark or any asset of theirs.
 *
 * `badge` is optional because the two screens qualify themselves differently.
 * The HCP screen is an integration preview; the patient guide is the real
 * thing a patient would read, and labelling it "preview" would be wrong.
 */
export function AppBar({ subtitle, badge }: { subtitle: string; badge?: string }) {
  return (
    <header className="du-appbar">
      <div className="du-appbar-brand">
        <span className="du-appbar-mark" aria-hidden="true">
          <GuideIcon />
        </span>
        <span className="du-appbar-titles">
          <strong>MedBridge</strong>
          <span>{subtitle}</span>
        </span>
      </div>
      {badge ? <span className="du-appbar-badge">{badge}</span> : null}
    </header>
  );
}

/** Open-book mark. Drawn here so the pages pull in no icon library. */
export function GuideIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2.5 2.5 0 0 1 2 1 2.5 2.5 0 0 1 2-1h4.5A1.5 1.5 0 0 1 20 5.5v12a1.5 1.5 0 0 1-1.5 1.5H14a2.5 2.5 0 0 0-2 1 2.5 2.5 0 0 0-2-1H5.5A1.5 1.5 0 0 1 4 17.5Z" />
      <path d="M12 5v14" />
    </svg>
  );
}
