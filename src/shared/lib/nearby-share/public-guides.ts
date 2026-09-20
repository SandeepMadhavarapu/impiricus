/** Stable public catalogue identifiers. Never reorder/reassign an existing code. */
export const PUBLIC_GUIDE_CODES: Readonly<Record<string, string>> = {
  "01": "singulair-montelukast-10mg-tablet",
  "02": "toprol-xl-metoprolol-succinate-50mg-er-tablet",
  "03": "ozempic-semaglutide-1_34mg-per-ml-injection",
};
export function publicGuideSlug(code: string): string | undefined {
  return /^g:[0-9a-f]{2}$/.test(code) ? PUBLIC_GUIDE_CODES[code.slice(2)] : undefined;
}
export function publicGuideCode(slug: string): string | undefined {
  const entry = Object.entries(PUBLIC_GUIDE_CODES).find(([, value]) => value === slug);
  return entry ? `g:${entry[0]}` : undefined;
}
