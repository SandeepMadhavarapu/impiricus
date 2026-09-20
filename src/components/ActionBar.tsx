"use client";

import { useState } from "react";
import { ChatSheet } from "./ChatSheet";
import { CoverageSheet } from "./CoverageSheet";
import { ProviderSheet } from "./ProviderSheet";
import { track } from "@/lib/analytics/client";
import type { UnresolvedQuestion } from "@/lib/handoff";

/**
 * The three primary actions, and the sheets they open.
 *
 * "Learn more" is first and visually primary. Sharing lives further down the
 * page so it is available without competing with the education journey.
 */
export function ActionBar({
  slug,
  productName,
  strength,
  dosageForm,
}: {
  slug: string;
  productName: string;
  /** Formatted strength, e.g. "10 mg". Comes from the label, not a constant. */
  strength: string;
  /** Dosage form exactly as the label states it, e.g. "TABLET, FILM COATED". */
  dosageForm: string;
}) {
  const [openSheet, setOpenSheet] = useState<null | "chat" | "coverage" | "provider">(null);
  /**
   * The question the person still wants answered, carried from chat into the
   * provider step. Local-only state; cleared when they start fresh from the
   * page rather than from a conversation.
   */
  const [unresolved, setUnresolved] = useState<UnresolvedQuestion | null>(null);

  return (
    <>
      <div className="actions-primary">
        <button
          type="button"
          className="btn btn--primary btn--block"
          onClick={() => {
            track("learn_more_opened");
            setOpenSheet("chat");
          }}
        >
          Learn more — ask about this medication
        </button>
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            onClick={() => {
              track("provider_cta_clicked");
              setUnresolved(null);
              setOpenSheet("provider");
            }}
          >
            Connect with a provider
          </button>
          <button type="button" className="btn" onClick={() => setOpenSheet("coverage")}>
            Check coverage
          </button>
        </div>
      </div>

      <ChatSheet
        open={openSheet === "chat"}
        onClose={() => setOpenSheet(null)}
        slug={slug}
        productName={productName}
        onOpenProvider={(carried) => {
          setUnresolved(carried);
          setOpenSheet("provider");
        }}
        onOpenCoverage={() => setOpenSheet("coverage")}
      />

      <CoverageSheet
        open={openSheet === "coverage"}
        onClose={() => setOpenSheet(null)}
        slug={slug}
        productName={productName}
        defaultStrength={strength}
        defaultForm={dosageForm}
      />

      <ProviderSheet
        open={openSheet === "provider"}
        onClose={() => setOpenSheet(null)}
        productName={productName}
        unresolved={unresolved}
      />
    </>
  );
}
