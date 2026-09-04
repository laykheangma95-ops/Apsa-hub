/**
 * Slug helpers for the founder onboarding flow.
 *
 * These are UX conveniences only. They never decide whether a slug is
 * available — the DB constraint organizations_slug_unique is the only
 * authority on uniqueness, and the server re-validates the format.
 */

/**
 * Derive a suggested slug from a business name.
 *
 * Latin characters are transliterated to a URL-safe form. Scripts without a
 * Latin form (Khmer, for example) yield an empty suggestion — the founder
 * then types the slug themselves rather than receiving a mangled one.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}
