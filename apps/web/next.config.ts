import type { NextConfig } from 'next';

/**
 * الواجهة تخاطب الخادم عبر /api/* على نطاقها نفسه، و Next يمرر الطلبات إلى API_URL.
 * بذلك تكون كوكي الجلسة كوكي طرف أول (SameSite=Lax) ولا نحتاج كوكيز عابرة للمواقع
 * بين Vercel و Render (التي تحجبها متصفحات كثيرة).
 */
const apiUrl = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@abu-qamar/ui'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
