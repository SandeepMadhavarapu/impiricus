"use client";

import { useEffect, useRef, useState } from "react";
import { Sheet } from "./Sheet";
import { track } from "@/shared/lib/analytics/client";
import type { ChatAnswer } from "@/patient/lib/chat/types";
import { reasonForAnswerMode, type UnresolvedQuestion } from "@/doctor/lib/handoff";

/**
 * Medication-scoped assistant.
 *
 * The medication is fixed by the page, so there is no product ambiguity to
 * resolve here. Every answer renders with a mode badge saying what produced it
 * — a model, a direct label-text match, or an honest failure — and with the
 * exact evidence behind it one tap away.
 *
 * Conversation state lives only in this component. It is not persisted, not
 * written to storage, and not included in anything that gets shared.
 */

const SUGGESTIONS = [
  "What is this medication used for?",
  "What are the common side effects?",
  "What are the most important warnings?",
  "What should I ask my pharmacist or doctor?",
  "How can I check insurance coverage?",
];

interface Turn {
  role: "user" | "assistant";
  content: string;
  answer?: ChatAnswer;
  /**
   * For assistant turns: the question that produced this answer. Kept so it can
   * be carried into the provider handoff if the person escalates.
   */
  question?: string;
}

export function ChatSheet({
  open,
  onClose,
  slug,
  productName,
  onOpenProvider,
  onOpenCoverage,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  productName: string;
  /** Receives the question the person still wants answered, if any. */
  onOpenProvider: (unresolved: UnresolvedQuestion | null) => void;
  onOpenCoverage: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, open]);

  async function send(question: string) {
    const trimmed = question.trim();
    if (!trimmed || busy) return;

    setError(null);
    setInput("");
    setBusy(true);

    const history = turns
      .filter((t) => t.content.length > 0)
      .slice(-8)
      .map((t) => ({ role: t.role, content: t.content }));

    setTurns((prev) => [...prev, { role: "user", content: trimmed }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, message: trimmed, history }),
      });

      if (res.status === 429) {
        setError("Too many questions in a short time. Please wait a moment and try again.");
        return;
      }
      if (!res.ok) {
        setError("The assistant could not be reached. The medication information on the page behind this panel is unaffected.");
        return;
      }

      const answer: ChatAnswer = await res.json();
      setTurns((prev) => [
        ...prev,
        {
          role: "assistant",
          content: answer.paragraphs.join(" "),
          answer,
          question: trimmed,
        },
      ]);
    } catch {
      setError("Network problem — your question was not sent. Please try again.");
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Ask about this medication"
      subtitle={productName}
      labelledBy="chat-title"
    >
      <div className="chat-log" ref={logRef}>
        <div className="card card--flat">
          <p style={{ fontSize: 15 }}>
            I answer only from the FDA-approved label for this exact product. If the label does not
            cover something, I will say so rather than guess.
          </p>
          <p className="tiny" style={{ marginTop: 8 }}>
            I cannot give medical advice about your situation, and I do not know your history. For
            anything urgent, call 911 (US).
          </p>
        </div>

        {turns.length === 0 ? (
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className="chip" onClick={() => void send(s)}>
                {s}
              </button>
            ))}
          </div>
        ) : null}

        <div aria-live="polite" aria-atomic="false" style={{ display: "contents" }}>
          {turns.map((turn, i) =>
            turn.role === "user" ? (
              <p className="msg--user" key={i}>
                {turn.content}
              </p>
            ) : (
              <AnswerBlock
                key={i}
                answer={turn.answer!}
                question={turn.question ?? ""}
                onOpenProvider={onOpenProvider}
                onOpenCoverage={onOpenCoverage}
              />
            )
          )}
        </div>

        {busy ? (
          <p className="typing" role="status">
            <span className="spinner" aria-hidden="true" />
            Searching the FDA label…
          </p>
        ) : null}

        {error ? (
          <div className="card card--warning" role="alert">
            <p style={{ fontSize: 15 }}>{error}</p>
          </div>
        ) : null}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <label className="visually-hidden" htmlFor="chat-input">
          Ask a question about {productName}
        </label>
        <textarea
          id="chat-input"
          ref={inputRef}
          rows={1}
          value={input}
          disabled={busy}
          placeholder="Ask a question…"
          maxLength={2000}
          onChange={(e) => {
            setInput(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <button type="submit" className="btn btn--primary" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </Sheet>
  );
}

const MODE_LABEL: Record<ChatAnswer["mode"], string> = {
  assistant: "AI answer · grounded in the label",
  "label-excerpts": "Label text · not AI",
  "not-covered": "Not covered by the label",
  "needs-clarification": "Needs clarification",
  unavailable: "Assistant unavailable",
  urgent: "Urgent",
};

function AnswerBlock({
  answer,
  question,
  onOpenProvider,
  onOpenCoverage,
}: {
  answer: ChatAnswer;
  /** The question that produced this answer, carried into the handoff. */
  question: string;
  onOpenProvider: (unresolved: UnresolvedQuestion | null) => void;
  onOpenCoverage: () => void;
}) {
  return (
    <div className="msg--assistant">
      {answer.urgent ? <UrgentBlock block={answer.urgent} /> : null}

      {answer.paragraphs.length > 0 ? (
        <>
          <span className="mode-badge" data-mode={answer.mode}>
            {MODE_LABEL[answer.mode]}
          </span>
          <div className="answer-prose">
            {answer.paragraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </>
      ) : null}

      {answer.validationNote ? (
        <div className="card card--warning" style={{ marginTop: 12, padding: 12 }}>
          <p style={{ fontSize: 14 }}>{answer.validationNote}</p>
        </div>
      ) : null}

      {answer.citations.length > 0 ? (
        <ul className="cite-list">
          {answer.citations.map((c) => (
            <li key={c.passageId}>
              <details className="cite">
                <summary>
                  <span className="cite-ref">{c.labelSectionRef}</span>
                  <span>{c.sectionTitle}</span>
                </summary>
                <div className="cite-body">
                  <blockquote className="cite-quote">{c.excerpt}</blockquote>
                  <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" className="external-note">
                    Read the full section on DailyMed
                  </a>
                </div>
              </details>
            </li>
          ))}
        </ul>
      ) : null}

      {answer.crisisFooter ? <UrgentBlock block={answer.crisisFooter} compact /> : null}

      {answer.scopeNote && answer.mode !== "urgent" ? (
        <p className="tiny" style={{ marginTop: 10 }}>
          <strong>Scope:</strong> {answer.scopeNote}
        </p>
      ) : null}

      {answer.offerProviderConnection ? (
        <div className="btn-row" style={{ marginTop: 14 }}>
          <button
            type="button"
            className="btn btn--small"
            onClick={() => {
              track("provider_cta_clicked");
              // Carry the still-open question across. An urgent/crisis turn
              // returns null: that person needs help now, not a question list.
              const reason = reasonForAnswerMode(answer.mode);
              onOpenProvider(
                reason && question ? { question, reason } : null
              );
            }}
          >
            {answer.mode === "not-covered" || answer.mode === "unavailable"
              ? "Take this question to a provider"
              : "Connect with a healthcare provider"}
          </button>
          <button type="button" className="btn btn--small" onClick={onOpenCoverage}>
            Check coverage
          </button>
        </div>
      ) : null}

      <p className="provenance-note">{answer.provenanceNote}</p>
    </div>
  );
}

function UrgentBlock({
  block,
  compact = false,
}: {
  block: NonNullable<ChatAnswer["urgent"]>;
  compact?: boolean;
}) {
  return (
    <div className="urgent-block" style={compact ? { marginTop: 14 } : undefined} role="alert">
      <h3>{block.heading}</h3>
      {block.body.map((p, i) => (
        <p key={i} style={{ fontSize: 15, marginTop: i > 0 ? 8 : 0 }}>
          {p}
        </p>
      ))}
      <div className="stack" style={{ ["--gap" as string]: "8px", marginTop: 12 }}>
        {block.resources.map((r) =>
          r.href ? (
            <a className="resource-link" key={r.label} href={r.href}>
              <strong>{r.label}</strong>
              <span>{r.detail}</span>
            </a>
          ) : (
            <div className="resource-link" key={r.label}>
              <strong>{r.label}</strong>
              <span>{r.detail}</span>
            </div>
          )
        )}
      </div>
    </div>
  );
}
