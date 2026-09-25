/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // app/ is self-contained: the program's IDL is copied into src/idl (T18) and
  // tests/app-live.spec.ts pins it to the deployed program. The root is app/
  // itself, not the repo root: Vercel uploads app/ alone, and a root above it
  // doubled the build path (/vercel/path0/path0/.next). Pinned rather than
  // inferred because the repo root has a second lockfile.
  outputFileTracingRoot: new URL(".", import.meta.url).pathname,
};

export default nextConfig;
