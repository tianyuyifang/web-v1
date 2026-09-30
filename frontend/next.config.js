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
