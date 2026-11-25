/* eslint-disable prettier/prettier */
import mongoose from 'mongoose';
import { CastErrorFilter } from './cast-error.filter';

const castError = () => {
  const M = mongoose.models.CastProbeStore ?? mongoose.model('CastProbeStore', new mongoose.Schema({ name: String }));
  try { M.findOne({ _id: 'S1' }).cast(); } catch (e) { return e as mongoose.Error.CastError; }
  throw new Error('expected a CastError');
};

const hostFor = (type = 'http') => {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host: any = { getType: () => type, switchToHttp: () => ({ getRequest: () => ({ method: 'GET', originalUrl: '/api/public/selling-plans/S1' }), getResponse: () => ({ status }) }) };
  return { host, status, json };
};

describe('CastErrorFilter', () => {
  it('answers a non-id value with 400 "Invalid id", not a 500', () => {
    const { host, status, json } = hostFor();
    new CastErrorFilter().catch(castError(), host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ statusCode: 400, error: 'Bad Request', message: 'Invalid id: "S1"' });
  });

  it('leaves non-HTTP contexts (websockets) to their own handling', () => {
    const { host } = hostFor('ws');
    expect(() => new CastErrorFilter().catch(castError(), host)).toThrow(mongoose.Error.CastError);
  });
});
