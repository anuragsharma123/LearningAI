import { CustomerId } from "../types.js";

export interface BudgetStore {
  getSpend(customerId: CustomerId, day: string): number;
  addSpend(customerId: CustomerId, day: string, tokens: number): number;
  getBudget(customerId: CustomerId): number;
}
const DAILY_BUDGET_USD = 10;

export class InMemoryBudgetStore implements BudgetStore {
  private spend = new Map<string, number>();

  getSpend(customerId: CustomerId, day: string): number {
    return this.spend.get(`${customerId}:${day}`) ?? 0;
  }

  addSpend(customerId: CustomerId, day: string, amount: number): number {
    const key = `${customerId}:${day}`;
    const total = this.getSpend(customerId, day) + amount;
    this.spend.set(key, total);
    return total;
  }

  getBudget(_customerId: CustomerId): number {
    return DAILY_BUDGET_USD;
  }
}