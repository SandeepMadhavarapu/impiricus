/**
 * The one definition of a medication slug.
 *
 * A slug is the join key shared by four things that must agree about which
 * drug is which: the pipeline's `productKey`, the public URL, the authored
 * content record, and every API request. It was previously written out in
 * four separate places, which is how three of them came to accept a product
 * the fourth rejected: Ozempic keys as
 * "ozempic-semaglutide-1_34mg-per-ml-injection", because the pipeline escapes
 * the decimal point in 1.34 mg/mL with an underscore, and the chat, coverage
 * and QR endpoints all refused it while the page itself rendered fine.
 *
 * Underscore and hyphen are both RFC 3986 unreserved characters, so both are
 * safe in a path segment. Everything genuinely dangerous stays rejected:
 * path separators, query and fragment markers, whitespace, uppercase, dots
 * (which would allow traversal) and scheme-like strings.
 *
 * Anything that does not match is REJECTED, never sanitised. Quietly
 * rewriting an identifier is how a request for one product gets answered
 * with another.
 */
export const SLUG_PATTERN = /^[a-z0-9_-]+$/;

/** Longest slug we will look at. Bounds the work done on hostile input. */
export const SLUG_MAX_LENGTH = 120;

export function isValidSlug(value: string): boolean {
  return value.length > 0 && value.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(value);
}
