export const KEY = 'sideleaf_v1';
export const PAGE_SIZE = 30;

export function readDrawer(metadata) {
    const data = metadata?.[KEY];
    if (data === undefined) return { version: 1, revision: '', items: [] };
    if (data.version !== 1 || !Array.isArray(data.items)) throw new Error('지원하지 않는 서랍 데이터입니다. 원본은 변경하지 않았습니다.');
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
    }));
    return {
        chat: chat.filter((_, i) => !picked.has(i)),
        drawer: { ...drawer, revision: idFactory(), items: [...drawer.items, ...added] },
        affected: added,
    };
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
