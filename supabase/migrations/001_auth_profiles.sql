-- Migration: 001_auth_profiles
-- Purpose: User profile table that extends Supabase Auth (auth.users)
-- Tables: profiles
-- Classification: user-private (each row belongs to one auth user)
-- Tenant ownership: no organization_id — cross-org identity
-- RLS: each user can read/update their own row; service role has full access
-- Rollback: DROP TABLE public.profiles; DROP TRIGGER ...; DROP FUNCTION ...;

-- Enum for user lifecycle
CREATE TYPE public.user_status AS ENUM ('active', 'suspended', 'deleted');

-- Profiles: one row per Supabase Auth user.
-- Never store passwords here — Supabase Auth owns credentials.
CREATE TABLE public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  phone       TEXT,
  display_name TEXT,
  avatar_url  TEXT,
  locale      TEXT NOT NULL DEFAULT 'km',
  timezone    TEXT NOT NULL DEFAULT 'Asia/Phnom_Penh',
  status      public.user_status NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_profiles_email ON public.profiles(email);

-- Auto-insert profile row when a new auth user is created.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1))
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Users can read and update their own profile only.
CREATE POLICY "profiles_select_own"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "profiles_update_own"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- No direct INSERT/DELETE from client — handled by trigger and admin operations.
