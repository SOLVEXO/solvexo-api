/* eslint-disable prettier/prettier */
import { GenericCourierProvider } from '../generic-courier.provider';
import { DAEWOO_FASTEX_MAPPING } from './daewoo_fastex.mapping';

/** Daewoo FastEx adapter — all behaviour comes from ./daewoo_fastex.mapping.ts (UNVERIFIED, see its header). */
export class DaewooFastexCourierProvider extends GenericCourierProvider {
  constructor() { super(DAEWOO_FASTEX_MAPPING); }
}
