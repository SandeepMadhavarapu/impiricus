import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    // Computed inside this function: Next compiles next.config.ts into a
    // separate scope, so a module-level const is not visible here.
    const isDev = process.env.NODE_ENV !== "production";
    return [
      {
        // Applied to every route. Route handlers additionally set their own
        // Cache-Control; these headers are the baseline security posture.
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=(), payment=()" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Next.js injects inline bootstrap scripts; 'unsafe-inline' is required
              // for the app router runtime without a nonce-forwarding middleware.
              //
              // 'unsafe-eval' is added in development ONLY: the dev-mode HMR
              // runtime evaluates strings, and without it the client bundle
              // never hydrates (every button silently does nothing). It is not
              // present in production builds.
              isDev
                ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
                : "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "connect-src 'self'",
              "font-src 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "object-src 'none'",
            ].join("; "),
          },
        ],
      },
      {
        source: "/receive",
        headers: [{ key: "Permissions-Policy", value: "geolocation=(), microphone=(self), camera=(), payment=()" }],
      },
      {
        source: "/medications/:slug",
        headers: [{ key: "Permissions-Policy", value: "geolocation=(), microphone=(self), camera=(), payment=()" }],
      },
    ];
  },
};

export default nextConfig;
