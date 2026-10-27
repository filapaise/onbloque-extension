import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseListBody } from '../src/domain/listParse.ts';

describe('parseListBody', () => {
  it('plain text', () => {
    const { list } = parseListBody('# c\n@Alice\nBob\n');
    assert.equal(list.entries.length, 2);
    assert.equal(list.entries[0]!.handle, 'Alice');
  });
  it('onbloque-list json', () => {
    const body = JSON.stringify({
      format: 'onbloque-list/1',
      name: 'T',
      entries: [{ handle: 'A' }, { id: '1', handle: 'B' }],
    });
    const { list } = parseListBody(body);
    assert.equal(list.name, 'T');
    assert.equal(list.entries.length, 2);
  });
  it('csv with header', () => {
    const { list } = parseListBody('screen_name,id_str\nFoo,11\nBar,22\n');
    assert.equal(list.entries.length, 2);
    assert.equal(list.entries[0]!.handle, 'Foo');
    assert.equal(list.entries[0]!.id, '11');
  });
});
