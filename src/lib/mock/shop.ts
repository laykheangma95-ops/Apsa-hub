import type { Courier, Shop, Staff } from "@/types";
import { usd } from "@/lib/money";

export const shops: Shop[] = [
  { id: "shop-1", nameKm: "ហាងស្រីនាង", nameEn: "Sreyneang Shop", city: "Phnom Penh" },
  { id: "shop-2", nameKm: "ហាងបាវបាវ", nameEn: "Bao Bao Shop", city: "Phnom Penh" },
];

export const activeShopId = "shop-1";

export const staff: Staff[] = [
  { id: "staff-1", name: "សុខជា / Sokchea", role: "owner", companion: "nilo" },
  { id: "staff-2", name: "Lyda", role: "sales", companion: "luma" },
  { id: "staff-3", name: "Ratana", role: "customer_service", companion: "vela" },
];

export const couriers: Courier[] = [
  { id: "jt", name: "J&T Express", fee: usd(90), speed: "same_day" },
  { id: "vet", name: "VET Express", fee: usd(75), speed: "next_day" },
  { id: "capital", name: "Capital Express", fee: usd(120), speed: "express" },
  { id: "grab", name: "Grab Express", fee: usd(150), speed: "instant" },
];
