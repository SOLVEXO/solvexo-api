/* eslint-disable prettier/prettier */
import { TraxCourierProvider } from './trax.provider';
import { PLACEHOLDER_BODIES, runCourierContract } from './courier-contract.testkit';

runCourierContract({
  name: 'trax',
  make: () => new TraxCourierProvider(),
  ctx: { credentials: { apiKey: 'SECRET-KEY-VALUE-42' }, mode: 'sandbox', config: {} },
  secretValue: 'SECRET-KEY-VALUE-42',
  bodies: { ...PLACEHOLDER_BODIES, bookValidation: { status: 400, body: { message: 'Invalid phone SECRET-KEY-VALUE-42' } } },
});
