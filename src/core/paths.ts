/**
 * Resolves a path into `public/` against the Vite base URL.
 *
 * The app deploys under a sub-path (GitHub Pages project page), so a bare
 * `/models/...` escapes the deployment root and 404s. Absolute and data URLs
 * pass through untouched.
 */
export function assetUrl(path: string): string {
  if (/^(https?:)?\/\//.test(path) || path.startsWith('data:')) return path;
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`;
}
