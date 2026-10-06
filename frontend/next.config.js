const QQ = "https://*.qq.com http://*.qq.com https://*.gtimg.cn https://*.qpic.cn";
const NETEASE = "https://*.music.126.net http://*.music.126.net https://*.126.net";
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://u.y.qq.com",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${QQ} ${NETEASE}`,
  `media-src 'self' data: blob: ${QQ} ${NETEASE}`,
  `connect-src 'self' ${QQ} ${NETEASE}`,
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  // report-uri only: every browser sends it at once. With report-to beside
  // it Chrome switches to the Reporting API, which batches and delays (reports
  // from short visits were lost in testing), and Safari/Firefox lack it.
  "report-uri /api/csp-report",
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  compress: true,
  poweredByHeader: false,

  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api"}/:path*`,
      },
    ];
  },

  // /dashboard only ever forwarded to /playlists from the browser, which cost
  // a JS load plus two round trips before the real page started. Answered by
  // the server now; kept so old bookmarks and links still land. Temporary
  // (307), so a browser does not remember it if /dashboard is ever reused.
  async redirects() {
    return [
      { source: "/dashboard", destination: "/playlists", permanent: false },
    ];
  },
  async headers() {
    return [
      {
        // Content-Security-Policy, Report-Only for now (2026-10-06): browsers
        // block nothing yet and report what they would have to /api/csp-report
        // (admin: /api/admin/csp-reports). Enforced once a few days of
        // reports show nothing legitimate is missing. What it is for: a script
        // injected through some future bug could not send the user's QQ key
        // (the page holds it for 用户 IP) anywhere but here and QQ.
        //   script-src  u.y.qq.com: QQ's JSONP, run in a sandboxed srcdoc
        //               frame, which inherits this policy. 'unsafe-inline':
        //               Next's own inline scripts and that frame's.
        //   media/connect  the audio CDNs (played, and fetched to decode for
        //               pitch/vocals): QQ's *.qqmusic.qq.com / *.qq.com, NetEase's
        //               *.music.126.net (some served over http).
        source: "/((?!api/|_next/static/).*)",
        headers: [
          { key: "Content-Security-Policy-Report-Only", value: CSP },
        ],
      },
      {
        // Cache static assets aggressively
        source: "/_next/static/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        // Cache fonts/images
        source: "/(.*)\\.(ico|png|jpg|jpeg|svg|woff|woff2)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=2592000" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
