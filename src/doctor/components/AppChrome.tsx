/**
 * The surrounding app chrome for the HCP screen.
 *
 * This screen is pitched as a module that would live inside DocUpdate's own
 * app, so it is framed the way a screen in that app is framed: a navy top bar
 * and a bottom tab bar. The tabs other than this one are INERT — they are a
 * mockup of where this screen would sit, not navigation to features that
 * exist here, so they are marked disabled rather than rendered as links that
 * quietly go nowhere.
 *
 * Nothing here uses DocUpdate's logo, wordmark or any asset of theirs. It is
 * an independent prototype dressed to show a fit, and the page says so in
 * three separate places.
 */

/** Tabs shown for context. Only "Guide" — this screen — is real. */
const CONTEXT_TABS = [
  { id: "prescriber", label: "Prescriber", icon: PrescriberIcon },
  { id: "translator", label: "Translate", icon: TranslateIcon },
  { id: "concierge", label: "Concierge", icon: ConciergeIcon },
  { id: "profile", label: "Profile", icon: ProfileIcon },
] as const;

export function AppBar() {
  return (
    <header className="du-appbar">
      <div className="du-appbar-brand">
        <span className="du-appbar-mark" aria-hidden="true">
          <GuideIcon />
        </span>
        <span className="du-appbar-titles">
          <strong>MedBridge</strong>
          <span>Patient education module</span>
        </span>
      </div>
      <span className="du-appbar-badge">Integration preview</span>
    </header>
  );
}

export function TabBar() {
  return (
    <nav className="du-tabbar" aria-label="App navigation (visual preview — surrounding tabs are not implemented)">
      <span className="du-tab du-tab--active" aria-current="page">
        <GuideIcon />
        Guide
      </span>
      {CONTEXT_TABS.map(({ id, label, icon: Icon }) => (
        // Not a link and not a button: there is nothing behind these. They show
        // where this screen would sit in the host app, and nothing more.
        <span key={id} className="du-tab" aria-disabled="true">
          <Icon />
          {label}
        </span>
      ))}
    </nav>
  );
}

/* --------------------------------------------------------------- icons -- */
/* Plain 24px stroke icons, drawn here so the page pulls in no icon library. */

function GuideIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2.5 2.5 0 0 1 2 1 2.5 2.5 0 0 1 2-1h4.5A1.5 1.5 0 0 1 20 5.5v12a1.5 1.5 0 0 1-1.5 1.5H14a2.5 2.5 0 0 0-2 1 2.5 2.5 0 0 0-2-1H5.5A1.5 1.5 0 0 1 4 17.5Z" />
      <path d="M12 5v14" />
    </svg>
  );
}

function PrescriberIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 4h8a1 1 0 0 1 1 1v1H7V5a1 1 0 0 1 1-1Z" />
      <path d="M7 6H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1" />
      <path d="M9 11h3.5a1.75 1.75 0 0 1 0 3.5H9V11Zm0 3.5V17m3 -2.5 2.5 2.5" />
    </svg>
  );
}

function TranslateIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4c2 2.5 3 5 3 8s-1 5.5-3 8c-2-2.5-3-5-3-8s1-5.5 3-8Z" />
    </svg>
  );
}

function ConciergeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M20 12.5a7 7 0 0 1-7 7H8.5L5 21.5v-4A7 7 0 0 1 8.5 5h4.5a7 7 0 0 1 7 7Z" />
      <path d="M9.5 12h.01M13 12h.01M16.5 12h.01" />
    </svg>
  );
}

function ProfileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="8.5" r="3.75" />
      <path d="M4.75 20a7.25 7.25 0 0 1 14.5 0" />
    </svg>
  );
}
