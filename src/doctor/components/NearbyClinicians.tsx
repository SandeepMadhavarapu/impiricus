"use client";

import { useCallback, useState } from "react";

/**
 * Clinicians registered near a ZIP code, from the federal NPI register.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS SITS
 * ---------------------------------------------------------------------------
 * Inside the "I need to find a provider" route, above the national directories
 * that were already there. It does not replace them: they cover the whole
 * country and handle sliding-scale and Medicare questions this cannot. It sits
 * above them because a phone number for someone a few streets away is a
 * stronger first step than a search box on another site.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CAVEAT IS NOT BURIED
 * ---------------------------------------------------------------------------
 * A list of named doctors reads as a recommendation unless it says otherwise.
 * This one is a register filtered to a ZIP code: it cannot tell whether a
 * clinician is accepting patients, takes an insurance, or is still licensed.
 * One line of that is always on screen and the rest is one tap away, rather
 * than four lines of small print nobody finishes.
 *
 * Nothing is transmitted. No clinician is contacted, and no appointment is
 * made or implied.
 */

interface Clinician {
  id: string;
  name: string;
  credential: string | null;
  specialty: string | null;
  address: string;
  phone: string | null;
  phoneHref: string | null;
}

interface Props {
  /** Real NUCC taxonomy descriptions, from the server's own allow-list. */
  specialties: ReadonlyArray<{ value: string; label: string }>;
  /** The full caveat list, owned by the server module that does the lookup. */
  listingMeans: readonly string[];
}

type State =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; clinicians: Clinician[]; totalInZip: number }
  | { phase: "error"; message: string };

export function NearbyClinicians({ specialties, listingMeans }: Props) {
  const [zip, setZip] = useState("");
  const [specialty, setSpecialty] = useState(specialties[0]?.value ?? "");
  const [state, setState] = useState<State>({ phase: "idle" });

  const search = useCallback(async () => {
    if (!/^\d{5}$/.test(zip)) {
      setState({ phase: "error", message: "Enter a 5-digit ZIP code." });
      return;
    }
    setState({ phase: "loading" });
    try {
      const res = await fetch(
        `/api/directory?kind=clinicians&zip=${encodeURIComponent(zip)}&specialty=${encodeURIComponent(specialty)}`
      );
      const body = await res.json();
      if (body.error) {
        setState({ phase: "error", message: body.error });
        return;
      }
      setState({ phase: "done", clinicians: body.clinicians ?? [], totalInZip: body.totalInZip ?? 0 });
    } catch {
      // The national directories below still work, so this is a setback and
      // not a dead end. Say which.
      setState({
        phase: "error",
        message: "The provider registry could not be reached. The directories below still work.",
      });
    }
  }, [zip, specialty]);

  const chosen = specialties.find((s) => s.value === specialty)?.label ?? specialty;

  return (
    <div className="card card--flat">
      <p className="card-label" style={{ color: "var(--text-muted)" }}>
        Registered near you
      </p>
      <p className="tiny" style={{ marginBottom: 12 }}>
        From the federal provider register. Not a recommendation — call to check they are taking
        patients and take your insurance.
      </p>

      <div className="clinician-search">
        <div className="field">
          <label htmlFor="clin-specialty">Kind of clinician</label>
          <select
            id="clin-specialty"
            value={specialty}
            onChange={(e) => setSpecialty(e.target.value)}
          >
            {specialties.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="clin-zip">ZIP code</label>
          <input
            id="clin-zip"
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={5}
            value={zip}
            placeholder="e.g. 24060"
            onChange={(e) => setZip(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void search();
              }
            }}
          />
        </div>
      </div>

      <button
        type="button"
        className="btn btn--small clinician-search-btn"
        onClick={() => void search()}
        disabled={state.phase === "loading"}
      >
        {state.phase === "loading" ? "Searching…" : "Search"}
      </button>
      <p className="tiny" style={{ marginTop: 6 }}>
        Your ZIP is used to run the search and is not saved.
      </p>

      {state.phase === "error" ? (
        <p className="field-error" role="status" style={{ marginTop: 10 }}>
          {state.message}
        </p>
      ) : null}

      {state.phase === "done" ? (
        state.clinicians.length === 0 ? (
          /*
            A real answer about this ZIP, not a failure. Several specialties
            genuinely have nobody registered in a given ZIP - Blacksburg has no
            registered allergist - and saying so is more use than an empty box.
          */
          <p className="tiny" role="status" style={{ marginTop: 10 }}>
            No {chosen.toLowerCase()} is registered in {zip}. Try another kind of clinician or a
            nearby ZIP code, or use the directories below.
          </p>
        ) : (
          <div style={{ marginTop: 12 }}>
            <ul className="clinician-list">
              {state.clinicians.map((c) => (
                <li key={c.id}>
                  <p className="clinician-name">
                    {c.name}
                    {c.credential ? <span className="clinician-cred">{c.credential}</span> : null}
                  </p>
                  {c.specialty ? <p className="tiny">{c.specialty}</p> : null}
                  <p className="tiny">{c.address}</p>
                  {/*
                    The phone number is the point. It is the one thing here a
                    person can act on without another search, and it is the
                    only way to answer the questions the register cannot.
                  */}
                  {c.phone && c.phoneHref ? (
                    <a className="btn btn--small clinician-call" href={c.phoneHref}>
                      Call {c.phone}
                    </a>
                  ) : c.phone ? (
                    <p className="tiny">{c.phone}</p>
                  ) : (
                    <p className="tiny">No telephone number is registered.</p>
                  )}
                </li>
              ))}
            </ul>

            {state.totalInZip > state.clinicians.length ? (
              <p className="tiny" style={{ marginTop: 8 }}>
                Showing {state.clinicians.length} of {state.totalInZip} registered in {zip}.
              </p>
            ) : null}

            <details className="disclosure" style={{ marginTop: 10 }}>
              <summary>What this list is, and is not</summary>
              <ul className="tiny" style={{ margin: "8px 0 0 18px" }}>
                {listingMeans.map((line) => (
                  <li key={line} style={{ marginBottom: 4 }}>
                    {line}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )
      ) : null}
    </div>
  );
}
