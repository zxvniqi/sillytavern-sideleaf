import test from 'node:test';
import assert from 'node:assert/strict';
import { archivePlan, restorePlan, readDrawer, chatIdentity, KEY } from './model.js';

let counter = 0;
const id = () => `id-${++counter}`;
const message = (text, extra = {}) => ({ name: 'Test', mes: text, is_user: false, extra });

test('only selected messages leave active history; all original fields survive', () => {
    const original = [message('keep'), { ...message('QR', { reasoning: 'reason', image: 'image.png' }), swipes: ['QR', 'alternative'], swipe_id: 0, swipe_info: [{ extra: { custom: [1, 2] } }] }, message('last')];
    const before = structuredClone(original);
    const plan = archivePlan(original, readDrawer({}), [1], id);
    assert.deepEqual(original, before);
    assert.deepEqual(plan.chat.map(x => x.mes), ['keep', 'last']);
    assert.deepEqual(plan.drawer.items[0].message, before[1]);
    plan.drawer.items[0].message.extra.reasoning = 'changed';
    assert.deepEqual(original, before);
});

test('non-contiguous selection is deduplicated and keeps chronological order', () => {
    const plan = archivePlan(['a', 'b', 'c', 'd', 'e'].map(x => message(x)), readDrawer({}), [3, 1, 3], id);
    assert.deepEqual(plan.chat.map(x => x.mes), ['a', 'c', 'e']);
    assert.deepEqual(plan.drawer.items.map(x => x.message.mes), ['b', 'd']);
    const restored = restorePlan(plan.chat, plan.drawer, plan.drawer.items.map(x => x.id).reverse(), id);
    assert.deepEqual(restored.chat.map(x => x.mes), ['a', 'c', 'e', 'b', 'd']);
    assert.equal(restored.drawer.items.length, 0);
});

test('invalid, empty, and whole-chat selections cannot remove data', () => {
    const chat = [message('a'), message('b')];
    for (const indices of [[], [-1], [2], [0.5], [0, 1]]) assert.throws(() => archivePlan(chat, readDrawer({}), indices, id));
    assert.deepEqual(chat.map(x => x.mes), ['a', 'b']);
});

test('restoring one item preserves every other archived item and unknown fields', () => {
    const plan = archivePlan(['a', 'b', 'c'].map(x => message(x)), { ...readDrawer({}), custom: 42 }, [1, 2], id);
    const restored = restorePlan(plan.chat, plan.drawer, [plan.drawer.items[1].id], id);
    assert.deepEqual(restored.chat.map(x => x.mes), ['a', 'c']);
    assert.deepEqual(restored.drawer.items.map(x => x.message.mes), ['b']);
    assert.equal(restored.drawer.custom, 42);
    assert.throws(() => restorePlan(restored.chat, restored.drawer, [plan.drawer.items[1].id], id));
});

test('metadata is isolated by chat/character/group, unsupported versions are rejected', () => {
    const a = { chatId: 'same', characterId: 0, characters: [{ avatar: 'a.png' }] };
    assert.notEqual(chatIdentity(a), chatIdentity({ ...a, characters: [{ avatar: 'b.png' }] }));
    assert.notEqual(chatIdentity(a), chatIdentity({ ...a, groupId: 'a' }));
    assert.equal(chatIdentity({}), null);
    assert.throws(() => readDrawer({ [KEY]: { version: 2, items: [] } }));
});

test('10,000-message selection and JSON roundtrip preserve exact content', () => {
    const chat = Array.from({ length: 10000 }, (_, i) => message(`message ${i} <script>test</script>`));
    const plan = archivePlan(chat, readDrawer({}), [1, 5000, 9999], id);
    const persisted = JSON.parse(JSON.stringify({ chat_metadata: { [KEY]: plan.drawer } }));
    const drawer = readDrawer(persisted.chat_metadata);
    assert.equal(plan.chat.length, 9997);
    assert.deepEqual(drawer.items.map(x => x.message), [chat[1], chat[5000], chat[9999]]);
});
