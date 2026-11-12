/* eslint-disable prettier/prettier */
import { TcsCourierProvider } from './tcs.provider';
import { PLACEHOLDER_BODIES, runCourierContract } from './courier-contract.testkit';

runCourierContract({
  name: 'tcs',
  make: () => new TcsCourierProvider(),
  ctx: { credentials: { username: 'merchant1', password: 'SECRET-KEY-VALUE-42' }, mode: 'sandbox', config: {} },
  secretValue: 'SECRET-KEY-VALUE-42',
  bodies: { ...PLACEHOLDER_BODIES, bookValidation: { status: 400, body: { message: 'Invalid phone SECRET-KEY-VALUE-42' } } },
});
