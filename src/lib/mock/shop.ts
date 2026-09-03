import type { Courier, Shop, Staff, WorkspaceSummary } from "@/types";
import { usd } from "@/lib/money";

export const shops: Shop[] = [
  { id: "shop-1", nameKm: "ហាងស្រីនាង", nameEn: "Sreyneang Shop", city: "Phnom Penh" },
  { id: "shop-2", nameKm: "ហាងបាវបាវ", nameEn: "Bao Bao Shop", city: "Siem Reap" },
];

export const activeShopId = "shop-1";

/** Business contexts the signed-in person belongs to, with their role in each. */
export const workspaces: WorkspaceSummary[] = [
  {
    id: "shop-1",
    nameKm: "ហាងស្រីនាង",
    nameEn: "Sreyneang Shop",
    city: "Phnom Penh",
    type: "business",
    role: "owner",
    active: true,
  },
  {
    id: "shop-2",
    nameKm: "ហាងបាវបាវ",
    nameEn: "Bao Bao Shop",
    city: "Siem Reap",
    type: "business",
    role: "manager",
    active: false,
  },
];

export const staff: Staff[] = [
  {
    id: "staff-1",
    name: "សុខជា / Sokchea",
    role: "owner",
    companion: "nilo",
    status: "active",
    phone: "012 345 678",
    shopId: "shop-1",
  },
  {
    id: "staff-2",
    name: "Lyda",
    role: "sales",
    companion: "luma",
    status: "active",
    phone: "011 223 344",
    shopId: "shop-1",
  },
  {
    id: "staff-3",
    name: "Ratana",
    role: "customer_service",
    companion: "vela",
    status: "active",
    phone: "078 909 112",
    shopId: "shop-1",
  },
  {
    id: "staff-4",
    name: "Chanthy",
    role: "cashier",
    companion: "minto",
    status: "invited",
    phone: "096 771 220",
    shopId: "shop-1",
    invitedAt: "2026-09-01T09:12:00.000Z",
  },
];

export const couriers: Courier[] = [
  { id: "jt", name: "J&T Express", fee: usd(90), speed: "same_day" },
  { id: "vet", name: "VET Express", fee: usd(75), speed: "next_day" },
  { id: "capital", name: "Capital Express", fee: usd(120), speed: "express" },
  { id: "grab", name: "Grab Express", fee: usd(150), speed: "instant" },
];
