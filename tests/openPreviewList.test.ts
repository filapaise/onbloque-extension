import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_ALLOWED_TYPES, isContentAllowed } from '../src/background/messageGuard.ts';

describe('content script message allowlist', () => {
  it('allows OPEN_PREVIEW, GET_PROGRESS (counts only), PING and the FAB position (1.3.2) only', () => {
    assert.deepEqual([...CONTENT_ALLOWED_TYPES].sort(), ['GET_FAB_POS', 'GET_PROGRESS', 'OPEN_PREVIEW', 'PING', 'SET_FAB_POS']);
    assert.equal(isContentAllowed('GET_PROGRESS'), true);
    assert.equal(isContentAllowed('OPEN_PREVIEW'), true);
    assert.equal(isContentAllowed('PING'), true);
    assert.equal(isContentAllowed('GET_STATUS'), false);
    assert.equal(isContentAllowed('START_QUEUE'), false);
  });
});
