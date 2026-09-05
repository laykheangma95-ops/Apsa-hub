/** Browser-safe Inbox facade. Server capabilities remain behind conversations.ts. */
export {
  getConversation,
  getConversationPage,
  getConversationCounts,
  getCustomers,
  getStaff,
  getCustomer,
  getCustomerOrders,
  getMostRecentRealOrderForCustomer,
  getProducts,
  isProductionId,
  markRealConversationRead,
  updateRealConversationStatus,
  assignRealConversation,
  getOlderConversationMessages,
} from "@/lib/api";
