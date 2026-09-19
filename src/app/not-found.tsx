import Link from "next/link";
import { DEFAULT_MEDICATION_SLUG } from "@/lib/content/registry";

/**
 * Unknown medication route.
 *
 * This page exists to make one thing impossible: quietly showing a different
 * medication than the one the link asked for. A wrong-drug answer is the most
 * damaging failure this product could produce, so an unknown slug is a dead end
 * by design.
 */
export default function NotFound() {
  return (
    <main className="page" id="main">
      <div className="med-header">
        <p className="eyebrow">Link not recognised</p>
        <h1 className="med-title">We could not find that medication</h1>
        <p className="med-headline">
          The link may be mistyped, or it may point to a medication this prototype does not cover.
        </p>
      </div>

      <div className="card card--warning">
        <p className="card-label">Why we are not guessing</p>
        <p className="body-text">
          Rather than show you the closest match, we show nothing. Medication information is only
          useful if it is about the right product — the right drug, at the right strength, in the
          right form.
        </p>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <p className="body-text">
          To look up any medication, DailyMed publishes the FDA-approved label for every product
          marketed in the United States.
        </p>
        <div className="btn-row" style={{ marginTop: 14 }}>
          <a
            className="btn"
            href="https://dailymed.nlm.nih.gov/dailymed/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Search DailyMed
          </a>
          <Link className="btn btn--primary" href={`/medications/${DEFAULT_MEDICATION_SLUG}`}>
            See the example medication
          </Link>
        </div>
      </div>

      <footer className="site-footer">
        <p>
          In a medical emergency in the US, call 911. For a suspected overdose, call Poison Help at{" "}
          <a href="tel:18002221222">1-800-222-1222</a>.
        </p>
      </footer>
    </main>
  );
}
