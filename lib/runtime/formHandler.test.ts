import { test, expect, describe } from 'bun:test';
import { formHandlerScript } from './formHandler';
import { formHandlerScript as fromBarrel } from '../index';

describe('formHandlerScript', () => {
  test('is exported from the package barrel (BaseLayout imports it from "meno-astro")', () => {
    expect(fromBarrel).toBe(formHandlerScript);
  });

  test('is a self-contained, syntactically valid IIFE', () => {
    expect(typeof formHandlerScript).toBe('string');
    expect(formHandlerScript.trim().startsWith('(function')).toBe(true);
    // Parses as JS (new Function only compiles the body — it never runs the IIFE,
    // so the `document` references inside are not touched).
    expect(() => new Function(formHandlerScript)).not.toThrow();
  });

  test('targets fetch-forms and drives the inline message element', () => {
    // The selector that makes it self-gating (no-op without a fetch form).
    expect(formHandlerScript).toContain('form[data-submit-handler="fetch"]');
    // Submits the form's fields as FormData to its action.
    expect(formHandlerScript).toContain('new FormData(form)');
    // Surfaces the result in the <div data-form-message> the Form component renders.
    expect(formHandlerScript).toContain('[data-form-message]');
    expect(formHandlerScript).toContain('data-success-message');
    expect(formHandlerScript).toContain('data-error-message');
  });
});
