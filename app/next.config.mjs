/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The program's IDL and the committed fixtures live outside app/, and the
  // build must not silently succeed with a stale copy of either.
  outputFileTracingRoot: new URL("..", import.meta.url).pathname,
};

export default nextConfig;
