"use client";

import { useCallback, useState } from "react";
import Link from "next/link";

/**
 * Search every FDA drug label from inside the medication library.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS FOR
 * ---------------------------------------------------------------------------
 * The library lists the products with a full patient guide. That is three.
 * openFDA publishes 262,883 labels, so for any other medication the honest
 * answer - "the FDA label exists, no patient guide has been written for it" -
 * was unavailable because nothing was ever looked up.
 *
 * ---------------------------------------------------------------------------
 * THE DISTINCTION THIS SCREEN MUST NOT BLUR
 * ---------------------------------------------------------------------------
 * A catalogued product has a reviewed plain-language guide, citations and a
 * shareable link. A searched drug has identity and a link to the official
 * label, and nothing else. Both appear in the same result list, so the
 * difference is carried in the row itself: a catalogued result offers the
 * guide, and every other result says plainly that there is not one.
 *
 * No label text is shown here and none is summarised. The full text stays
 * where it is authoritative, at DailyMed.
 */

interface Hit {
  setId: string;
  brandNames: string[];
  genericNames: string[];
  manufacturer: string | null;
  routes: string[];
  hasBoxedWarning: boolean;
  dailyMedUrl: string;
  guide: { slug: string; name: string } | null;
}

type State =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; hits: Hit[]; totalMatches: number; term: string }
  | { phase: "error"; message: string };

export function DrugSearch() {
  const [term, setTerm] = useState("");
  const [state, setState] = useState<State>({ phase: "idle" });

  const search = useCallback(async () => {
    const q = term.trim();
    if (q.length < 2) {
      setState({ phase: "error", message: "Type at least two letters." });
      return;
    }
    setState({ phase: "loading" });
    try {
      const res = await fetch(`/api/drug-search?q=${encodeURIComponent(q)}`);
      const body = await res.json();
      if (body.error) {
        setState({ phase: "error", message: body.error });
        return;
      }
      setState({
        phase: "done",
        hits: body.hits ?? [],
        totalMatches: body.totalMatches ?? 0,
        term: q,
      });
    } catch {
      setState({
        phase: "error",
        message: "The FDA label service could not be reached. Try again in a moment.",
      });
    }
  }, [term]);

  return (
    <div className="drug-search">
      <label htmlFor="drug-q" className="tiny">
        Search every FDA drug label
      </label>
      <div className="drug-search-row">
        <input
          id="drug-q"
          type="search"
          value={term}
          placeholder="Brand or generic name"
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void search();
            }
          }}
        />
        <button
          type="button"
          className="btn btn--small drug-search-btn"
          onClick={() => void search()}
          disabled={state.phase === "loading"}
        >
          {state.phase === "loading" ? "Searching…" : "Search"}
        </button>
      </div>

      {state.phase === "error" ? (
        <p className="field-error" role="status">
          {state.message}
        </p>
      ) : null}

      {state.phase === "done" ? (
        state.hits.length === 0 ? (
          /*
            openFDA answers "nothing matched" with a 404, which the server
            turns into this rather than into an error. The difference matters:
            one says check the spelling, the other says try again later.
          */
          <p className="tiny" role="status">
            No FDA label matches &ldquo;{state.term}&rdquo;. Check the spelling, or try the generic
            name.
          </p>
        ) : (
          <>
            <ul className="drug-hits">
              {state.hits.map((hit) => (
                <li key={hit.setId}>
                  <p className="drug-hit-name">
                    {/*
                      Every brand this label covers, not the first one. One SPL
                      can cover an injection and a tablet - the semaglutide
                      label carries both OZEMPIC and RYBELSUS - and naming only
                      the first would put the wrong product on screen.
                    */}
                    {hit.brandNames.length > 0 ? hit.brandNames.join(" · ") : hit.genericNames[0]}
                    {hit.hasBoxedWarning ? (
                      <span className="drug-boxed" title="This label carries an FDA boxed warning">
                        Boxed warning
                      </span>
                    ) : null}
                  </p>

                  {hit.genericNames.length > 0 && hit.brandNames.length > 0 ? (
                    <p className="tiny">{hit.genericNames.join(", ").toLowerCase()}</p>
                  ) : null}

                  <p className="tiny">
                    {[hit.manufacturer, hit.routes.join(", ")].filter(Boolean).join(" · ")}
                  </p>

                  {hit.guide ? (
                    <Link className="btn btn--small drug-hit-action" href={`/doctor?medication=${hit.guide.slug}`}>
                      Open patient guide →
                    </Link>
                  ) : (
                    <p className="tiny drug-no-guide">
                      No patient guide has been written for this one.{" "}
                      <a href={hit.dailyMedUrl} target="_blank" rel="noopener noreferrer">
                        Read the official label ↗
                      </a>
                    </p>
                  )}
                </li>
              ))}
            </ul>

            {state.totalMatches > state.hits.length ? (
              <p className="tiny">
                Showing {state.hits.length} of {state.totalMatches.toLocaleString()} matching FDA
                labels.
              </p>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}
