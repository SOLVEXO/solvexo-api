/* eslint-disable prettier/prettier */
import { GenericCourierProvider } from '../generic-courier.provider';
import { TCS_MAPPING } from './tcs.mapping';

/** TCS adapter — all behaviour comes from ./tcs.mapping.ts (UNVERIFIED, see its header). */
export class TcsCourierProvider extends GenericCourierProvider {
  constructor() { super(TCS_MAPPING); }
}
