import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MedBridge — plain-language medication information",
  description:
    "Understand a medication in plain language, sourced from its FDA-approved label, with benefits and risks shown side by side.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfaf8" },
    { media: "(prefers-color-scheme: dark)", color: "#12161b" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to medication information
        </a>
        {/*
          Identity disclosure. This is an independent prototype; it must never
          imply affiliation with or endorsement by any company or regulator.
        */}
        <div className="proto-banner" role="note">
          <strong>Independent hackathon prototype.</strong> Educational information only — not
          medical advice, and not affiliated with any manufacturer, insurer or regulator.
        </div>
        {children}
      </body>
    </html>
  );
}
