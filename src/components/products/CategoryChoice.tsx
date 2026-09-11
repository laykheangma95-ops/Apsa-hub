import { Chip, ChipRow } from "@/design-system";
import { useLanguage } from "@/lib/i18n";
import { categoryLabel, type CatalogCategory } from "@/lib/catalog";

interface CategoryChoiceProps {
  categories: readonly CatalogCategory[];
  /** null means "no category" — a real, storable choice, not an absence of one. */
  value: string | null;
  onChange: (next: string | null) => void;
  label: string;
  disabled?: boolean;
  /** Copy for the null option: "All" when filtering, "No category" when editing. */
  noneLabel: string;
  /**
   * The row bleeds to the screen edge by default so chips can scroll on a
   * 320px phone. Inside a card, pass "mx-0 px-0" to keep the card's padding.
   */
  className?: string;
}

/**
 * Category as a chip row rather than a dropdown.
 *
 * Khmer category names do not truncate cleanly into a select's single line, and
 * the same control is used for the list filter and the product form so the two
 * read as one idea. Chips wrap/scroll instead of clipping.
 */
export function CategoryChoice({
  categories,
  value,
  onChange,
  label,
  disabled = false,
  noneLabel,
  className,
}: CategoryChoiceProps) {
  const { language } = useLanguage();

  return (
    <ChipRow label={label} {...(className ? { className } : {})}>
      <Chip selected={value === null} disabled={disabled} onClick={() => onChange(null)}>
        {noneLabel}
      </Chip>
      {categories.map((category) => (
        <Chip
          key={category.id}
          selected={value === category.id}
          disabled={disabled}
          onClick={() => onChange(category.id)}
        >
          {categoryLabel(category, language)}
        </Chip>
      ))}
    </ChipRow>
  );
}
