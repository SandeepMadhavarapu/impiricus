import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { getMedication } from "@/sources/lib/content/registry";
import { getPublicOrigin } from "@/shared/lib/config";
import { buildShareUrl } from "@/doctor/lib/share";

export const runtime = "nodejs";

/**
 * QR code for a medication's public URL.
 *
 * The encoded value is built from validated configuration and a known slug —
 * never from anything the caller supplies beyond the slug itself, and never
 * with a query string. A QR code is a durable artifact: it gets printed, taped
 * to a counter, and photographed. Anything encoded in it leaks for as long as
 * it exists.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> }
) {
  const { slug } = await context.params;

  // Only render a code for a medication that actually exists, so a bad link
  // cannot be laundered into a legitimate-looking QR image.
  if (!getMedication(slug)) {
    return new NextResponse("Not found", { status: 404 });
  }

  let target: string;
  try {
    target = buildShareUrl(getPublicOrigin().origin, slug);
  } catch {
    return new NextResponse("Invalid share target", { status: 400 });
  }

  const svg = await QRCode.toString(target, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 512,
    color: { dark: "#17212e", light: "#ffffff" },
  });

  return new NextResponse(svg, {
    headers: {
      "content-type": "image/svg+xml",
      // Public and cacheable: this encodes nothing but the public URL.
      "cache-control": "public, max-age=3600, s-maxage=86400",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
