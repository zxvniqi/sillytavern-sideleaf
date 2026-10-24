import test from 'node:test';
import assert from 'node:assert/strict';
import { archivePlan, restorePlan, readDrawer, chatIdentity, KEY, readingVersions, editPlan, deletePlan, orderedItems, reorderPlan, sourceTitle } from './model.js';

let counter = 0;
const id = () => `id-${++counter}`;
const message = (text, extra = {}) => ({ name: 'Test', mes: text, is_user: false, extra });

test('title-only rename does not create or replace an edited body', () => {
    const plan = archivePlan([message('keep'), message('original', {display_text:'번역'})], readDrawer({}), [1], id);
    const renamed = editPlan(plan.chat, plan.drawer, plan.drawer.items[0].id, '새 제목', undefined, id);
    assert.equal(Object.hasOwn(renamed.drawer.items[0], 'editedText'), false);
    assert.deepEqual(readingVersions(renamed.drawer.items[0]).map(v=>v.key), ['translation','original']);
    const edited = editPlan(plan.chat, renamed.drawer, plan.drawer.items[0].id, '제목', {key:'original', text:'수정된 내용'}, id);
    const renamedAgain = editPlan(plan.chat, edited.drawer, plan.drawer.items[0].id, '다른 제목', undefined, id);
    assert.equal(renamedAgain.drawer.items[0].message.mes, '수정된 내용');
    assert.deepEqual(readingVersions(renamedAgain.drawer.items[0]).map(v=>v.label), ['번역·표시문','원문(수정)']);
    assert.deepEqual(readingVersions({...plan.drawer.items[0], editedText:'번역'}).map(v=>v.key), ['translation','original']);
});

test('editing replaces the version being read; restore brings the edited message back', () => {
    const chat = [message('keep'), {...message('Hello', {display_text:'안녕하세요'}), swipes:['Hello','Hi'], swipe_id:0}];
    const archived = archivePlan(chat, readDrawer({}), [1], id);
    const before = structuredClone(archived.drawer);
    const itemId = archived.drawer.items[0].id;
    const original = editPlan(archived.chat, archived.drawer, itemId, '제목', {key:'original', text:'Hello there'}, id);
    assert.deepEqual(archived.drawer, before);
    assert.deepEqual(original.drawer.items[0].message.swipes, ['Hello there','Hi']);
    const translated = editPlan(original.chat, original.drawer, itemId, '제목', {key:'translation', text:'안녕'}, id);
    assert.deepEqual(readingVersions(translated.drawer.items[0]).map(v=>[v.label, v.text]), [['번역·표시문(수정)','안녕'],['원문(수정)','Hello there']]);
    const restored = restorePlan(translated.chat, translated.drawer, [itemId], id).chat;
    assert.equal(restored[1].mes, 'Hello there');
    assert.equal(restored[1].extra.display_text, '안녕');
    assert.equal(chat[1].mes, 'Hello');
    assert.throws(() => editPlan(archived.chat, archived.drawer, itemId, '', {key:'unknown', text:'x'}, id));
});

test('restoring to original positions rebuilds the order across several archive batches', () => {
    const chat = ['a','b','c','d','e','f'].map(x => message(x));
    const first = archivePlan(chat, readDrawer({}), [1, 3], id, 100);          // b, d
    const second = archivePlan(first.chat, first.drawer, [2], id, 200);        // e (index 2 after removal)
    const ids = second.drawer.items.map(x => x.id);
    assert.deepEqual(restorePlan(second.chat, second.drawer, ids, id, 'original').chat.map(x => x.mes), ['a','b','c','d','e','f']);
    assert.deepEqual(restorePlan(second.chat, second.drawer, ids, id).chat.map(x => x.mes), ['a','c','f','b','d','e']);
    const shortened = restorePlan([message('only')], second.drawer, [ids[2]], id, 'original').chat.map(x => x.mes);
    assert.deepEqual(shortened, ['only','e']);
});

test('deleting removes only the chosen items and their manual order entries', () => {
    const p = archivePlan(['keep','one','two'].map(x=>message(x)), readDrawer({}), [1,2], id);
    const ids = p.drawer.items.map(x=>x.id);
    const ordered = reorderPlan(p.chat, p.drawer, [ids[1], ids[0]], id).drawer;
    const removed = deletePlan(p.chat, ordered, [ids[0]], id);
    assert.deepEqual(removed.drawer.items.map(x=>x.message.mes), ['two']);
    assert.deepEqual(removed.drawer.order, [ids[1]]);
    assert.deepEqual(removed.chat.map(x=>x.mes), ['keep']);
    assert.throws(() => deletePlan(p.chat, removed.drawer, [ids[0]], id));
    assert.throws(() => deletePlan(p.chat, removed.drawer, [], id));
});

test('translation is readable in existing archives without migration', () => {
    const item = {message:message('Hello', {display_text:'안녕하세요'})};
    assert.deepEqual(readingVersions(item).map(v=>v.text), ['안녕하세요', 'Hello']);
    assert.equal(readingVersions({message:message('old archive')})[0].text, 'old archive');
});

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

test('sorting and manual order preserve original restore order through JSON', () => {
    const p = archivePlan(['keep','one','two','three'].map(x=>message(x)), readDrawer({}), [1,2,3], id, 100);
    assert.deepEqual(orderedItems(p.drawer,'asc').map(x=>x.message.mes), ['one','two','three']);
    assert.deepEqual(orderedItems(p.drawer,'desc').map(x=>x.message.mes), ['three','two','one']);
    const ids=p.drawer.items.map(x=>x.id), order=[ids[1],ids[2],ids[0]];
    const moved=reorderPlan(p.chat,p.drawer,order,id);
    const persisted=JSON.parse(JSON.stringify(moved.drawer));
    assert.deepEqual(orderedItems(persisted,'manual').map(x=>x.message.mes), ['two','three','one']);
    assert.deepEqual(restorePlan(p.chat,persisted,order,id).chat.map(x=>x.mes), ['keep','one','two','three']);
    assert.deepEqual(p.drawer.items.map(x=>x.id),ids);
    assert.throws(()=>reorderPlan(p.chat,p.drawer,[ids[0],ids[0],ids[2]],id));
    assert.throws(()=>reorderPlan(p.chat,p.drawer,[...ids,'missing'],id));
    const extra={id:'new',archivedAt:200,message:message('new')};
    assert.deepEqual(orderedItems({...persisted,items:[...persisted.items,extra],order:[...order,'missing',order[0]]},'manual').map(x=>x.message.mes), ['new','two','three','one']);
});

test('QR titles prefer accepted subject and tolerate malformed metadata', () => {
    assert.equal(sourceTitle({label:'분석',subject:'  바다\n 여행  '}),'바다 여행');
    assert.equal(sourceTitle({label:'분석',subject:' '}),'분석');
    assert.equal(sourceTitle({label:123,subject:{}}),'');
    const p=archivePlan([message('keep'),message('result',{sideleafSource:{label:'분석',subject:'주제'}})],readDrawer({}),[1],id);
    assert.equal(p.drawer.items[0].title,'주제');
    assert.equal(p.chat.length,1);
});


test('legacy closed-details capture cannot hide the intact original body', () => {
    const item={message:message('<details><summary>Heading</summary>Complete body</details>'),screenText:'Heading'};
    assert.deepEqual(readingVersions(item).map(x=>x.key),['original','screen']);
    assert.ok(readingVersions(item)[0].text.includes('Complete body'));
    const full={...item,screenText:'Heading\nComplete body',screenTextComplete:true};
    assert.deepEqual(readingVersions(full).map(x=>x.key),['original','screen']);
    assert.equal(readingVersions({...item,message:message(item.message.mes,{display_text:'Full translated body'})})[0].key,'translation');
});
