import { GuideIcon } from "@/shared/components/AppBar";

/**
 * The bottom tab bar for the HCP screen.
 *
 * This screen is pitched as a module that would live inside DocUpdate's app,
 * so it is framed the way a screen in that app is framed. The tabs other than
 * this one are INERT — they are a mockup of where this screen would sit, not
 * navigation to features that exist here, so they are rendered as disabled
 * spans rather than links that quietly go nowhere.
 *
 * The patient guide deliberately does NOT get this bar: a patient is not
 * using the clinician's app and has no such tabs.
 */

/** Tabs shown for context. Only "Guide" — this screen — is real. */
const CONTEXT_TABS = [
  { id: "prescriber", label: "Prescriber", icon: PrescriberIcon },
  { id: "translator", label: "Translate", icon: TranslateIcon },
  { id: "concierge", label: "Concierge", icon: ConciergeIcon },
  { id: "profile", label: "Profile", icon: ProfileIcon },
] as const;

export function TabBar() {
  return (
    <nav className="du-tabbar" aria-label="App navigation (visual preview — surrounding tabs are not implemented)">
      <span className="du-tab du-tab--active" aria-current="page">
        <GuideIcon />
        Guide
      </span>
      {CONTEXT_TABS.map(({ id, label, icon: Icon }) => (
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
