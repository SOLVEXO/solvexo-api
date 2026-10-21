/* eslint-disable prettier/prettier */
import { CUSTOMER_EMAIL_CATALOG } from './customer-email-events';
import { pickEmailText } from './customer-email-text.util';

const EVENT = 'order_confirmation' as keyof typeof CUSTOMER_EMAIL_CATALOG;
const settings = {
  events: { [EVENT]: { subject: 'Base subject', body: 'Base body' } },
  eventTranslations: { [EVENT]: { de: { subject: 'Betreff', body: 'Text' }, en: { subject: 'English subject' } } },
};

describe('pickEmailText', () => {
  it('English store: the seller\'s own text for English buyers, their translation for others', () => {
    expect(pickEmailText(EVENT, 'en', settings).subject).toBe('Base subject');
    expect(pickEmailText(EVENT, 'de', settings).subject).toBe('Betreff');
  });

  it('English store: an untranslated language falls back to the seller\'s own text', () => {
    expect(pickEmailText(EVENT, 'fr', settings).subject).toBe('Base subject');
  });

  it('German store: German buyers get the seller\'s base text; English buyers get their English translation or the built-in English', () => {
    expect(pickEmailText(EVENT, 'de', settings, undefined, 'de').subject).toBe('Base subject');
    expect(pickEmailText(EVENT, 'en', settings, undefined, 'de').subject).toBe('English subject');
    expect(pickEmailText(EVENT, 'en', { events: settings.events }, undefined, 'de').subject).toBe(CUSTOMER_EMAIL_CATALOG[EVENT].defaultSubject);
  });

  it('an unsaved draft replaces the saved text of that language only', () => {
    expect(pickEmailText(EVENT, 'de', settings, { subject: 'Entwurf' }, 'en').subject).toBe('Entwurf');
    expect(pickEmailText(EVENT, 'en', settings, { subject: 'Draft' }, 'en').subject).toBe('Draft');
  });
});
