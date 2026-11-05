/* eslint-disable prettier/prettier */
import { GenericCourierProvider } from '../generic-courier.provider';
import { LEOPARDS_MAPPING } from './leopards.mapping';

/** Adapter — all behaviour comes from ./leopards.mapping.ts (UNVERIFIED, see its header). */
export class LeopardsCourierProvider extends GenericCourierProvider {
  constructor() { super(LEOPARDS_MAPPING); }
}
