export const KEY = 'sideleaf_v1';
export const PAGE_SIZE = 30;

export function readDrawer(metadata) {
    const data = metadata?.[KEY];
    if (data === undefined) return { version: 1, revision: '', items: [] };
    if (!data || data.version !== 1 || !Array.isArray(data.items)) throw new Error('지원하지 않는 별지 데이터입니다. 원본은 변경하지 않았습니다.');
    // Imported or hand-edited files must not push an empty message back into the chat on restore.
    if (data.items.some(item => typeof item?.id !== 'string' || !item.message || typeof item.message !== 'object')) {
        throw new Error('별지 항목 일부가 손상되어 열지 않았습니다. 원본은 변경하지 않았습니다.');
    }
    return data;
}

export function itemTitle(item, text, limit = 80) {
    return item.title || preview({ mes: text }, limit);
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
    // Stable chronological order: archive time first, then original array position.
    const chronological = drawer.items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => (a.item.archivedAt - b.item.archivedAt) || a.index - b.index)
        .map(entry => entry.item);
    if (mode === 'asc') return chronological;
    if (mode !== 'manual' || !Array.isArray(drawer.order)) return chronological.reverse();
    // Manual order: unknown/duplicate ids are skipped; items added later come first, newest on top.
    const byId = new Map(drawer.items.map(item => [item.id, item]));
    const seen = new Set();
    const saved = [];
    for (const key of drawer.order) {
        if (!byId.has(key) || seen.has(key)) continue;
        seen.add(key);
        saved.push(byId.get(key));
    }
    return [...chronological.reverse().filter(item => !seen.has(item.id)), ...saved];
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

// A readable one-line excerpt: code blocks, tags and markdown markers are dropped.
export function preview(message, limit = 160) {
    const text = String(message?.mes ?? '').slice(0, limit * 12)
        .replace(/```[\s\S]*?(?:```|$)/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/^[ \t]*(?:#{1,6}|>|[-*+])[ \t]+/gm, '')
        .replace(/[*_~`]+/g, '')
        .replace(/\s+/g, ' ').trim();
    return text.slice(0, limit) || '(본문 없는 메시지)';
}

export function readingVersions(item) {
    const versions = [];
    // Versions changed in 별지 carry a "(수정)" mark so the edit stays visible.
    const label = (key, text) => item.editedKeys?.includes(key) ? `${text}(수정)` : text;
    const originals = [item.message?.mes, item.message?.extra?.display_text, item.screenText];
    // Reading copies from earlier releases stay readable; new edits change the version itself.
    if (typeof item.editedText === 'string' && !originals.includes(item.editedText)) versions.push({ key: 'edited', label: '수정본', text: item.editedText });
    const translated = item.message?.extra?.display_text;
    if (typeof translated === 'string' && translated.trim() && translated !== item.message.mes) versions.push({ key: 'translation', label: label('translation', '번역·표시문'), text: translated });
    // The original is rendered like the chat (formatting, regex screens), so it leads; the plain-text
    // screen capture stays available for display-only changes such as on-screen translations.
    versions.push({ key: 'original', label: label('original', '원문'), text: String(item.message?.mes ?? '') });
    if (item.screenText?.trim() && !versions.some(v => v.text === item.screenText)) versions.push({ key:'screen', label:label('screen', '보관 당시 화면'), text:item.screenText });
    return versions;
}

// `change` replaces the version being read ({key, text}); without it only the title changes.
// Editing the original rewrites the archived message itself, so a restore brings the edit back.
export function editPlan(chat, drawer, itemId, title, change, idFactory, now = Date.now()) {
    if (!drawer.items.some(item => item.id === itemId)) throw new Error('보관 항목이 변경되었습니다. 다시 열어주세요.');
    const update = item => {
        const next = { ...item, title: String(title).trim().slice(0, 160) };
        if (!change) return next;
        const text = String(change.text);
        if (change.key === 'original' || change.key === 'translation') {
            // A new message object, so the archive stores a new payload and earlier saves stay intact.
            const message = structuredClone(item.message);
            if (change.key === 'original') {
                message.mes = text;
                // Keep the selected swipe in step with the message text, as SillyTavern does.
                if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id) && message.swipe_id in message.swipes) message.swipes[message.swipe_id] = text;
            } else message.extra = { ...message.extra, display_text: text };
            next.message = message;
        } else if (change.key === 'screen') {
            Object.assign(next, { screenText: text, screenTextComplete: true });
        } else if (change.key === 'edited') {
            next.editedText = text;
        } else throw new Error('수정할 본문을 다시 골라주세요.');
        return { ...next, editedAt: now, editedKeys: [...new Set([...(item.editedKeys || []), change.key])] };
    };
    const items = drawer.items.map(item => item.id === itemId ? update(item) : item);
    return { chat: chat.slice(), drawer: { ...drawer, revision: idFactory(), items } };
}

export function deletePlan(chat, drawer, ids, idFactory) {
    const picked = new Set(ids);
    const items = drawer.items.filter(item => !picked.has(item.id));
    if (!picked.size || drawer.items.length - items.length !== picked.size) throw new Error('보관 항목이 바뀌었습니다. 다시 선택해주세요.');
    const next = { ...drawer, revision: idFactory(), items };
    if (Array.isArray(drawer.order)) next.order = drawer.order.filter(key => !picked.has(key));
    return { chat: chat.slice(), drawer: next, affected: drawer.items.filter(item => picked.has(item.id)) };
}
