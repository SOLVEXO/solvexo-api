/* eslint-disable prettier/prettier */
// Types only.

/** One tax actually charged on an invoice. `ratePercent`/`label`/`country` are null when the source never stored them. */
export interface TaxLine {
  label: string | null;
  ratePercent: number | null;
  amountUSD: number;
  country: string | null;
}
