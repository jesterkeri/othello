/**
 * Mirrors a screen's theme variables onto the document root.
 *
 * Every screen writes its own variables onto its own root element, which is
 * enough for everything inside the frame. It is not enough for the document:
 * `body` sits outside that element, and so does the overscroll area a browser
 * paints above and below the page when you scroll past either end. Those read
 * the variables on `:root`, which layout.tsx renders with the light default.
 *
 * Without this, dark mode leaves a light strip behind the frame at both ends.
 */
export function applyThemeToDocument(vars: Record<string, string>, mode: "light" | "dark") {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.dataset["theme"] = mode;
  root.style.colorScheme = mode;
}
