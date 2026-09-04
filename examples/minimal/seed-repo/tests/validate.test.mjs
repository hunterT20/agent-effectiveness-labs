import assert from 'node:assert/strict';
import test from 'node:test';

import { isValidEmail } from '../src/validate.mjs';

test('accepts a simple address', () => {
  assert.equal(isValidEmail('user@example.com'), true);
});

test('rejects an address without "@"', () => {
  assert.equal(isValidEmail('user.example.com'), false);
});

// TODO: add a regression test for domains without a dot (e.g. "user@example").
