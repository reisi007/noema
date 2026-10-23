/**
 * The one rule for a stored mark colour.
 *
 * A mark colour is a CSS value that a reader's browser resolves, so it may
 * only be a colour the app itself writes: a tag token (`var(--tag-<hue>-fg)`
 * for a text colour, `var(--tag-<hue>-bg)` for a highlight) or a plain hex
 * value from a document stored before the token migration.
 *
 * The export path had this rule and the renderer did not use it, so a stored
 * `url(…)` made the reader's browser fetch a host of the writer's choosing.
 * The rule lives here so the renderer, the export and the paste path cannot
 * drift apart again.
 */

import { TAG_SEQUENCE } from "@/lib/palette";

/** The tag tokens the editor writes for a mark colour. */
const ALLOWED_MARK_COLORS = new Set([
  ...TAG_SEQUENCE.map((hue) => `var(--tag-${hue}-fg)`),
  ...TAG_SEQUENCE.map((hue) => `var(--tag-${hue}-bg)`),
]);

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` - the legacy stored colour form. */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * The colour a mark may carry, or `null` when the value is not on the
 * allowlist. A stored mark can therefore never push a second CSS declaration
 * (or a `url()`) into a `style` attribute, and a reader's browser never
 * fetches a host of the writer's choosing.
 */
export function markColor(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  if (ALLOWED_MARK_COLORS.has(value) || HEX_COLOR.test(value)) return value;
  return null;
}
