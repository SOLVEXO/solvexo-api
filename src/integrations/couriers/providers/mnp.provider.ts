/* eslint-disable prettier/prettier */
import { GenericCourierProvider } from '../generic-courier.provider';
import { MNP_MAPPING } from './mnp.mapping';

/** M&P (Muller & Phipps) adapter — all behaviour comes from ./mnp.mapping.ts (UNVERIFIED, see its header). */
export class MnpCourierProvider extends GenericCourierProvider {
  constructor() { super(MNP_MAPPING); }
}
