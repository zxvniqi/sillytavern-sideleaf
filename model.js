export const KEY = 'sideleaf_v1';
export const PAGE_SIZE = 30;

export function readDrawer(metadata) {
    const data = metadata?.[KEY];
    if (data === undefined) return { version: 1, revision: '', items: [] };
    if (!data || data.version !== 1 || !Array.isArray(data.items)) throw new Error('지원하지 않는 별지 데이터입니다. 원본은 변경하지 않았습니다.');
    return data;
}

export function archivePlan(chat, drawer, indices, idFactory, now = Date.now()) {
    const ids = [...new Set(indices)].sort((a, b) => a - b);
    if (!ids.length || ids.some(i => !Number.isInteger(i) || i < 0 || i >= chat.length)) throw new Error('메시지 선택을 다시 확인해주세요.');
    // Keep at least one message: ST regenerates the greeting when an empty chat loads.
    if (ids.length === chat.length) throw new Error('대화에는 메시지를 하나 이상 남겨주세요.');
    const picked = new Set(ids);
    const added = ids.map(index => ({
        id: idFactory(), archivedAt: now, originalIndex: index,
        message: structuredClone(chat[index]),
        ...(chat[index]?.extra?.sideleafSource ? { title: sourceTitle(chat[index].extra.sideleafSource) } : {}),
    }));
    return {
        chat: chat.filter((_, i) => !picked.has(i)),
        drawer: { ...drawer, revision: idFactory(), items: [...drawer.items, ...added] },
        affected: added,
    };
}

export function sourceTitle(source) {
    const subject = typeof source?.subject === 'string' ? source.subject.trim() : '';
    const label = typeof source?.label === 'string' ? source.label.trim() : '';
    return (subject || label).replace(/\s+/g, ' ').slice(0, 160);
}

export function orderedItems(drawer, mode = 'desc') {
    const chronological = drawer.items.map((item, index) => ({item,index})).sort((a,b)=>(a.item.archivedAt-b.item.archivedAt)||a.index-b.index).map(x=>x.item);
    if (mode === 'asc') return chronological;
    if (mode !== 'manual' || !Array.isArray(drawer.order)) return chronological.reverse();
    const byId = new Map(drawer.items.map(item=>[item.id,item]));
    const seen = new Set();
    const saved = drawer.order.filter(key=>byId.has(key) && !seen.has(key) && seen.add(key)).map(key=>byId.get(key));
    return [...chronological.reverse().filter(item=>!seen.has(item.id)), ...saved];
}

export function reorderPlan(chat, drawer, order, idFactory) {
    const keys = new Set(drawer.items.map(item=>item.id));
    if (order.length !== keys.size || new Set(order).size !== keys.size || order.some(key=>!keys.has(key))) throw new Error('보관 목록이 변경되었습니다. 순서를 다시 지정해주세요.');
    return { chat: chat.slice(), drawer: {...drawer, order:[...order], revision:idFactory()} };
}

export function restorePlan(chat, drawer, ids, idFactory) {
    const picked = new Set(ids);
    const restored = drawer.items.filter(item => picked.has(item.id));
    if (!restored.length || restored.length !== picked.size) throw new Error('보관 항목이 바뀌었습니다. 다시 선택해주세요.');
    // Explicitly append: guessing a former index after other edits can corrupt story order.
    return {
        chat: [...chat, ...restored.map(item => structuredClone(item.message))],
        drawer: { ...drawer, revision: idFactory(), items: drawer.items.filter(item => !picked.has(item.id)) },
        affected: restored,
    };
}

export function chatIdentity(context) {
    if (!context.chatId) return null;
    if (context.groupId != null) return JSON.stringify(['group', context.groupId, context.chatId]);
    const avatar = context.characters?.[context.characterId]?.avatar;
    return avatar ? JSON.stringify(['character', avatar, context.chatId]) : null;
}

export function preview(message, limit = 160) {
    return String(message?.mes ?? '').slice(0, limit * 3).replace(/\s+/g, ' ').slice(0, limit) || '(본문 없는 메시지)';
}

export function readingVersions(item) {
    const versions = [];
    const originals = [item.message?.mes, item.message?.extra?.display_text, item.screenText];
    if (typeof item.editedText === 'string' && !originals.includes(item.editedText)) versions.push({ key: 'edited', label: '수정본', text: item.editedText });
    const translated = item.message?.extra?.display_text;
    if (typeof translated === 'string' && translated.trim() && translated !== item.message.mes) versions.push({ key: 'translation', label: '번역·표시문', text: translated });
    // Older captures used innerText, which omits the body of closed <details>.
    // Prefer the intact original for those records without rewriting saved data.
    const legacyDetails = /<details\b/i.test(String(item.message?.mes ?? '')) && item.screenTextComplete !== true;
    const screen = item.screenText?.trim() && !versions.some(v => v.text === item.screenText)
        ? { key:'screen', label:'보관 당시 화면', text:item.screenText } : null;
    if (screen && !legacyDetails) versions.push(screen);
    versions.push({ key: 'original', label: '원문', text: String(item.message?.mes ?? '') });
    if (screen && legacyDetails) versions.push(screen);
    return versions;
}

export function editPlan(chat, drawer, itemId, title, editedText, idFactory) {
    if (!drawer.items.some(item => item.id === itemId)) throw new Error('보관 항목이 변경되었습니다. 다시 열어주세요.');
    return { chat: chat.slice(), drawer: { ...drawer, revision: idFactory(), items: drawer.items.map(item => item.id === itemId
        ? { ...item, title: String(title).trim().slice(0, 160), ...(editedText === undefined ? {} : { editedText: String(editedText), editedAt: Date.now() }) } : item) } };
}
