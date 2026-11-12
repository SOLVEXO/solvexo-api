/* eslint-disable prettier/prettier */
import { GenericCourierProvider } from '../generic-courier.provider';
import { BLUEEX_MAPPING } from './blueex.mapping';

/** BlueEx adapter — all behaviour comes from ./blueex.mapping.ts (UNVERIFIED, see its header). */
export class BlueexCourierProvider extends GenericCourierProvider {
  constructor() { super(BLUEEX_MAPPING); }
}
