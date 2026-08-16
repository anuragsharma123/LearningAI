export type CustomerId = string;

export class BudgetExceededError extends Error {
    name: string;
    customerId: CustomerId | undefined;

  constructor(message: string, customerId?: CustomerId) {
    super(message);
    this.name = "BudgetExceededError";
    this.customerId = customerId;
  }
}
export interface AgentContext {
    customerId: CustomerId;
}   

export const todayHelper = () => {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};  