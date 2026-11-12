/* eslint-disable prettier/prettier */
import { GenericCourierProvider } from '../generic-courier.provider';
import { SWYFT_MAPPING } from './swyft.mapping';

/** Swyft Logistics adapter — all behaviour comes from ./swyft.mapping.ts (UNVERIFIED, see its header). */
export class SwyftCourierProvider extends GenericCourierProvider {
  constructor() { super(SWYFT_MAPPING); }
}
