import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseItem, isoWithOffset, newPostIds, splitCaption, tiktokIdTime } from '../src/tiktok/queue-runner.js';

const index = {
    schema: 'assayist/queue/v1',
    items: [
        { item: 'a', post_after: '2026-10-02T18:00:00+02:00' },
        { item: 'b', post_after: '2026-10-03T18:00:00+02:00' },
    ],
};
const at = (iso: string) => Date.parse(iso);

test('nothing is posted before its post_after', () => {
    assert.deepEqual(chooseItem(index, new Map(), new Set(), at('2026-10-02T17:59:00+02:00')), { why: 'nothing is due yet' });
});

test('the first due item is posted in its slot', () => {
    assert.equal(chooseItem(index, new Map(), new Set(), at('2026-10-02T18:05:00+02:00')).item, 'a');
});

test('a backlog drains one post per slot', () => {
    const now = at('2026-10-03T18:10:00+02:00');
    assert.equal(chooseItem(index, new Map(), new Set(), now).item, 'a');
    const posted = new Map([['a', '2026-10-03T18:06:00+02:00']]);
    assert.equal(chooseItem(index, posted, new Set(), now).why, 'this slot already has a post');
});

test('an item that may already be live is never chosen again', () => {
    const now = at('2026-10-02T18:30:00+02:00');
    assert.equal(chooseItem(index, new Map(), new Set(['a']), now).item, undefined);
    assert.match(chooseItem(index, new Map(), new Set(['a']), now, 'a').why, /may already be live/);
});

test('--post-now only forces a queued, unposted item', () => {
    const now = at('2026-09-28T20:00:00+02:00');
    assert.equal(chooseItem(index, new Map(), new Set(), now, 'a').item, 'a');
    assert.match(chooseItem(index, new Map([['a', 'x']]), new Set(), now, 'a').why, /already has posted.json/);
    assert.match(chooseItem(index, new Map(), new Set(), now, 'zzz').why, /not in the queue/);
});

test('TikTok ids decode to their creation time', () => {
    assert.equal(new Date(tiktokIdTime('7686141394162912544')).toISOString(), '2026-09-16T14:34:08.000Z');
});

test('only posts created after the submission count as new', () => {
    const before = new Set(['7686141394162912544']);
    const since = tiktokIdTime('7686141394162912544') + 60_000;
    assert.deepEqual(newPostIds(['7686141394162912544', '7686055733816773921'], before, since), []);
});

test('posted_at carries the Brussels offset', () => {
    assert.equal(isoWithOffset(at('2026-10-01T16:00:12Z')), '2026-10-01T18:00:12+02:00');
    assert.equal(isoWithOffset(at('2026-12-01T17:00:00Z')), '2026-12-01T18:00:00+01:00');
});

test('caption.txt splits into TikTok title and description only when it is exactly both', () => {
    const manifest = { schema: '', post_id: '', post_after: '', kind: 'photo', slides: [], title: 'T', description: 'D #x' };
    assert.deepEqual(splitCaption('T\n\nD #x\n', manifest), { title: 'T', caption: 'D #x' });
    assert.deepEqual(splitCaption('Something else\n', manifest), { caption: 'Something else' });
});
