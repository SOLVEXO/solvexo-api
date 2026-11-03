/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateEmployeeDto } from './create-employee.dto';
import { UpdateEmployeeDto } from './update-employee.dto';
import { PinLoginDto } from './pin-login.dto';
import { ResetPinDto } from './reset-pin.dto';

/**
 * Gap #28 (PIN-length mismatch). A PIN is only usable if the PIN-login endpoint accepts it, so EVERY endpoint that
 * lets an owner/manager SET a PIN must accept exactly the PINs login accepts — otherwise an employee gets a PIN
 * they can never type (reset-pin used to accept 4–6 digits while login demands exactly 4).
 */
const candidates = ['', '1', '123', '1234', '0000', '12345', '123456', '1234567', '12a4', '１２３４', ' 123', '12 4'];
const accepted = (cls: any, field: string, pin: string, extra: object = {}) =>
  validateSync(plainToInstance(cls, { [field]: pin, ...extra }), { skipMissingProperties: true })
    .every((e) => e.property !== field);

describe('PIN validation contract (setting a PIN ⇔ logging in with it)', () => {
  const login = (pin: string) => accepted(PinLoginDto, 'pin', pin);

  it.each([
    ['reset-pin', (pin: string) => accepted(ResetPinDto, 'newPin', pin)],
    ['create-employee', (pin: string) => accepted(CreateEmployeeDto, 'pin', pin)],
    ['update-employee', (pin: string) => accepted(UpdateEmployeeDto, 'pin', pin)],
  ])('%s accepts a PIN only if PIN-login would accept it', (_name, setPin) => {
    for (const pin of candidates) {
      if (setPin(pin)) expect({ pin, loginAccepts: login(pin) }).toEqual({ pin, loginAccepts: true });
    }
  });

  it('a normal 4-digit PIN works end to end; 5–6 digit and non-numeric PINs are refused at the setter', () => {
    expect(accepted(ResetPinDto, 'newPin', '1234')).toBe(true);
    for (const bad of ['12345', '123456', '123', '12a4']) expect(accepted(ResetPinDto, 'newPin', bad)).toBe(false);
  });
});
