/* eslint-disable prettier/prettier */
/**
 * The default chart of accounts every store starts with when it turns accounting on (Accounting Plan, Phase 1).
 * `key` is permanent: posting rules address accounts by it, so a seller may rename an account or change its code
 * (to match their accountant's numbering) without breaking anything. Custom accounts get a generated key.
 */
export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export interface AccountDef { key: string; code: string; name: string; type: AccountType; group: string }

export const DEFAULT_ACCOUNTS: AccountDef[] = [
  { key: 'cash', code: '1000', name: 'Cash in hand', type: 'asset', group: 'Cash and bank' },
  { key: 'petty_cash', code: '1010', name: 'Petty cash', type: 'asset', group: 'Cash and bank' },
  { key: 'cash_safe', code: '1020', name: 'Cash in safe', type: 'asset', group: 'Cash and bank' },
  { key: 'bank', code: '1100', name: 'Bank', type: 'asset', group: 'Cash and bank' },
  { key: 'card_clearing', code: '1150', name: 'Card and wallet payments clearing (POS)', type: 'asset', group: 'Clearing' },
  { key: 'cod_receivable', code: '1155', name: 'Cash on delivery receivable', type: 'asset', group: 'Clearing' },
  { key: 'gateway_clearing', code: '1158', name: 'Online payment gateways clearing', type: 'asset', group: 'Clearing' },
  { key: 'solvexo_receivable', code: '1160', name: 'Solvexo balance', type: 'asset', group: 'Clearing' },
  { key: 'other_clearing', code: '1190', name: 'Other payments clearing', type: 'asset', group: 'Clearing' },
  { key: 'receivables', code: '1200', name: 'Trade receivables (customers, khata)', type: 'asset', group: 'Receivables' },
  { key: 'inventory', code: '1300', name: 'Inventory', type: 'asset', group: 'Inventory' },
  { key: 'input_tax', code: '1400', name: 'Input sales tax', type: 'asset', group: 'Taxes' },
  { key: 'payables', code: '2000', name: 'Trade payables (suppliers)', type: 'liability', group: 'Payables' },
  { key: 'output_tax', code: '2100', name: 'Output sales tax payable', type: 'liability', group: 'Taxes' },
  { key: 'wht_payable', code: '2110', name: 'Withholding tax payable', type: 'liability', group: 'Taxes' },
  { key: 'customer_advances', code: '2200', name: 'Customer advances and store credit', type: 'liability', group: 'Customer balances' },
  { key: 'gift_cards', code: '2210', name: 'Gift cards outstanding', type: 'liability', group: 'Customer balances' },
  { key: 'grni', code: '2300', name: 'Goods received not invoiced', type: 'liability', group: 'Payables' },
  { key: 'capital', code: '3000', name: "Owner's capital", type: 'equity', group: 'Equity' },
  { key: 'drawings', code: '3100', name: "Owner's drawings", type: 'equity', group: 'Equity' },
  { key: 'retained_earnings', code: '3200', name: 'Retained earnings', type: 'equity', group: 'Equity' },
  { key: 'opening_suspense', code: '9000', name: 'Opening balance suspense', type: 'equity', group: 'Equity' },
  { key: 'sales_online', code: '4000', name: 'Sales: online store', type: 'income', group: 'Sales' },
  { key: 'sales_pos', code: '4010', name: 'Sales: POS', type: 'income', group: 'Sales' },
  { key: 'sales_b2b', code: '4020', name: 'Sales: B2B / wholesale', type: 'income', group: 'Sales' },
  { key: 'sales_khata', code: '4030', name: 'Sales: on account (khata)', type: 'income', group: 'Sales' },
  { key: 'shipping_income', code: '4100', name: 'Shipping income', type: 'income', group: 'Sales' },
  { key: 'sales_returns', code: '4200', name: 'Sales returns and discounts', type: 'income', group: 'Sales' },
  { key: 'other_income', code: '4900', name: 'Other income', type: 'income', group: 'Other income' },
  { key: 'cogs', code: '5000', name: 'Cost of goods sold', type: 'expense', group: 'Cost of sales' },
  { key: 'inventory_adjustments', code: '5100', name: 'Inventory adjustments and shrinkage', type: 'expense', group: 'Cost of sales' },
  { key: 'platform_fees', code: '6000', name: 'Platform fees (Solvexo)', type: 'expense', group: 'Operating expenses' },
  { key: 'processing_fees', code: '6010', name: 'Payment processing fees', type: 'expense', group: 'Operating expenses' },
  { key: 'exp_rent', code: '6100', name: 'Rent', type: 'expense', group: 'Operating expenses' },
  { key: 'exp_utilities', code: '6110', name: 'Utilities', type: 'expense', group: 'Operating expenses' },
  { key: 'exp_salaries', code: '6120', name: 'Salaries and wages', type: 'expense', group: 'Operating expenses' },
  { key: 'exp_supplies', code: '6130', name: 'Supplies', type: 'expense', group: 'Operating expenses' },
  { key: 'exp_transport', code: '6140', name: 'Transport', type: 'expense', group: 'Operating expenses' },
  { key: 'exp_repairs', code: '6150', name: 'Repairs and maintenance', type: 'expense', group: 'Operating expenses' },
  { key: 'exp_marketing', code: '6160', name: 'Marketing', type: 'expense', group: 'Operating expenses' },
  { key: 'exp_meals', code: '6170', name: 'Meals and refreshments', type: 'expense', group: 'Operating expenses' },
  { key: 'exp_taxes_fees', code: '6180', name: 'Taxes, fees and licences', type: 'expense', group: 'Operating expenses' },
  { key: 'exp_other', code: '6190', name: 'Other expenses', type: 'expense', group: 'Operating expenses' },
  { key: 'cash_over_short', code: '6200', name: 'Cash over and short', type: 'expense', group: 'Operating expenses' },
  { key: 'fx_gain_loss', code: '6300', name: 'Exchange gain or loss', type: 'expense', group: 'Operating expenses' },
];

export const SYSTEM_ACCOUNT_KEYS = new Set(DEFAULT_ACCOUNTS.map(a => a.key));

/** Debit-normal types show a positive balance as debit − credit; the rest as credit − debit. */
export const isDebitNormal = (t: AccountType) => t === 'asset' || t === 'expense';

/** POS expense categories (pos/schemas/pos-expense.schema.ts) → expense accounts. */
export const EXPENSE_CATEGORY_ACCOUNT: Record<string, string> = {
  rent: 'exp_rent', utilities: 'exp_utilities', salaries: 'exp_salaries', supplies: 'exp_supplies', transport: 'exp_transport',
  repairs: 'exp_repairs', marketing: 'exp_marketing', meals: 'exp_meals', taxes_fees: 'exp_taxes_fees', other: 'exp_other',
};
