import { z } from "zod";
import { SLUG_PATTERN } from "@/shared/lib/slug";

/** Trust boundary: everything a browser posts to /api/chat is parsed by this. */
export const ChatTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(2000),
});

export const ChatRequestSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(SLUG_PATTERN, "invalid medication slug"),
  message: z.string().min(1, "Enter a question").max(2000, "Question is too long"),
  /** Prior turns, bounded. Chat is ephemeral; the client holds the history. */
  history: z.array(ChatTurnSchema).max(12).default([]),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export interface AnswerCitation {
  /** Passage id from retrieval, e.g. "adverse_reactions#0". */
  passageId: string;
  sectionTitle: string;
  labelSectionRef: string;
  /** The retrieved text backing this citation. Shown on tap. */
  excerpt: string;
  /** Deep link into the human-readable source document. */
  sourceUrl: string;
}

export type AnswerMode =
  /** A model composed the answer from retrieved passages. */
  | "assistant"
  /** No model configured: verbatim label excerpts, clearly not AI. */
  | "label-excerpts"
  /** Urgent situation: help resources only. */
  | "urgent"
  /** Retrieval found nothing relevant. */
  | "not-covered"
  /** A follow-up that depends on context we do not have. Ask, do not guess. */
  | "needs-clarification"
  /** The configured model failed. Honest failure, never a silent fallback. */
  | "unavailable";

export interface UrgentBlock {
  heading: string;
  body: string[];
  resources: Array<{ label: string; detail: string; href: string | null; emphasis: string }>;
}

export interface ChatAnswer {
  mode: AnswerMode;
  /** Paragraphs of answer text. Plain text; the client does not render HTML. */
  paragraphs: string[];
  citations: AnswerCitation[];
  urgent?: UrgentBlock;
  /** Shown alongside an answer about neuropsychiatric risk. */
  crisisFooter?: UrgentBlock;
  /** Offered only when the question implies a real next step. */
  offerProviderConnection: boolean;
  /** Scope caveat, e.g. the label covers other dosage forms. */
  scopeNote?: string;
  /** Rendered as a short banner, e.g. "Answer composed by Claude from the FDA label". */
  provenanceNote: string;
  /** Present when citation validation dropped something. Surfaced, not hidden. */
  validationNote?: string;
}
