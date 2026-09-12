import { Chip, ChipRow } from "@/design-system";
import type { InventoryLocation } from "@/lib/inventory";

interface LocationChoiceProps {
  locations: readonly InventoryLocation[];
  /**
   * null means "no location" — a real, storable choice. `location_id` is
   * nullable in migration 021 because not every merchant tracks stock per
   * branch yet, so this is an absence the ledger records, not a missing answer.
   */
  value: string | null;
  onChange: (next: string | null) => void;
  label: string;
  noneLabel: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Location as a chip row rather than a dropdown, for the same reason
 * CategoryChoice is: a Khmer branch name does not truncate cleanly into a
 * select's single line, and chips wrap instead of clipping.
 *
 * Only ACTIVE locations are offered. An inactive branch is still shown on
 * existing stock rows (history must stay readable) but is not a destination
 * for new stock.
 */
export function LocationChoice({
  locations,
  value,
  onChange,
  label,
  noneLabel,
  disabled = false,
  className,
}: LocationChoiceProps) {
  return (
    <ChipRow label={label} {...(className ? { className } : {})}>
      <Chip selected={value === null} disabled={disabled} onClick={() => onChange(null)}>
        {noneLabel}
      </Chip>
      {locations.map((location) => (
        <Chip
          key={location.id}
          selected={value === location.id}
          disabled={disabled}
          onClick={() => onChange(location.id)}
        >
          {location.name}
        </Chip>
      ))}
    </ChipRow>
  );
}
