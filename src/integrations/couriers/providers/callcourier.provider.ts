/* eslint-disable prettier/prettier */
import { GenericCourierProvider } from '../generic-courier.provider';
import { CALLCOURIER_MAPPING } from './callcourier.mapping';

/** CallCourier adapter — all behaviour comes from ./callcourier.mapping.ts (UNVERIFIED, see its header). */
export class CallcourierCourierProvider extends GenericCourierProvider {
  constructor() { super(CALLCOURIER_MAPPING); }
}
