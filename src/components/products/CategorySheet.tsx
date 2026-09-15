import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BottomSheet } from "@/design-system";
import { useLanguage } from "@/lib/i18n";
import {
  catalogErrorKey,
  categoryLabel,
  classifyCatalogError,
  createCatalogCategory,
  updateCatalogCategory,
  type CatalogCategory,
} from "@/lib/catalog";

interface CategorySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Active and archived categories, as the server returned them. */
  categories: readonly CatalogCategory[];
  onChanged: () => void;
}

/**
 * Create, rename and archive product categories.
 *
 * The whole sheet is only mounted for a member with products.manage_categories
 * (see /app/products), and every call inside it is re-authorized by
 * createCategory/updateCategory in src/server/products/service.ts. Categories
 * are archived, never deleted — the same rule products follow.
 */
export function CategorySheet({ open, onOpenChange, categories, onChanged }: CategorySheetProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const [nameKm, setNameKm] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [touched, setTouched] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const nameError = touched && nameKm.trim() === "" ? t("catalog.category.nameKmMissing") : null;

  async function addCategory() {
    setTouched(true);
    if (nameKm.trim() === "") return;
    setSaving(true);
    setFormError(null);
    try {
      await createCatalogCategory({
        nameKm: nameKm.trim(),
        nameEn: nameEn.trim() === "" ? null : nameEn.trim(),
      });
      setNameKm("");
      setNameEn("");
      setTouched(false);
      onChanged();
    } catch (err) {
      setFormError(t(catalogErrorKey(classifyCatalogError(err))));
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(category: CatalogCategory, status: "ACTIVE" | "ARCHIVED") {
    setBusyId(category.id);
    setFormError(null);
    try {
      await updateCatalogCategory({ categoryId: category.id, status });
      onChanged();
    } catch (err) {
      setFormError(t(catalogErrorKey(classifyCatalogError(err))));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("catalog.category.title")}
      snap="full"
      className="lg:max-w-[520px]"
    >
      <div className="space-y-5">
        <div className="space-y-3 rounded-2xl border border-border-default p-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="category-name-km" className="text-label text-text-secondary">
              {t("catalog.category.nameKm")}
            </Label>
            <Input
              id="category-name-km"
              className="h-12"
              value={nameKm}
              lang="km"
              aria-invalid={nameError ? true : undefined}
              onChange={(event) => setNameKm(event.target.value)}
            />
            {nameError ? (
              <p className="text-caption text-status-danger-text" role="alert">
                {nameError}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="category-name-en" className="text-label text-text-secondary">
              {t("catalog.category.nameEn")}
            </Label>
            <Input
              id="category-name-en"
              className="h-12"
              value={nameEn}
              lang="en"
              onChange={(event) => setNameEn(event.target.value)}
            />
          </div>

          <Button
            className="tap-target h-12 w-full"
            disabled={saving}
            onClick={() => void addCategory()}
          >
            {saving ? t("catalog.saving") : t("catalog.category.add")}
          </Button>
        </div>

        {formError ? (
          <p className="text-caption text-status-danger-text" role="alert">
            {formError}
          </p>
        ) : null}

        {categories.length === 0 ? (
          <p className="text-body-sm text-text-secondary">{t("catalog.category.empty")}</p>
        ) : (
          <ul className="divide-y divide-border-default">
            {categories.map((category) => {
              const archived = category.status === "ARCHIVED";
              return (
                <li
                  key={category.id}
                  className="flex min-w-0 items-center justify-between gap-3 py-2.5"
                >
                  <span className="text-body min-w-0 flex-1 text-text-primary">
                    <span className="chip-text">{categoryLabel(category, language)}</span>
                    {archived ? (
                      <span className="text-caption ml-2 text-text-muted">
                        {t("catalog.list.status.archived")}
                      </span>
                    ) : null}
                  </span>
                  <Button
                    variant="outline"
                    className="tap-target h-10 shrink-0"
                    disabled={busyId === category.id}
                    onClick={() => void setStatus(category, archived ? "ACTIVE" : "ARCHIVED")}
                  >
                    {archived ? t("catalog.category.restore") : t("catalog.category.archive")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </BottomSheet>
  );
}
