/**
 * Mock permission layer. Real projects resolve this from the session;
 * here it is a pure function of a role so components never decide access.
 */
import type { StaffRole } from "@/types";

export interface Permissions {
  viewCustomerPhone: boolean;
  viewCustomerAddress: boolean;
  viewLifetimeSpend: boolean;
  refund: boolean;
  cancelOrder: boolean;
}

const BY_ROLE: Record<StaffRole, Permissions> = {
  owner: {
    viewCustomerPhone: true,
    viewCustomerAddress: true,
    viewLifetimeSpend: true,
    refund: true,
    cancelOrder: true,
  },
  manager: {
    viewCustomerPhone: true,
    viewCustomerAddress: true,
    viewLifetimeSpend: true,
    refund: true,
    cancelOrder: true,
  },
  cashier: {
    viewCustomerPhone: false,
    viewCustomerAddress: false,
    viewLifetimeSpend: false,
    refund: false,
    cancelOrder: false,
  },
  sales: {
    viewCustomerPhone: true,
    viewCustomerAddress: true,
    viewLifetimeSpend: false,
    refund: false,
    cancelOrder: false,
  },
  customer_service: {
    viewCustomerPhone: true,
    viewCustomerAddress: true,
    viewLifetimeSpend: false,
    refund: false,
    cancelOrder: true,
  },
};

export function permissionsFor(role: StaffRole): Permissions {
  return BY_ROLE[role];
}

/** Keeps the last two digits so staff can still confirm a number read aloud. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const tail = digits.slice(-2);
  return `••• ••• ${tail}`;
}
