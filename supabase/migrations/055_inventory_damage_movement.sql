-- Migration: 055_inventory_damage_movement
-- Purpose: Add the `damage` inventory movement type, so the ledger can record
--          damaged stock (DATA_MODEL.md §39 lists DAMAGE; migration 021 left it
--          post-MVP). Its first and only writer is the customer Returns
--          foundation (migration 056): a returned unit that is not resellable
--          is recorded as `return` +n followed by `damage` −n, so the ledger
--          keeps the full story while sellable on-hand (SUM(quantity_delta))
--          does not grow.
--
-- Additive only. One enum value is appended; nothing is changed or dropped.
--
-- Why a separate file: a new enum value cannot be referenced in the same
-- transaction that adds it ("unsafe use of new enum value"). Migration 056's
-- CHECK constraints and RPCs use 'damage', so the value must be committed first.

ALTER TYPE public.inventory_movement_type ADD VALUE IF NOT EXISTS 'damage';
