import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_ALLOWED_TYPES, isContentAllowed } from '../src/background/messageGuard.ts';

describe('content script message allowlist', () => {
  it('allows OPEN_PREVIEW and PING only', () => {
    assert.equal(isContentAllowed('OPEN_PREVIEW'), true);
    assert.equal(isContentAllowed('PING'), true);
    assert.equal(isContentAllowed('GET_STATUS'), false);
    assert.equal(isContentAllowed('START_QUEUE'), false);
  });
});
