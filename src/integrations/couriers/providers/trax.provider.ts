/* eslint-disable prettier/prettier */
import { GenericCourierProvider } from '../generic-courier.provider';
import { TRAX_MAPPING } from './trax.mapping';

/** Trax adapter — all behaviour comes from ./trax.mapping.ts (UNVERIFIED, see its header). */
export class TraxCourierProvider extends GenericCourierProvider {
  constructor() { super(TRAX_MAPPING); }
}
