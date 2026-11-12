/* eslint-disable prettier/prettier */
import { GenericCourierProvider } from '../generic-courier.provider';
import { POSTEX_MAPPING } from './postex.mapping';

/** Adapter — all behaviour comes from ./postex.mapping.ts (UNVERIFIED, see its header). */
export class PostexCourierProvider extends GenericCourierProvider {
  constructor() { super(POSTEX_MAPPING); }
}
