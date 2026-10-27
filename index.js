import { KEY, PAGE_SIZE, readDrawer, itemTitle, archivePlan, restorePlan, chatIdentity, preview, readingVersions, editPlan, deletePlan, orderedItems, reorderPlan, folderPlan, folderOf } from './model.js';
import { icon } from './icons.js';
import { installQrSource } from './qr-source.js';
import { readableText, fullDetailsText } from './reading-text.js';
import { ArchiveFiles, portableChat } from './archive-files.js';

const context = () => SillyTavern.getContext();
// Older SillyTavern builds may not export isGenerating; a failed static import would stop the whole
// extension from loading. The core module is still loading while extensions load, so it must not be
// awaited here (that deadlocks startup); until it resolves, the visible Stop button is the signal.
let coreIsGenerating = null;
import('../../../../script.js').then(core => { if (typeof core.isGenerating === 'function') coreIsGenerating = core.isGenerating; }, () => {});
const isGenerating = () => {
    if (coreIsGenerating) return coreIsGenerating();
    const stop = document.getElementById('mes_stop');
    return Boolean(stop && getComputedStyle(stop).display !== 'none');
};
// Everything 별지 needs from the host. If any is missing, it stays read-only and touches no data.
const REQUIRED = ['saveChat', 'getRequestHeaders', 'printMessages', 'eventSource', 'eventTypes'];
const missingFeatures = () => REQUIRED.filter(name => !context()?.[name]);
let dialog;
let busy = false;
let view = 'archive';
let page = 0;
let openedChat = null;
let selected = new Set();
let snapshot = [];
let search = '';
let searchTimer;
let pending = null;
let editing = null;
let reader = false;
let composing = false;
let expanded = new Set();
let editMode = false;
let sortMode = 'desc';
let folderView = 'all'; // folder chip: 'all', '' (no folder) or a folder id
let readerKey = null;
let readerItems = [];
let readerReturn = null;
let readerRevision = null;
let selectionUi = null;
const versionChoice = new Map();
const id = () => context().uuidv4?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

const files = new ArchiveFiles({headers:()=>context().getRequestHeaders(), uuid:id});
let loaded = null, loading = null, loadError = null, loadEpoch = 0;
const storageKey = ctx => JSON.stringify([chatIdentity(ctx), ctx.chatMetadata?.[KEY]]);
function clearArchiveCache() {
    loadEpoch++; loaded = null; loading = null; loadError = null; files.clear();
}
function currentDrawer(ctx = context()) {
    if (ctx.chatMetadata?.[KEY]?.version !== 2) return readDrawer(ctx.chatMetadata);
    if (loaded?.key === storageKey(ctx)) return loaded.drawer;
    throw new Error('보관함을 불러오는 중입니다.');
}
async function ensureArchive(ctx = context()) {
    if (ctx.chatMetadata?.[KEY]?.version !== 2) return readDrawer(ctx.chatMetadata);
    const key = storageKey(ctx);
    if (loaded?.key === key) return loaded.drawer;
    if (loading?.key === key) return loading.promise;
    const epoch = ++loadEpoch;
    loadError = null;
    const promise = files.load(ctx.chatMetadata).then(drawer => {
        if (epoch !== loadEpoch || key !== storageKey(context())) throw new Error('채팅이 바뀌었습니다. 별지를 다시 열어주세요.');
        loaded = {key, drawer}; return drawer;
    }).catch(error => { if (epoch === loadEpoch) loadError = error; throw error; })
      .finally(() => { if (epoch === loadEpoch) loading = null; });
    loading = {key, promise}; return promise;
}
function downloadChat(data, name) {
    const url = URL.createObjectURL(new Blob([data.map(item=>JSON.stringify(item)).join('\n')], {type:'application/jsonl'}));
    // Detached links are ignored by some browsers; keep it inside the modal so the click is honoured.
    const link = document.createElement('a'); link.href = url; link.download = name; link.hidden = true;
    (dialog || document.body).append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
function backupName(ctx, suffix) {
    const base = String(ctx.chatId || 'chat').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 80) || 'chat';
    return `${base} - ${suffix}.jsonl`;
}
function exportArchive() {
    try {
        const ctx = assertReady();
        downloadChat(portableChat(ctx, currentDrawer(ctx)), backupName(ctx, 'sideleaf'));
        note('통합 백업 파일을 내려받았습니다. 다운로드 폴더를 확인해주세요.');
    } catch(error) { note(error.message,true); }
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
function button(text, action, className = '') {
    const node = el('button', `cd-button ${className}`.trim());
    node.type = 'button';
    if (text) node.append(el('span', '', text));
    node.addEventListener('click', action);
    return node;
}
// Icon-only buttons get an accessible name; labelled ones keep their visible text.
function iconButton(name, label, action, text = '') {
    const node = button(text, action, text ? 'cd-labelled' : 'cd-icon-button'); node.prepend(icon(name));
    node.title = label; if (!text) node.setAttribute('aria-label', label); return node;
}
// The native select lies invisibly over the whole pill, so a tap anywhere on it opens the list even when
// a narrow row squeezes the label; the chosen option is shown as plain text. `compact` shows the icon only.
function selectControl(iconName, label, options, value, onChange, className = '', compact = false) {
    const wrap = el('label', `cd-select ${compact ? 'cd-select-compact ' : ''}${className}`.trim()); wrap.title = label;
    const select = el('select'); select.setAttribute('aria-label', label);
    for (const [key, text] of options) { const option = el('option', '', text); option.value = key; select.append(option); }
    select.value = value;
    const shown = el('span', 'cd-select-text');
    const sync = () => { shown.textContent = select.selectedOptions[0]?.textContent ?? ''; };
    select.addEventListener('change', () => { sync(); onChange(select.value); });
    sync();
    wrap.append(icon(iconName));
    if (!compact) wrap.append(shown, icon('down'));
    wrap.append(select);
    return wrap;
}
function setSort(value) {
    sortMode = value; context().accountStorage?.setItem('sideleaf.sort', value); page = 0; render();
}
function archiveItems() {
    return orderedItems(currentDrawer(), sortMode).map(item => ({...item,key:item.id,index:item.originalIndex}));
}
// The archive as the selected folder chip shows it.
function shownItems() {
    const drawer = currentDrawer(), all = archiveItems();
    if (folderView === 'all') return all;
    if (folderView && !drawer.folders?.some(folder => folder.id === folderView)) { folderView = 'all'; return all; }
    return all.filter(item => folderOf(drawer, item) === folderView);
}
function matchesQuery(item, raw) {
    const query = raw.trim().toLocaleLowerCase();
    return !query || [item.title, item.message.name, ...readingVersions(item).map(v=>v.text)].some(text => typeof text === 'string' && text.toLocaleLowerCase().includes(query));
}
const matchesSearch = item => matchesQuery(item, search);
const isLocked = () => busy || Boolean(pending);
// Selections are message indexes, so any chat change since the list was drawn invalidates them.
const chatChanged = ctx => snapshot.length !== ctx.chat.length || snapshot.some((message, i) => message !== ctx.chat[i]);
function statusLine(text = '') {
    const node = el('p', 'cd-status', text); node.setAttribute('role', 'status'); return node;
}
// `text` is plain (search, titles, copy, editing); `raw` keeps the markup for chat-style rendering.
// Parsing <details> markup is the costly part, so results are cached per message until a source changes.
const versionCache = new WeakMap();
function versionsOf(item) {
    const message = item.message;
    const sources = [message?.mes, message?.extra?.display_text, item.screenText, item.screenTextComplete, item.editedText];
    const cached = message && typeof message === 'object' ? versionCache.get(message) : null;
    if (cached && cached.sources.every((value, i) => value === sources[i])) return cached.versions;
    const versions = readingVersions(item).map(version => ({...version, raw:version.text, text:fullDetailsText(version.text)}));
    if (message && typeof message === 'object') versionCache.set(message, {sources, versions});
    return versions;
}
function chosenVersion(item, versions) {
    return versions.find(v => v.key === versionChoice.get(item.key)) || versions[0];
}
function speaker(message) {
    return message.name || (message.is_user ? '사용자' : 'AI');
}
function note(text, error = false) {
    const node = dialog?.querySelector('.cd-status');
    if (node) { node.textContent = text; node.dataset.error = String(error); }
    else if (error) globalThis.toastr?.error(text, '별지');
    else globalThis.toastr?.success(text, '별지');
}
function assertReady() {
    const ctx = context();
    if (!chatIdentity(ctx) || chatIdentity(ctx) !== openedChat) throw new Error('저장된 채팅을 열고 별지를 다시 열어주세요.');
    if (isGenerating() || ctx.streamingProcessor && !ctx.streamingProcessor.isFinished) throw new Error('응답 생성이 끝난 뒤 다시 시도해주세요.');
    if (document.querySelector('#chat .mes_edit_textarea, #chat #curEditTextarea')) throw new Error('메시지 편집을 마친 뒤 다시 시도해주세요.');
    return ctx;
}
// Editor screens stay on screen while saving so a failed save never loses typed text.
function lockForm(locked) {
    dialog?.querySelectorAll('button, input, textarea, select').forEach(node => { node.disabled = locked; });
}

// The core save wrapper may swallow network errors. Read back the file before
// declaring success; never reload a chat after an unverified save.
async function verifySave(ctx, revision) {
    const isGroup = ctx.groupId != null;
    const character = ctx.characters?.[ctx.characterId];
    const response = await fetch(isGroup ? '/api/chats/group/get' : '/api/chats/get', {
        method: 'POST', headers: ctx.getRequestHeaders(), cache: 'no-store', signal: AbortSignal.timeout(15000),
        body: JSON.stringify(isGroup ? { id: ctx.chatId } : {
            ch_name: character.name, avatar_url: character.avatar, file_name: ctx.chatId,
        }),
    });
    if (!response.ok) throw new Error('서버 저장 확인에 실패했습니다.');
    const saved = await response.json();
    if (!Array.isArray(saved) || saved[0]?.chat_metadata?.[KEY]?.revision !== revision) {
        throw new Error('서버에서 저장 완료를 확인하지 못했습니다.');
    }
}

async function refreshChat() {
    // Only rebuild message nodes; keep unrelated chat overlays and extension state.
    document.querySelectorAll('#chat > .mes, #chat > #show_more_messages').forEach(node => node.remove());
    await context().printMessages();
    addMessageButtons();
}

function makePlan(kind, chat, drawer, edit) {
    switch (kind) {
        case 'migrate': return { chat: chat.slice(), drawer: { ...drawer, revision: id() } };
        case 'order': return reorderPlan(chat, drawer, edit.order, id);
        case 'folder': return folderPlan(chat, drawer, edit, id);
        case 'edit': return editPlan(chat, drawer, edit.id, edit.title, edit.change, id);
        case 'delete': return deletePlan(chat, drawer, edit?.ids ?? [...selected], id);
        case 'archive': return archivePlan(chat, drawer, [...selected], id);
        default: return restorePlan(chat, drawer, [...selected], id, edit?.place === 'original' ? 'original' : 'end');
    }
}

async function commit(kind, edit = null) {
    if (busy || pending) return;
    try {
        const ctx = assertReady();
        if (kind !== 'migrate' && !edit && !selected.size) return;
        busy = true;
        if (editing) lockForm(true); else render();
        note('별지 파일 저장 중…');
        const originalPointer = ctx.chatMetadata[KEY];
        const chatBefore = JSON.stringify(ctx.chat);
        const drawer = await ensureArchive(ctx);
        if (assertReady().chatMetadata !== ctx.chatMetadata) throw new Error('채팅이 바뀌었습니다.');
        if (view === 'select' && chatChanged(ctx)) {
            selected.clear(); throw new Error('대화가 변경되어 선택을 해제했습니다. 다시 골라주세요.');
        }
        const plan = makePlan(kind, ctx.chat, drawer, edit);
        if (kind === 'archive') for (const item of plan.affected) {
            const body = document.querySelector(`#chat .mes[mesid="${item.originalIndex}"] .mes_text`);
            const text = body ? readableText(body) : '';
            // Capture only the selected message body, never the surrounding chat/UI.
            if (text && !item.message.extra?.display_text && text !== String(item.message.mes).trim()) {
                item.screenText = text;
                item.screenTextComplete = true;
            }
        }
        const pointer = await files.save(plan.drawer);
        if (assertReady().chatMetadata !== ctx.chatMetadata || ctx.chatMetadata[KEY] !== originalPointer || JSON.stringify(ctx.chat) !== chatBefore) {
            throw new Error('저장 중 대화가 변경되었습니다. 채팅을 덮어쓰지 않았습니다. 다시 시도해주세요.');
        }
        pending = { ctx, kind, revision: plan.drawer.revision, identity: openedChat,
            recovery: [{ user_name: ctx.name1, character_name: ctx.name2,
                chat_metadata: structuredClone({ ...ctx.chatMetadata, [KEY]: plan.drawer }) }, ...structuredClone(plan.chat)] };
        ctx.chatMetadata[KEY] = pointer;
        loaded = {key:storageKey(ctx),drawer:plan.drawer};
        ctx.chatMetadata.tainted = true;
        ctx.chat.length = 0;
        for (const message of plan.chat) ctx.chat.push(message);
        selected.clear();
        editing = null;
        render();
        await finishSave();
    } catch (error) {
        busy = false;
        // The chat was switched mid-save: nothing was written to it, and this dialog belongs to the old chat.
        if (dialog && !pending && openedChat !== chatIdentity(context())) {
            console.error('[Sideleaf]', error);
            close(true);
            globalThis.toastr?.warning('채팅이 바뀌어 별지 작업을 중단했습니다. 원래 채팅은 변경되지 않았습니다.', '별지');
            return;
        }
        if (editing && dialog && !pending) { lockForm(false); note(error.message, true); }
        else {
            editing = null;
            if (pending && !dialog) open();
            render(); note(error.message, true);
        }
        if (!pending && !dialog) clearArchiveCache();
        console.error('[Sideleaf]', error);
    } finally {
        // The message-menu path borrows the selection state; release the chat snapshot afterwards.
        if (!dialog && !pending) { snapshot = []; view = 'archive'; selected.clear(); }
    }
}

const SAVED_NOTES = {
    migrate: '분리 저장으로 전환했습니다. 다른 서버로 옮길 때는 통합 백업을 사용해주세요.',
    archive: '별지에 보관했습니다.',
    restore: '대화로 복원했습니다.',
    edit: '변경 사항을 저장했습니다.',
    order: '변경 사항을 저장했습니다.',
    folder: '폴더를 정리했습니다.',
    delete: '별지에서 삭제했습니다.',
};

async function finishSave() {
    const operation = pending;
    if (!operation) return;
    if (chatIdentity(context()) !== operation.identity || context().chatMetadata !== operation.ctx.chatMetadata) {
        throw new Error('채팅이 바뀌어 저장을 중단했습니다. 원래 채팅을 확인해주세요.');
    }
    busy = true; render(); note('채팅 저장 확인 중…');
    await operation.ctx.saveChat();
    await verifySave(operation.ctx, operation.revision);
    if (chatIdentity(context()) !== operation.identity) throw new Error('채팅이 바뀌었습니다. 저장한 채팅을 다시 열어 확인해주세요.');
    pending = null;
    // The save is verified from here on; a failure to redraw must not be reported as a failed save.
    let redrawFailed = false;
    try {
        if (['archive','restore'].includes(operation.kind)) await refreshChat();
        if (operation.kind === 'archive') await context().eventSource.emit(context().eventTypes.MESSAGE_DELETED, context().chat.length);
        await context().eventSource.emit('sideleaf:changed', { kind: operation.kind, chatId: context().chatId });
    } catch (error) {
        redrawFailed = true;
        console.warn('[Sideleaf] Saved, but refreshing the chat view failed', error);
    } finally {
        busy = false;
        if (!['edit', 'order', 'folder'].includes(operation.kind)) page = 0;
        view = 'archive';
        if (operation.kind === 'order') { sortMode = 'manual'; context().accountStorage?.setItem('sideleaf.sort', sortMode); }
        const target = readerReturn && archiveItems().find(x => x.key === readerReturn);
        readerReturn = null;
        if (target) showReader(target); else render();
    }
    if (!dialog) clearArchiveCache();
    note(SAVED_NOTES[operation.kind] + (redrawFailed ? ' 채팅 화면이 바로 바뀌지 않으면 채팅을 다시 열어주세요.' : ''));
}

function close(discardEdit = false) {
    if (busy || pending) { note('저장을 확인한 뒤 닫아주세요.', true); return; }
    if (editing && !discardEdit) { note('편집을 저장하거나 취소한 뒤 닫아주세요.', true); return; }
    clearTimeout(searchTimer);
    dialog?.close(); dialog?.remove(); dialog = null;
    if (mirror) mirror.style.disabled = true;
    clearArchiveCache();
    snapshot = []; selected.clear(); search = ''; editing = null; selectionUi = null;
    reader = false; expanded.clear(); composing = false; versionChoice.clear();
    editMode = false; readerKey = null; readerItems = []; readerReturn = null; readerRevision = null; folderView = 'all';
}

function downloadRecovery() {
    if (!pending) return;
    downloadChat(pending.recovery, backupName(pending.ctx, 'sideleaf-recovery'));
}

function onCancel(event) {
    event.preventDefault();
    if (!dialog) return;
    const jump = dialog.querySelector('.cd-jump');
    if (jump) { jump.remove(); dialog.querySelector('.cd-shade')?.remove(); return; }
    if (reader && !busy) { exitReader(); return; }
    if (editing === 'settings') { editing = null; render(); return; }
    close();
}

function open() {
    if (dialog?.open) { dialog.focus(); return; }
    const missing = missingFeatures();
    if (missing.length) {
        globalThis.toastr?.warning(`이 SillyTavern 버전에는 별지에 필요한 기능(${missing.join(', ')})이 없어 열지 않았습니다. 데이터는 변경하지 않았습니다.`, '별지');
        return;
    }
    openedChat = chatIdentity(context());
    view = 'archive'; page = 0; selected.clear(); search = ''; editMode = false; folderView = 'all';
    sortMode = context().accountStorage?.getItem('sideleaf.sort') || sortMode;
    const appearance = chatAppearance(), styles = measureChatStyles();
    dialog = el('dialog');
    dialog.id = 'sideleaf-dialog';
    dialog.setAttribute('aria-label', '별지');
    dialog.addEventListener('cancel', onCancel);
    for (const [name, value] of Object.entries(appearance)) dialog.style.setProperty(name, value);
    applyChatStyles(styles);
    document.body.append(dialog);
    render(); dialog.showModal();
}

function header(ctx, drawer, locked) {
    const bar = el('header', 'cd-header');
    const brand = el('div', 'cd-brand'); brand.append(icon('star'));
    const names = el('div', 'cd-brand-text');
    const chatName = el('span', 'cd-subtitle', ctx.chatId ? String(ctx.chatId) : '저장된 채팅을 먼저 열어주세요.'); chatName.title = chatName.textContent;
    names.append(el('h2', '', '별지'), chatName); brand.append(names);
    const actions = el('div', 'cd-actions');
    if (drawer && view === 'archive' && drawer.items.length) {
        const toggle = iconButton(editMode ? 'check' : 'edit', editMode ? '편집 끝내기' : '여러 개 골라 복원·삭제·폴더 이동·순서 변경', () => { editMode = !editMode; selected.clear(); render(); }, editMode ? '완료' : '편집');
        toggle.classList.toggle('cd-primary', editMode); toggle.disabled = locked; toggle.setAttribute('aria-pressed', String(editMode));
        actions.append(toggle);
    }
    if (drawer) {
        const gear = iconButton('settings', '설정 · 백업', settingsScreen); gear.disabled = locked;
        actions.append(gear);
    }
    const dismiss = iconButton('close', '닫기 (Esc)', () => close()); dismiss.disabled = locked;
    actions.append(dismiss); bar.append(brand, actions);
    return bar;
}

function render() {
    if (!dialog || editing || reader || (composing && !busy)) return;
    dialog.classList.remove('cd-reading');
    selectionUi = null;
    const ctx = context();
    const generating = isGenerating();
    const locked = isLocked();
    let drawer;
    try { drawer = currentDrawer(ctx); } catch (error) {
        const box = el('div', 'cd-loading');
        if (ctx.chatMetadata?.[KEY]?.version === 2) {
            if (!loadError) box.append(el('span', 'cd-spinner'));
            box.append(el('p', '', loadError?.message || '보관함을 불러오는 중…'));
            if (loadError) box.append(button('다시 불러오기', () => { loadError = null; render(); }, 'cd-primary'));
            if (!loading && !loadError) ensureArchive(ctx).then(() => render(), () => render());
        } else box.append(el('p', '', error.message));
        dialog.replaceChildren(header(ctx, null, false), box);
        return;
    }
    if (view === 'archive' && !drawer.items.length) editMode = false;
    const selecting = view === 'select' || editMode;

    const controls = el('div', 'cd-controls');
    const tabs = el('nav', 'cd-tabs'); tabs.setAttribute('aria-label', '별지 보기');
    for (const [key, label, count] of [['archive', '보관함', drawer.items.length], ['select', '메시지 보관하기', null]]) {
        const tab = button(label, () => { if (view === key) return; view = key; page = 0; search = ''; editMode = false; selected.clear(); expanded.clear(); render(); }, 'cd-tab');
        tab.prepend(icon(key === 'archive' ? 'star' : 'all'));
        if (count !== null) tab.append(el('span', 'cd-count', String(count)));
        tab.setAttribute('aria-pressed', String(view === key)); tab.disabled = locked;
        tabs.append(tab);
    }
    const toolbar = el('div', 'cd-toolbar');
    const field = el('label', 'cd-search-field'); field.append(icon('search'));
    const input = el('input', 'cd-search'); input.type = 'search'; input.value = search; input.disabled = locked;
    input.placeholder = view === 'archive' ? '제목·내용·이름으로 찾기' : '메시지 내용·이름으로 찾기'; input.setAttribute('aria-label', input.placeholder);
    const updateSearch = () => {
        clearTimeout(searchTimer);
        if (composing) return;
        searchTimer = setTimeout(() => {
            if (!dialog || editing || reader) return;
            search = input.value; page = 0; expanded.clear();
            const focused = document.activeElement === input;
            const start = input.selectionStart, end = input.selectionEnd;
            render();
            if (focused) { const next = dialog.querySelector('.cd-search'); next?.focus(); next?.setSelectionRange(start, end); }
        }, 250);
    };
    input.addEventListener('input', updateSearch);
    input.addEventListener('compositionstart', () => { composing = true; clearTimeout(searchTimer); });
    input.addEventListener('compositionend', () => { composing = false; updateSearch(); });
    field.append(input); toolbar.append(field);
    if (view === 'archive' && drawer.items.length > 1) {
        const sort = selectControl('sort', '정렬', [['desc','최신순'],['asc','오래된순'],['manual','직접 정한 순서']], sortMode, setSort, 'cd-sort');
        sort.querySelector('select').disabled = locked; toolbar.append(sort);
    }
    if (view === 'archive' && drawer.items.length && !drawer.folders?.length) {
        const add = iconButton('folder', '폴더 만들기 · 보관 항목을 폴더로 나눠 정리합니다', () => folderEditor(null, editMode ? [...selected] : []));
        add.disabled = locked; toolbar.append(add);
    }
    controls.append(tabs, toolbar);
    if (view === 'archive' && drawer.folders?.length) controls.append(folderBar(drawer, locked));

    if (view === 'select' && snapshot.length && chatChanged(ctx)) selected.clear();
    snapshot = ctx.chat.slice();
    const items = view === 'archive'
        ? shownItems()
        : ctx.chat.map((message, index) => ({ key: index, message, index })).reverse();
    const query = search.trim().toLocaleLowerCase();
    const filtered = query ? items.filter(matchesSearch) : items;

    let none = null;
    if (selecting) {
        const bulk = el('div', 'cd-bulkbar');
        const all = iconButton('all', '검색 결과의 모든 페이지를 선택', () => { filtered.forEach(item => selected.add(item.key)); render(); }, query ? `찾은 ${filtered.length}개 모두 선택` : '모두 선택');
        all.disabled = locked || !filtered.length;
        none = iconButton('clear', '선택 해제', () => { selected.clear(); render(); }, '선택 해제');
        bulk.append(all, none);
        controls.append(bulk);
        if (view === 'select') controls.append(el('p', 'cd-hint', '고른 메시지는 대화 화면과 이후 AI 대화 기록에서 빠지고 별지에 보관됩니다.'));
    }

    const list = el('div', 'cd-list'); list.setAttribute('aria-label', view === 'archive' ? '보관 메시지' : '보관할 메시지 고르기');
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    for (const item of filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) list.append(row(item));
    if (!filtered.length) {
        const empty = el('div', 'cd-empty'); empty.append(icon(query ? 'search' : 'star'));
        if (query) empty.append(el('p', '', '검색 결과가 없습니다.'));
        else if (view === 'archive') {
            empty.append(el('strong', '', '아직 보관한 메시지가 없어요'), el('p', '', '메시지 메뉴의 별 아이콘이나 아래 버튼으로 필요한 메시지만 옮겨두세요.'));
            const go = button('메시지 보관하기', () => { view = 'select'; page = 0; render(); }, 'cd-primary'); go.disabled = locked; empty.append(go);
        } else empty.append(el('p', '', '보관할 메시지가 없습니다.'));
        list.append(empty);
    }
    const parts = [header(ctx, drawer, locked), controls, list];
    if (pages > 1) {
        const pagination = el('div', 'cd-pagination');
        const previous = iconButton('left', '이전 페이지', () => { page--; render(); }); previous.disabled = page === 0 || locked;
        const next = iconButton('right', '다음 페이지', () => { page++; render(); }); next.disabled = page >= pages - 1 || locked;
        pagination.append(previous, el('span', 'cd-page-count', `${page + 1} / ${pages}`), next);
        parts.push(pagination);
    }
    const footer = el('footer', 'cd-footer');
    const status = statusLine(generating ? GENERATING_NOTE : '');
    if (pending && !busy) {
        footer.classList.add('cd-alert');
        footer.append(el('span', 'cd-selected', '저장을 확인하지 못했습니다'), el('span', 'cd-spacer'),
            iconButton('download', '복구 파일을 내려받고 창을 닫습니다', async () => {
                downloadRecovery();
                const sameChat = chatIdentity(context()) === pending.identity;
                pending = null;
                close();
                if (sameChat) await refreshChat();
            }, '백업 후 닫기'),
            iconButton('restore', '채팅 저장을 다시 시도합니다', () => finishSave().catch(error => { busy = false; render(); note(error.message, true); }), '다시 저장'));
        footer.lastChild.classList.add('cd-primary');
        status.textContent = '현재 내용은 메모리에 유지됩니다. 연결을 확인한 뒤 다시 저장하거나, 복구 파일을 받아두세요.';
        status.dataset.error = 'true';
        parts.push(footer);
    } else if (selecting) {
        const count = el('span', 'cd-selected');
        const action = view === 'archive'
            ? iconButton('restore', '보관하기 전 자리에 다시 넣기 (그 사이 대화가 줄었으면 끝에)', () => commit('restore', {place:'original'}), '원래 자리로')
            : iconButton('star', '선택한 메시지를 대화에서 빼서 별지에 보관', () => commit('archive'), '별지에 보관');
        action.classList.add('cd-primary');
        const side = el('div', 'cd-footer-side'), main = el('div', 'cd-footer-main');
        side.append(count);
        let remove = null, toEnd = null, move = null;
        if (view === 'archive') {
            move = selectControl('folder', '고른 항목을 폴더로 옮기기', [['', '폴더로 옮기기…'], ...folderChoices(drawer), [NEW_FOLDER, '+ 새 폴더 만들기']], '', value => {
                if (value === NEW_FOLDER) folderEditor(null, [...selected]);
                else commit('folder', {type:'move', ids:[...selected], folder:value === NO_FOLDER ? '' : value});
            }, 'cd-move', true);
            remove = iconButton('trash', '선택한 항목을 별지에서 삭제');
            remove.addEventListener('click', () => removeItems([...selected]));
            remove.classList.add('cd-danger');
            side.append(el('span', 'cd-spacer'), move, remove);
            toEnd = iconButton('append', '선택한 메시지를 현재 대화 맨 끝에 붙이기', () => commit('restore', {place:'end'}), '채팅 끝에');
            main.append(toEnd);
        }
        main.append(action);
        footer.classList.add(view === 'archive' ? 'cd-footer-edit' : 'cd-footer-select');
        footer.append(side, main);
        selectionUi = { count, action, toEnd, remove, move, none, generating };
        parts.push(footer);
    }
    parts.push(status);
    dialog.replaceChildren(...parts);
    updateSelection();
}

const GENERATING_NOTE = '응답 생성 중에는 보관·복원을 잠시 멈춥니다.';
function refreshGenerationState() {
    if (!dialog || editing || reader || busy || pending) return;
    const generating = isGenerating();
    if (selectionUi) { selectionUi.generating = generating; updateSelection(); }
    dialog.querySelectorAll('.cd-migrate').forEach(node => { node.disabled = generating; });
    const status = dialog.querySelector('.cd-status');
    // Leave other messages (saved, errors) alone; only toggle the generation notice itself.
    if (status && (!status.textContent || status.textContent === GENERATING_NOTE)) { status.textContent = generating ? GENERATING_NOTE : ''; status.dataset.error = 'false'; }
}

function updateSelection() {
    if (!selectionUi) return;
    const locked = isLocked();
    selectionUi.count.textContent = selected.size ? `${selected.size}개 선택됨` : '항목을 골라주세요';
    selectionUi.action.disabled = !selected.size || locked || !openedChat || selectionUi.generating;
    if (selectionUi.toEnd) selectionUi.toEnd.disabled = selectionUi.action.disabled;
    if (selectionUi.none) selectionUi.none.disabled = !selected.size || locked;
    if (selectionUi.remove) selectionUi.remove.disabled = !selected.size || locked;
    if (selectionUi.move) selectionUi.move.querySelector('select').disabled = !selected.size || locked;
}

// Archived bodies are formatted like the chat (markdown, quotes, regex display scripts),
// then everything that could run code, embed frames or submit forms is dropped. Message <style>
// blocks stay but are rewritten to apply only inside the reading box (see scopeStyles).
const BLOCKED_TAGS = ['script', 'link', 'meta', 'base', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'option', 'template', 'noscript', 'audio', 'video', 'source', 'track', 'canvas'];
const STYLE_SCOPE = '#sideleaf-dialog .cd-rich';
// SillyTavern scopes message CSS to `.mes_text`; the same rules are re-scoped to 별지's box so they
// style archived content exactly as in the chat without reaching the page, the chat or the theme.
function scopeRule(rule) {
    if (rule instanceof CSSStyleRule) {
        const selectors = rule.selectorText.split(/,(?![^(]*\))/).map(part => {
            const rest = part.trim().replace(/^\.mes_text\b\s*/, '').replace(/^(?:html|body|:root)\b\s*/, '');
            return rest ? `${STYLE_SCOPE} ${rest}` : STYLE_SCOPE;
        });
        return `${selectors.join(', ')} { ${rule.style.cssText} }`;
    }
    if (rule instanceof CSSMediaRule) return `@media ${rule.conditionText} { ${[...rule.cssRules].map(scopeRule).join(' ')} }`;
    if (rule instanceof CSSSupportsRule) return `@supports ${rule.conditionText} { ${[...rule.cssRules].map(scopeRule).join(' ')} }`;
    if (rule instanceof CSSKeyframesRule || rule instanceof CSSFontFaceRule) return rule.cssText;
    return ''; // @import, @page and anything unknown are dropped
}
function scopeStyles(box) {
    for (const style of box.querySelectorAll('style')) {
        try {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(style.textContent);
            style.textContent = [...sheet.cssRules].map(scopeRule).join('\n');
        } catch {
            style.remove();
        }
    }
}
// Attributes that could point at page controls behind the dialog are dropped as well.
const BLOCKED_ATTRS = ['id', 'name', 'for', 'form', 'formaction', 'srcdoc', 'popovertarget', 'popovertargetaction'];
function contentBlock(item, version) {
    // The screen capture is already-rendered text; formatting it again would re-run markdown and regex scripts.
    if (version.key === 'screen') return textBlock(version.text, item.message);
    const ctx = context(), purify = globalThis.SillyTavern?.libs?.DOMPurify;
    if (typeof ctx.messageFormatting !== 'function' || typeof purify?.sanitize !== 'function') return textBlock(version.text, item.message);
    let fragment;
    try {
        const message = item.message;
        const html = ctx.messageFormatting(version.raw, message.name ?? '', Boolean(message.is_system), Boolean(message.is_user), undefined);
        // FORCE_BODY keeps a leading <style> block (the parser would otherwise hoist and drop it).
        fragment = purify.sanitize(html, { RETURN_DOM_FRAGMENT: true, FORCE_BODY: true, FORBID_TAGS: BLOCKED_TAGS, FORBID_ATTR: BLOCKED_ATTRS });
    } catch (error) {
        console.warn('[Sideleaf] Falling back to plain text', error);
        return textBlock(version.text, item.message);
    }
    // Folded sections open up front so the whole body reads without extra clicks.
    fragment.querySelectorAll('details').forEach(node => { node.open = true; });
    // Links open in a new tab so the SillyTavern page (and any unsaved state) stays put.
    fragment.querySelectorAll('a[href]').forEach(link => { link.target = '_blank'; link.rel = 'noopener noreferrer'; });
    const box = el('div', 'cd-rich');
    box.append(fragment);
    scopeStyles(box);
    // Status windows from regex scripts arrive as HTML code blocks; show them as screens, not source.
    // Frames are built only after the sanitised nodes belong to this document: a frame adopted from
    // DOMPurify's working document never runs its size script.
    box.querySelectorAll('pre > code').forEach(code => {
        if (FRONTEND.test(code.textContent)) code.parentElement.replaceWith(framedHtml(code.textContent));
    });
    return mirrored(box, item.message);
}

const FRONTEND = /<\s*(?:!doctype|html|head|body|style|div|section|article|table|span|img|p)\b/i;
// Status windows often fill in their values with a small script, so scripts may run, but only inside
// an isolated frame: no allow-same-origin (an opaque origin with no access to SillyTavern, its storage
// or cookies), no top navigation, popups or forms, and a CSP that blocks every network request and
// external script. The frame reports only its own height back to 별지.
const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' *; img-src * data: blob:; font-src * data:; media-src * data: blob:";
const FRAME_HEAD = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><style>html,body{margin:0}</style>`;
// Reports at fixed moments as well as on changes: a single early report can be lost while the frame starts up.
// The height is the bottom of what is actually visible, not scrollHeight, which never drops below the frame's
// current height and so would keep the space of a section folded again. Content cut off by a folded
// (overflow-clipped) box does not count.
const FRAME_SIZE = `<script>(function(){var t;function walk(node,clip,depth,state){for(var c=node.firstElementChild;c&&state.n<4000;c=c.nextElementSibling){state.n++;var s=getComputedStyle(c);if(s.display==='none')continue;var r=c.getBoundingClientRect();if(s.display!=='contents'&&(r.width||r.height)&&s.visibility!=='hidden'){var m=s.position==='absolute'||s.position==='fixed'?0:parseFloat(s.marginBottom)||0;state.bottom=Math.max(state.bottom,Math.min(r.bottom+m,clip));}var o=s.overflowY;var inner=s.display!=='contents'&&o!=='visible'?Math.min(clip,r.bottom):clip;if(depth<60&&r.top<inner)walk(c,inner,depth+1,state);}}function measure(){var b=document.body;if(!b)return 0;var state={bottom:0,n:0};walk(b,Infinity,0,state);var s=getComputedStyle(b);var bottom=state.bottom?state.bottom+scrollY+parseFloat(s.paddingBottom)+parseFloat(s.borderBottomWidth):0;return Math.ceil(bottom||b.scrollHeight);}function send(){clearTimeout(t);parent.postMessage({sideleafFrameHeight:measure()},'*');}function soon(){clearTimeout(t);t=setTimeout(send,30);}addEventListener('DOMContentLoaded',send);addEventListener('load',function(){send();setTimeout(send,300);setTimeout(send,1000);});addEventListener('toggle',soon,true);addEventListener('click',function(){soon();setTimeout(send,400);},true);addEventListener('transitionend',soon,true);if(window.ResizeObserver){var o=new ResizeObserver(soon);o.observe(document.documentElement);if(document.body)o.observe(document.body);}if(window.MutationObserver)new MutationObserver(soon).observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});})();<\/script>`;
const frames = new WeakMap();
addEventListener('message', event => {
    const height = event.data?.sideleafFrameHeight;
    if (typeof height !== 'number' || !event.source) return;
    for (const frame of document.querySelectorAll('#sideleaf-dialog .cd-frame')) {
        if (frame.contentWindow !== event.source || !frames.has(frame)) continue;
        const next = `${Math.min(Math.max(height, 16), 4000)}px`;
        if (frame.style.height !== next) frame.style.height = next;
    }
});
function framedHtml(html) {
    const frame = el('iframe', 'cd-frame');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = '정규식 화면 (분리된 영역에서 표시)';
    // The frame starts tiny so documents styled with height:100% measure their content, not the frame.
    frame.style.height = '1px';
    frame.srcdoc = frameDocument(html);
    frames.set(frame, true);
    return frame;
}
// The policy goes into <head> ahead of any script, and the document keeps its own doctype (standards mode).
// Meta refresh is dropped: a navigated frame would leave the policy behind.
function frameDocument(html) {
    const source = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '');
    if (/<head\b[^>]*>/i.test(source)) return source.replace(/<head\b[^>]*>/i, tag => tag + FRAME_HEAD) + FRAME_SIZE;
    if (/<html\b[^>]*>/i.test(source)) return source.replace(/<html\b[^>]*>/i, tag => `${tag}<head>${FRAME_HEAD}</head>`) + FRAME_SIZE;
    return `<!doctype html><head>${FRAME_HEAD}</head>${source}${FRAME_SIZE}`;
}

// Archived bodies sit in the same nesting as a chat message (chat > message > block > text), under
// 별지's own class names, with the message's speaker attributes. Every page rule written for chat
// messages (SillyTavern's, the theme's, theme extensions') is copied with #chat/.mes/.mes_block/
// .mes_text renamed to these, so quotes, highlights, emphasis and code look exactly as in the chat,
// whatever theme is active and however its selectors are written. Nothing in the chat is touched.
const MIRROR_NAMES = [[/#chat(?![\w-])/g, '.cd-mirror'], [/\.mes_text(?![\w-])/g, '.cd-mtext'], [/\.mes_block(?![\w-])/g, '.cd-mblock'], [/\.mes(?![\w-])/g, '.cd-mes']];
const MIRROR_TOUCH = /#chat(?![\w-])|\.mes(?:_text|_block)?(?![\w-])/;
const MIRROR_FRAME = /\.cd-(?:mirror|mes|mblock)(?![\w-])/;
// Rules aimed at the text box itself bring its look (text, background, borders, padding, ornaments) but not
// its layout: size, position and overflow stay 별지's, so a theme cannot push the body out of its card.
const LAYOUT_PROP = /^(?:width|min-width|max-width|height|min-height|max-height|margin|display|position|top|right|bottom|left|inset|float|clear|flex|grid|order|align-self|justify-self|place-self|overflow|contain|transform|translate|rotate|scale|z-index|zoom|content-visibility|container|resize)/;
function mirrored(box, message) {
    const chat = el('div', 'cd-mirror'), mes = el('div', 'cd-mes'), block = el('div', 'cd-mblock');
    box.classList.add('cd-mtext');
    mes.setAttribute('is_user', String(Boolean(message?.is_user)));
    mes.setAttribute('is_system', String(Boolean(message?.is_system)));
    if (message?.name) mes.setAttribute('ch_name', String(message.name));
    block.append(box); mes.append(block); chat.append(mes);
    return chat;
}
// Top-level split of a selector list / compound chain, ignoring commas and spaces inside () and [].
function topLevel(text, separator) {
    const parts = []; let depth = 0, quote = '', start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
        if (c === '"' || c === '\'') quote = c;
        else if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth--;
        else if (!depth && separator.test(c)) { parts.push(text.slice(start, i)); start = i + 1; }
    }
    parts.push(text.slice(start));
    return parts;
}
function declarations(style, keep) {
    const out = [];
    for (let i = 0; i < style.length; i++) {
        const name = style[i], value = style.getPropertyValue(name);
        if (value && keep(name)) out.push(`${name}: ${value}${style.getPropertyPriority(name) ? ' !important' : ''}`);
    }
    return out.join('; ');
}
function mirrorStyle(selectorText, style) {
    if (!style?.length || !MIRROR_TOUCH.test(selectorText)) return [];
    const groups = { frame: [], text: [], inner: [] };
    for (const part of topLevel(selectorText, /,/)) {
        if (!MIRROR_TOUCH.test(part)) continue; // already applies inside 별지 as written
        const renamed = MIRROR_NAMES.reduce((text, [from, to]) => text.replace(from, to), part.trim());
        const subject = topLevel(renamed, /[\s>+~]/).filter(Boolean).pop() || '';
        // Pseudo-elements of the text box (ornaments, labels) come over whole.
        const box = subject.includes('.cd-mtext') && !subject.includes('::');
        groups[MIRROR_FRAME.test(subject) && !subject.includes('.cd-mtext') ? 'frame' : box ? 'text' : 'inner'].push(renamed);
    }
    const out = [];
    if (groups.inner.length) out.push(`${groups.inner.join(', ')} { ${style.cssText} }`);
    const text = groups.text.length && declarations(style, name => !LAYOUT_PROP.test(name));
    if (text) out.push(`${groups.text.join(', ')} { ${text} }`);
    // The message frames carry only variables, which the text inside inherits.
    const vars = groups.frame.length && declarations(style, name => name.startsWith('--'));
    if (vars) out.push(`${groups.frame.join(', ')} { ${vars} }`);
    return out;
}
// CSS nesting (`#chat { & .mes_text em { … } }`) is flattened into full selectors first.
function nestedSelector(parent, selectorText) {
    return topLevel(selectorText, /,/).map(part => part.includes('&') ? part.replaceAll('&', `:is(${parent})`) : `:is(${parent}) ${part.trim()}`).join(', ');
}
function mirrorRule(rule, parent = null) {
    if (rule instanceof CSSStyleRule) {
        const selector = parent ? nestedSelector(parent, rule.selectorText) : rule.selectorText;
        const out = mirrorStyle(selector, rule.style);
        for (const child of rule.cssRules || []) out.push(...[mirrorRule(child, selector)].flat());
        return out.filter(Boolean);
    }
    // Bare declarations inside a nested @media block belong to the enclosing selector.
    if (parent && rule.style && !rule.cssRules) return mirrorStyle(parent, rule.style);
    const inner = () => [...rule.cssRules].flatMap(child => mirrorRule(child, parent)).filter(Boolean).join('\n');
    if (rule instanceof CSSMediaRule) { const body = inner(); return body && `@media ${rule.conditionText} {\n${body}\n}`; }
    if (rule instanceof CSSSupportsRule) { const body = inner(); return body && `@supports ${rule.conditionText} {\n${body}\n}`; }
    if (globalThis.CSSLayerBlockRule && rule instanceof CSSLayerBlockRule) { const body = inner(); return body && `@layer ${rule.name} {\n${body}\n}`; }
    return [];
}
const OWN_STYLE = new URL('./style.css', import.meta.url).href;
const BASE_PROPS = ['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-shadow', 'text-align', 'text-indent', '-webkit-text-fill-color'];
// The page's sheets other than 별지's own and the <style> blocks inside chat messages (each archived
// body brings its own).
function pageSheets() {
    const sheets = [];
    for (const sheet of document.styleSheets) {
        if (sheet.href === OWN_STYLE || sheet.ownerNode?.closest?.('#chat, #sideleaf-dialog')) continue;
        try { sheets.push([sheet, sheet.cssRules]); } catch { /* cross-origin sheets cannot be read */ }
    }
    return sheets;
}
// The mirrored rules are kept between openings (switched off while 별지 is closed, so they cost the page
// nothing) and rebuilt only when the page's styles change, e.g. another theme.
let mirror = null;
// Reads only: everything is measured before 별지 adds anything to the page, so opening costs a
// single style recalculation of the (often large) SillyTavern page instead of several.
function measureChatStyles() {
    const chat = document.getElementById('chat');
    if (!chat) return null;
    // The text colour and font a message inherits from the page around the chat: read from a drawn
    // character message, or from a hidden sample message when the chat has none.
    let text = chat.querySelector('.mes[is_user="false"] .mes_text') || chat.querySelector('.mes .mes_text'), probe = null;
    if (!text) {
        probe = el('div', 'mes'); const block = el('div', 'mes_block'); text = el('div', 'mes_text');
        probe.setAttribute('is_user', 'false'); probe.setAttribute('aria-hidden', 'true'); probe.style.display = 'none';
        block.append(text); probe.append(block); chat.prepend(probe); // first, so `:last-child` rules stay put
    }
    let base;
    try {
        const computed = getComputedStyle(text);
        base = `:where(#sideleaf-dialog) .cd-rich { ${BASE_PROPS.map(prop => `${prop}: ${computed.getPropertyValue(prop)}`).join('; ')} }`;
    } finally { probe?.remove(); }
    const sheets = pageSheets();
    const signature = `${sheets.length}|${sheets.reduce((sum, [, rules]) => sum + rules.length, 0)}|${document.getElementById('custom-style')?.textContent.length ?? ''}`;
    const rules = mirror?.signature === signature && mirror.style.isConnected ? null : sheets.flatMap(([, list]) => [...list].flatMap(rule => [mirrorRule(rule)].flat().filter(Boolean)));
    return { base, signature, rules };
}
function applyChatStyles(measured) {
    if (!measured) return;
    if (measured.rules) {
        mirror?.style.remove();
        const style = el('style'); style.id = 'sideleaf-chat-style'; document.head.append(style);
        style.sheet.insertRule(measured.base, 0);
        // Inserted rule by rule: one selector the browser rejects must not drop the rest.
        for (const text of measured.rules) {
            try { style.sheet.insertRule(text, style.sheet.cssRules.length); } catch { /* unsupported selector */ }
        }
        mirror = { signature: measured.signature, style };
    } else {
        mirror.style.sheet.deleteRule(0);
        mirror.style.sheet.insertRule(measured.base, 0);
    }
    mirror.style.disabled = false;
}

// Plain text, never parsed as HTML. Quoted passages are wrapped in <q> so they keep the theme's quote colour.
const QUOTED = /("[^"\n]+"|“[^”\n]+”|「[^」\n]+」|『[^』\n]+』)/;
function quotedText(text, message) {
    const node = el('div', 'cd-text cd-rich');
    text.split(QUOTED).forEach((part, i) => node.append(i % 2 ? el('q', '', part) : part));
    return mirrored(node, message);
}
function textBlock(text, message) {
    const box = el('div', 'cd-text-wrap');
    let shown = 0;
    const more = button('본문 더 보기', () => append(), 'cd-more');
    const append = () => {
        more.remove();
        box.append(quotedText(text.slice(shown, shown + 20000), message));
        shown += 20000;
        if (shown < text.length) box.append(more);
    };
    append();
    return box;
}

function itemTools(item, versions, current, refresh, reading = false) {
    const tools = el('div', 'cd-tools');
    const locked = isLocked();
    if (versions.length > 1) tools.append(selectControl('layers', '읽을 본문 고르기', versions.map(v => [v.key, v.label]), current.key, value => { versionChoice.set(item.key, value); refresh(); }, 'cd-version'));
    tools.append(el('span', 'cd-spacer'));
    if (!reading) tools.append(iconButton('book', '넓은 화면으로 읽기', () => showReader(item), '크게 읽기'));
    const copy = iconButton('copy', '지금 보이는 본문 복사', () => copyText(current.text));
    // One editor for title and body (the title field sits above the body).
    const body = iconButton('pencil', `제목·${current.label} 고치기`, () => editItem(item, current));
    const remove = iconButton('trash', '별지에서 삭제', () => removeItems([item.key]));
    remove.classList.add('cd-danger');
    body.disabled = remove.disabled = locked;
    tools.append(copy, body);
    const drawer = currentDrawer();
    if (drawer.folders?.length) {
        const folder = selectControl('folder', '폴더 옮기기', folderChoices(drawer), folderOf(drawer, item) || NO_FOLDER, value => {
            if (reader) readerReturn = item.key;
            commit('folder', {type:'move', ids:[item.key], folder:value === NO_FOLDER ? '' : value});
        }, 'cd-folder-pick', true);
        folder.querySelector('select').disabled = locked; tools.append(folder);
    }
    tools.append(remove);
    return tools;
}

// Folder choices for selects; the empty value is reserved for the "move to…" prompt.
const NO_FOLDER = '\u0000none', NEW_FOLDER = '\u0000new';
function folderChoices(drawer) {
    return [[NO_FOLDER, '폴더 없음'], ...(drawer.folders || []).map(folder => [folder.id, folder.name])];
}
function folderBar(drawer, locked) {
    const bar = el('div', 'cd-folders'); bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', '폴더');
    const counts = new Map();
    for (const item of drawer.items) { const key = folderOf(drawer, item); counts.set(key, (counts.get(key) || 0) + 1); }
    const chip = (key, text, count, iconName) => {
        const node = button(text, () => { if (folderView === key) return; folderView = key; page = 0; selected.clear(); expanded.clear(); render(); }, 'cd-chip');
        if (iconName) node.prepend(icon(iconName));
        node.append(el('span', 'cd-count', String(count)));
        node.setAttribute('aria-pressed', String(folderView === key)); node.disabled = locked;
        return node;
    };
    const chips = el('div', 'cd-chips');
    chips.append(chip('all', '전체', drawer.items.length));
    for (const folder of drawer.folders) chips.append(chip(folder.id, folder.name, counts.get(folder.id) || 0, 'folder'));
    if (counts.get('')) chips.append(chip('', '폴더 없음', counts.get('')));
    const add = iconButton('plus', editMode && selected.size ? '새 폴더를 만들고 고른 항목을 넣기' : '새 폴더 만들기', () => folderEditor(null, editMode ? [...selected] : []));
    add.classList.add('cd-chip-add'); add.disabled = locked; chips.append(add);
    bar.append(chips);
    const active = drawer.folders.find(folder => folder.id === folderView);
    if (active) {
        const rename = iconButton('title', `「${active.name}」 이름 바꾸기`, () => folderEditor(active));
        const remove = iconButton('trash', `「${active.name}」 폴더 지우기 (안의 항목은 남습니다)`, () => removeFolder(active));
        rename.disabled = remove.disabled = locked; bar.append(rename, remove);
    }
    return bar;
}
function folderEditor(folder = null, ids = []) {
    if (busy || pending || dialog.querySelector('.cd-jump')) return;
    const shade = el('div', 'cd-shade'), popup = el('section', 'cd-jump cd-mini');
    popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', folder ? '폴더 이름 바꾸기' : '새 폴더');
    const input = el('input', 'cd-input'); input.value = folder?.name || ''; input.maxLength = 40; input.placeholder = '폴더 이름 (예: 설정 정리, 외전)';
    input.setAttribute('aria-label', '폴더 이름');
    const dismiss = () => { shade.remove(); popup.remove(); };
    const save = () => {
        if (!input.value.trim()) { input.focus(); return; }
        dismiss();
        commit('folder', folder ? {type:'rename', id:folder.id, name:input.value} : {type:'create', name:input.value, ids});
    };
    shade.addEventListener('click', dismiss);
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); save(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
    });
    const ok = iconButton('check', '저장 (Enter)', save, folder ? '바꾸기' : '만들기'); ok.classList.add('cd-primary');
    const actions = el('div', 'cd-mini-actions'); actions.append(button('취소', dismiss), ok);
    const hint = ids.length ? el('p', 'cd-hint', `고른 ${ids.length}개 항목을 새 폴더에 넣습니다.`) : null;
    popup.append(el('h3', 'cd-mini-title', folder ? '폴더 이름 바꾸기' : '새 폴더'), input, ...(hint ? [hint] : []), actions);
    dialog.append(shade, popup);
    input.focus(); input.select();
}
async function removeFolder(folder) {
    if (isLocked()) return;
    const text = `「${folder.name}」 폴더를 지울까요? 안에 있던 항목은 지워지지 않고 '폴더 없음'으로 옮겨집니다.`;
    const ctx = context();
    const ok = typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE?.CONFIRM !== undefined ? Boolean(await ctx.callGenericPopup(text, ctx.POPUP_TYPE.CONFIRM)) : globalThis.confirm(text);
    if (!ok) return;
    folderView = 'all';
    commit('folder', {type:'remove', id:folder.id});
}

async function confirmDelete(count) {
    const text = `${count}개 항목을 별지에서 삭제할까요? 대화로 복원되지 않고 별지에서 사라집니다.`;
    const ctx = context();
    if (typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE?.CONFIRM !== undefined) return Boolean(await ctx.callGenericPopup(text, ctx.POPUP_TYPE.CONFIRM));
    return globalThis.confirm(text);
}
async function removeItems(ids) {
    if (isLocked() || !ids.length || !(await confirmDelete(ids.length))) return;
    if (reader) { reader = false; readerKey = null; }
    commit('delete', {ids});
}

function row(item) {
    const archive = view === 'archive';
    const selecting = !archive || editMode;
    const open = expanded.has(item.key);
    const locked = isLocked();
    const card = el('article', 'cd-card');
    card.classList.toggle('cd-open', open);
    const versions = versionsOf(item);
    const current = chosenVersion(item, versions);
    const toggle = () => {
        if (expanded.has(item.key)) expanded.delete(item.key); else expanded.add(item.key);
        const next = row(item); card.replaceWith(next);
        (next.querySelector('.cd-expand') || next.querySelector('.cd-card-head'))?.focus({preventScroll:true});
    };

    const head = el(selecting ? 'label' : 'div', 'cd-card-head');
    if (selecting) {
        const check = el('input', 'cd-check'); check.type = 'checkbox'; check.checked = selected.has(item.key); check.disabled = locked;
        check.setAttribute('aria-label', `메시지 #${item.index} 선택`);
        check.addEventListener('change', () => { if (check.checked) selected.add(item.key); else selected.delete(item.key); updateSelection(); });
        head.append(check);
    } else {
        head.tabIndex = 0; head.setAttribute('role', 'button'); head.setAttribute('aria-expanded', String(open));
        head.addEventListener('click', toggle);
        head.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
    }
    const main = el('div', 'cd-card-main');
    const name = speaker(item.message);
    if (archive) {
        // Untitled items show the opening text once, as a two-line title, instead of repeating it below.
        main.append(el('strong', `cd-card-title${item.title ? '' : ' cd-untitled'}`, itemTitle(item, current.text, 200)));
        const meta = [name, `#${item.index}`, new Date(item.archivedAt).toLocaleDateString()];
        if (versions.length > 1) meta.push(current.label);
        const line = el('span', 'cd-card-meta');
        const folderName = folderView === 'all' && currentDrawer().folders?.find(folder => folder.id === item.folder)?.name;
        if (folderName) { const tag = el('span', 'cd-folder-tag'); tag.append(icon('folder'), folderName); line.append(tag); }
        line.append(meta.join(' · '));
        main.append(line);
    } else {
        const line = el('span', 'cd-card-title'); line.append(el('strong', '', name), el('span', 'cd-number', `#${item.index}`));
        main.append(line);
    }
    if (!open && !(archive && !item.title)) main.append(el('p', 'cd-snippet', preview({ mes: current.text }, 220)));
    head.append(main);
    if (!selecting) head.append(icon(open ? 'up' : 'down'));
    card.append(head);

    if (selecting) {
        const side = el('div', 'cd-card-side');
        const expand = iconButton(open ? 'up' : 'down', open ? '접기' : '본문 펼치기', toggle); expand.classList.add('cd-expand');
        expand.setAttribute('aria-expanded', String(open)); side.append(expand);
        if (archive) {
            card.dataset.key = item.key;
            const grip = iconButton('grip', '끌어서 순서 변경 · 누르면 위치 지정', () => { if (!grip.dataset.dragged) moveEditor(item); delete grip.dataset.dragged; }); grip.classList.add('cd-grip');
            grip.disabled = locked; grip.draggable = !locked;
            // Mouse: the browser's own drag and drop.
            grip.addEventListener('dragstart', event => { event.dataTransfer.setData('text/x-sideleaf', item.key); event.dataTransfer.effectAllowed = 'move'; card.classList.add('cd-dragging'); });
            grip.addEventListener('dragend', () => card.classList.remove('cd-dragging'));
            card.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('text/x-sideleaf')) { event.preventDefault(); card.classList.add('cd-drop-target'); } });
            card.addEventListener('dragleave', () => card.classList.remove('cd-drop-target'));
            card.addEventListener('drop', event => {
                event.preventDefault(); card.classList.remove('cd-drop-target');
                dropOn(event.dataTransfer.getData('text/x-sideleaf'), item.key);
            });
            // Touch and pen: browsers start no drag from a finger, so the finger is followed directly.
            grip.addEventListener('pointerdown', event => { if (event.pointerType !== 'mouse' && !grip.disabled) touchDrag(event, grip, card, item.key); });
            side.append(grip);
        }
        card.append(side);
    }
    if (open) {
        const body = el('div', 'cd-card-body');
        if (archive) body.append(itemTools(item, versions, current, () => { const next = row(item); card.replaceWith(next); }));
        body.append(contentBlock(item, current));
        card.append(body);
    }
    return card;
}

// Dropping on a card puts the dragged item in that card's place: above it when moving up, below when moving down.
function dropOn(from, to) {
    const ids = archiveItems().map(x => x.key);
    if (!from || from === to || !ids.includes(from) || !ids.includes(to)) return;
    const down = ids.indexOf(from) < ids.indexOf(to);
    ids.splice(ids.indexOf(from), 1);
    ids.splice(ids.indexOf(to) + (down ? 1 : 0), 0, from);
    commit('order', {order:ids});
}
function touchDrag(start, grip, card, key) {
    start.preventDefault();
    const list = card.closest('.cd-list');
    let target = null, moved = false, scroll = 0, timer = null, lastY = start.clientY;
    const mark = next => { if (target !== next) { target?.classList.remove('cd-drop-target'); target = next; target?.classList.add('cd-drop-target'); } };
    const pick = (x, y) => {
        const under = document.elementFromPoint(x, y)?.closest('.cd-card');
        mark(under && under !== card && under.dataset.key && list.contains(under) ? under : null);
    };
    // Near the top or bottom edge the list scrolls by itself, so far items can be reached.
    const edgeScroll = () => {
        if (!scroll) { clearInterval(timer); timer = null; return; }
        list.scrollTop += scroll; pick(start.clientX, lastY);
    };
    const move = event => {
        if (event.pointerId !== start.pointerId) return;
        if (!moved && Math.abs(event.clientY - start.clientY) < 6) return;
        if (!moved) { moved = true; card.classList.add('cd-dragging'); }
        event.preventDefault();
        lastY = event.clientY; pick(event.clientX, event.clientY);
        const box = list.getBoundingClientRect();
        scroll = event.clientY < box.top + 48 ? -10 : event.clientY > box.bottom - 48 ? 10 : 0;
        if (scroll && !timer) timer = setInterval(edgeScroll, 16);
    };
    const end = event => {
        if (event.pointerId !== start.pointerId) return;
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', end);
        clearInterval(timer); card.classList.remove('cd-dragging');
        const dropTarget = target; mark(null);
        if (!moved) return; // a plain tap still opens "move to position"
        grip.dataset.dragged = '1'; setTimeout(() => delete grip.dataset.dragged, 400);
        if (event.type === 'pointerup' && dropTarget) dropOn(key, dropTarget.dataset.key);
    };
    document.addEventListener('pointermove', move, {passive: false});
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
}

async function copyText(text) {
    try {
        if (navigator.clipboard && globalThis.isSecureContext) await navigator.clipboard.writeText(text);
        else {
            const area = el('textarea'); area.value = text; area.className = 'cd-clipboard'; dialog.append(area); area.select();
            const copied = document.execCommand('copy'); area.remove(); if (!copied) throw new Error('복사 권한을 확인해주세요.');
        }
        note('지금 보이는 본문을 복사했습니다.');
    } catch (error) { note(error.message || '복사하지 못했습니다.', true); }
}

function formScreen(heading, fields, cancel, onSave) {
    dialog.classList.remove('cd-reading');
    const bar = el('header', 'cd-header');
    const left = el('div', 'cd-brand'); left.append(iconButton('back', '취소하고 돌아가기', cancel), el('h2', '', heading));
    bar.append(left);
    const form = el('div', 'cd-form'); form.append(...fields);
    form.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); onSave(); } });
    const footer = el('footer', 'cd-footer');
    const save = iconButton('check', '저장 (Ctrl+Enter)', onSave, '저장'); save.classList.add('cd-primary');
    footer.append(el('span', 'cd-spacer'), button('취소', cancel), save);
    const status = statusLine();
    dialog.replaceChildren(bar, form, footer, status);
}

// One editor for the title and the version being read (original, translation, ...). The body is
// replaced in place and then marked "(수정)".
function editItem(item, version) {
    if (busy || pending) return;
    editing = item.key;
    clearTimeout(searchTimer);
    const wasReader = reader;
    if (wasReader) readerReturn = item.key;
    reader = false;
    const titleLabel = el('label', 'cd-field'); titleLabel.append(el('span', 'cd-field-label', '제목'));
    const title = el('input', 'cd-input'); title.value = item.title || ''; title.maxLength = 160; title.placeholder = '비워두면 본문 앞부분을 제목으로 씁니다';
    titleLabel.append(title);
    // The editor shows the stored text with its markup, so saving keeps formatting intact.
    const body = el('textarea', 'cd-editor'); body.value = version.raw;
    const bodyLabel = el('label', 'cd-field cd-field-grow'); bodyLabel.append(el('span', 'cd-field-label', `${version.label.replace(/\(수정\)$/, '')} 고치기`), body);
    const hint = version.key === 'original'
        ? '원문을 바로 고칩니다. 대화로 복원하면 고친 내용이 돌아갑니다.'
        : '지금 보고 있는 본문을 바로 고칩니다.';
    const cancel = () => { editing = null; readerReturn = null; if (wasReader) showReader(item); else render(); };
    const save = () => {
        const change = body.value === version.raw ? undefined : {key:version.key, text:body.value};
        if (title.value.trim() === (item.title || '') && !change) { cancel(); return; }
        commit('edit', {id:item.key, title:title.value, change});
    };
    formScreen('제목·본문 수정', [titleLabel, bodyLabel, el('p', 'cd-hint', hint)], cancel, save);
    body.focus();
}

function exitReader() {
    reader = false; readerKey = null; dialog.classList.remove('cd-reading'); render();
}

function showReader(item) {
    clearTimeout(searchTimer);
    const revision = currentDrawer().revision;
    // Rebuild whenever the item is missing too, so paging never shows "0 / 0".
    if (!reader || readerRevision !== revision || !readerItems.some(x => x.key === item.key)) {
        readerItems = shownItems().filter(matchesSearch);
        if (!readerItems.some(x => x.key === item.key)) readerItems = archiveItems();
        if (!readerItems.some(x => x.key === item.key)) readerItems = [item];
        readerRevision = revision;
    }
    reader = true;
    readerKey = item.key;
    dialog.classList.add('cd-reading');
    const index = readerItems.findIndex(x=>x.key===item.key);
    const versions = versionsOf(item);
    const current = chosenVersion(item, versions);
    const bar = el('header', 'cd-reader-bar');
    const back = iconButton('back', '목록으로 (Esc)', exitReader, '목록');
    // Built twice: in the top bar on wide screens, and in a bottom bar within thumb reach on phones (CSS picks one).
    const makeNav = () => {
        const nav = el('div', 'cd-reader-nav');
        const previous = iconButton('left', '이전 메시지 (←)', () => stepReader(-1)); previous.disabled = index <= 0;
        const jump = button(`${index+1} / ${readerItems.length}`, showReaderList, 'cd-reader-count'); jump.prepend(icon('list')); jump.title = '목록에서 골라 이동';
        const next = iconButton('right', '다음 메시지 (→)', () => stepReader(1)); next.disabled = index >= readerItems.length-1;
        nav.append(previous, jump, next);
        return nav;
    };
    const foot = el('footer', 'cd-reader-foot'); foot.append(makeNav());
    bar.append(back, makeNav(), itemTools(item, versions, current, () => showReader(item), true));
    const content = el('div', 'cd-reading-content');
    const sheet = el('article', 'cd-page');
    const meta = [speaker(item.message), `#${item.index}`, new Date(item.archivedAt).toLocaleDateString(), current.label];
    sheet.append(el('h1', 'cd-page-title', itemTitle(item, current.text)), el('p', 'cd-page-meta', meta.join(' · ')), contentBlock(item, current));
    content.append(sheet);
    const controls = 'button,select,input,textarea';
    // Horizontal touch swipes page through items; vertical scrolling stays native.
    let touch = null;
    content.addEventListener('pointerdown', event => {
        if (event.pointerType === 'touch' && !event.target.closest(controls)) touch = { x: event.clientX, y: event.clientY };
    });
    content.addEventListener('pointercancel', () => { touch = null; });
    content.addEventListener('pointerup', event => {
        if (!touch) return;
        const dx = event.clientX - touch.x, dy = event.clientY - touch.y;
        touch = null;
        if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) stepReader(dx < 0 ? 1 : -1);
    });
    content.tabIndex = 0;
    content.addEventListener('keydown', event => {
        if (event.target.closest(controls) || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return;
        event.preventDefault();
        stepReader(event.key === 'ArrowRight' ? 1 : -1);
    });
    const status = statusLine();
    dialog.replaceChildren(bar, content, foot, status); content.scrollTop = 0;
    content.focus({preventScroll:true});
}

function stepReader(direction) {
    const index = readerItems.findIndex(x => x.key === readerKey), next = readerItems[index + direction];
    if (!next) return;
    showReader(next);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    dialog.querySelector('.cd-page').animate([{opacity:.3, transform:`translateX(${direction * 28}px)`}, {opacity:1, transform:'translateX(0)'}], {duration:160, easing:'ease-out'});
}

function showReaderList() {
    if (dialog.querySelector('.cd-jump')) return;
    const popup = el('section', 'cd-jump'); popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', '메시지 목록');
    const shade = el('div', 'cd-shade');
    const dismiss = () => { shade.remove(); popup.remove(); dialog.querySelector('.cd-reading-content')?.focus(); };
    shade.addEventListener('click', dismiss);
    popup.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); } });
    const field = el('label', 'cd-search-field'); field.append(icon('search'));
    const input = el('input', 'cd-search'); input.type = 'search'; input.placeholder = '목록에서 찾기'; input.setAttribute('aria-label', '목록에서 찾기');
    field.append(input);
    const list = el('div', 'cd-jump-items');
    let offset = 0;
    const entry = item => {
        const node = button('', () => showReader(item), 'cd-jump-item');
        const text = chosenVersion(item, versionsOf(item)).text;
        node.append(el('strong', '', itemTitle(item, text)), el('span', 'cd-card-meta', `${speaker(item.message)} · #${item.index}`));
        if (item.key === readerKey) node.setAttribute('aria-current', 'true');
        return node;
    };
    const draw = () => {
        const found = readerItems.filter(item => matchesQuery(item, input.value));
        list.replaceChildren(...found.slice(offset, offset + PAGE_SIZE).map(entry));
        if (!found.length) list.append(el('p', 'cd-hint', '찾는 항목이 없습니다.'));
        if (found.length <= PAGE_SIZE) return;
        const pages = el('div', 'cd-pagination');
        const previous = iconButton('left', '목록 이전 페이지', () => { offset -= PAGE_SIZE; draw(); }); previous.disabled = offset === 0;
        const next = iconButton('right', '목록 다음 페이지', () => { offset += PAGE_SIZE; draw(); }); next.disabled = offset + PAGE_SIZE >= found.length;
        pages.append(previous, el('span', 'cd-page-count', `${offset / PAGE_SIZE + 1} / ${Math.ceil(found.length / PAGE_SIZE)}`), next);
        list.append(pages);
    };
    let timer;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { offset = 0; draw(); }, 150); });
    const head = el('div', 'cd-jump-head'); head.append(field, iconButton('close', '목록 닫기', dismiss));
    popup.append(head, list); dialog.append(shade, popup); draw();
    list.querySelector('[aria-current="true"]')?.scrollIntoView({block:'center'});
    input.focus();
}

function moveEditor(item) {
    if (busy || pending) return;
    editing = item.key;
    const ids = archiveItems().map(x => x.key);
    const label = el('label', 'cd-field'); label.append(el('span', 'cd-field-label', `「${itemTitle(item, versionsOf(item)[0].text, 40)}」을 몇 번째로 옮길까요?`));
    const input = el('input', 'cd-input'); input.type = 'number'; input.min = '1'; input.max = String(ids.length); input.value = String(ids.indexOf(item.key) + 1); input.inputMode = 'numeric';
    label.append(input);
    const save = () => {
        const n = Number(input.value);
        if (!Number.isInteger(n) || n < 1 || n > ids.length) { input.reportValidity(); return; }
        if (n === ids.indexOf(item.key) + 1) { editing = null; render(); return; }
        ids.splice(ids.indexOf(item.key), 1); ids.splice(n - 1, 0, item.key); commit('order', {order:ids});
    };
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); save(); } });
    formScreen('순서 이동', [label, el('p', 'cd-hint', `지금 보이는 정렬 기준으로 1~${ids.length}번째 위치입니다. 저장하면 ‘직접 정한 순서’로 바뀝니다. 편집 모드에서 손잡이를 끌어 옮길 수도 있어요.`)], () => { editing = null; render(); }, save);
    input.focus(); input.select();
}

// Relative luminance and contrast ratio (WCAG) of computed rgb()/rgba() colours.
function luminance(color) {
    const [r = 0, g = 0, b = 0] = (String(color).match(/[\d.]+/g) || []).map(Number);
    const channel = value => { value /= 255; return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a, b) {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
}

// Reading space follows the live chat's computed font and background (read only; open() applies them).
function chatAppearance() {
    const chat = document.querySelector('#chat');
    if (!chat) return {};
    const text = getComputedStyle(chat.querySelector('.mes_text') || chat);
    const out = {'--sl-chat-color':text.color, '--sl-chat-font':text.fontFamily, '--sl-chat-size':text.fontSize, '--sl-chat-line':text.lineHeight, '--sl-chat-spacing':text.letterSpacing};
    const layers = [];
    let color = '';
    for (let node = chat; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== 'none') layers.push(style.backgroundImage);
        if (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') {
            layers.push(`linear-gradient(${style.backgroundColor}, ${style.backgroundColor})`);
            if (!style.backgroundColor.startsWith('rgba')) { color = style.backgroundColor; break; }
        }
    }
    const background = document.querySelector('#bg1');
    if (!color && background) { const style = getComputedStyle(background); if (style.backgroundImage !== 'none') layers.push(style.backgroundImage); color = style.backgroundColor; }
    // Themes with see-through panels (the chat shows a wallpaper) leave no solid colour to find. The text
    // colour then decides: a light page behind dark text and the other way round, so it always reads.
    const opaque = color && !/^(?:transparent|rgba\(.*,\s*0(?:\.\d+)?\))$/.test(color);
    const readable = opaque && contrast(color, text.color) >= 3;
    if (!readable) {
        color = luminance(text.color) < 0.35 ? '#f5f2ec' : '#1f2027';
        layers.length = 0; // the translucent layers were part of what made it unreadable
    }
    out['--sl-base'] = color;
    out['--sl-layers'] = layers.length ? layers.join(',') : 'none';
    const message = chat.querySelector('.mes');
    if (message) out['--sl-message-bg'] = getComputedStyle(message).backgroundColor;
    return out;
}

async function archiveFromMessage(button) {
    if (busy || pending || dialog?.open) return;
    const index = Number(button.closest('.mes')?.getAttribute('mesid'));
    if (!Number.isInteger(index)) return;
    openedChat = chatIdentity(context()); view = 'select'; snapshot = context().chat.slice(); selected = new Set([index]);
    await commit('archive');
}

// Same shape as SillyTavern's own message buttons (a Font Awesome glyph), so themes restyle it alike.
function messageButton() {
    const entry = el('div', 'sideleaf-archive-button mes_button fa-solid fa-star interactable');
    entry.tabIndex = 0; entry.setAttribute('role', 'button'); entry.title = '별지에 보관'; entry.setAttribute('aria-label', '별지에 보관');
    return entry;
}
// Inside the "…" group when there is one (where extension buttons belong, so themes that fold the
// row never put it in place of "…"), first in it; otherwise first in the button row.
// Whether the actions are folded behind "…" right now: read from a drawn message (theme and settings
// decide it); before any message is drawn, from SillyTavern's "expand message actions" setting.
function actionsFolded() {
    const row = [...document.querySelectorAll('#chat .mes[mesid] .mes_buttons')].at(-1);
    const hint = row?.querySelector(':scope > .extraMesButtonsHint');
    if (hint) return getComputedStyle(hint).display !== 'none';
    return !document.body.classList.contains('expandMessageActions');
}
// Folded: first inside the "…" group, where extension buttons belong (so it never takes the place of
// "…"). Shown inline: first in the whole row, so it stays at the left end.
function addButton(root, folded = actionsFolded()) {
    const box = root?.querySelector('.extraMesButtons'), row = root?.querySelector('.mes_buttons');
    const target = folded && box ? box : row || box;
    if (!target) return;
    // Extensions loading later prepend their own buttons too; move ours back to the front.
    const existing = root.querySelector('.sideleaf-archive-button');
    if (existing && existing === target.firstElementChild) return;
    target.prepend(existing || messageButton());
}
// Reading the theme's layout makes the browser recalculate the page's styles, which is slow on a busy
// SillyTavern page. So it is read only when the chat is (re)drawn or the setting changes, not for every
// new message; new messages already carry the button from the message template.
let folded = null;
function addMessageButtons(measure = false) {
    if (measure || folded === null) folded = actionsFolded();
    addButton(document.querySelector('#message_template .mes'), folded);
    for (const message of document.querySelectorAll('#chat .mes[mesid]')) addButton(message, folded);
}

const SETTINGS_KEY = 'sideleaf';
const settings = () => {
    const all = context().extensionSettings;
    if (!all) return { messageButton: true };
    all[SETTINGS_KEY] ??= {};
    all[SETTINGS_KEY].messageButton ??= true;
    return all[SETTINGS_KEY];
};
function applySettings() {
    document.body.classList.toggle('sideleaf-no-message-button', !settings().messageButton);
    addMessageButtons(true);
}
function settingsScreen() {
    if (busy || pending) return;
    editing = 'settings';
    dialog.classList.remove('cd-reading');
    const ctx = context();
    const bar = el('header', 'cd-header');
    const left = el('div', 'cd-brand');
    const back = () => { editing = null; render(); };
    left.append(iconButton('back', '돌아가기', back), el('h2', '', '설정'));
    bar.append(left);
    const body = el('div', 'cd-form cd-settings');
    const section = (title, ...nodes) => { const box = el('section', 'cd-setting'); box.append(el('h3', '', title), ...nodes); return box; };
    const toggle = el('label', 'cd-toggle');
    const check = el('input'); check.type = 'checkbox'; check.checked = settings().messageButton;
    check.addEventListener('change', () => { settings().messageButton = check.checked; ctx.saveSettingsDebounced?.(); applySettings(); });
    toggle.append(check, el('span', '', '메시지 메뉴에 ★ 버튼 표시'));
    body.append(section('메시지 메뉴', toggle, el('p', 'cd-hint', '꺼도 별지 창의 ‘메시지 보관하기’에서 골라 보관할 수 있습니다.')));
    const split = ctx.chatMetadata?.[KEY]?.version === 2;
    const backup = iconButton('download', '활성 채팅과 별지 전체를 JSONL 한 파일로 내려받기', exportArchive, '통합 백업 받기');
    const nodes = [el('p', 'cd-hint', split
        ? '이 채팅의 별지는 채팅 파일과 따로 저장되어 있어, 일반 채팅 내보내기에는 빠집니다. 다른 서버로 옮기거나 백업할 때는 통합 백업을 쓰세요.'
        : '이 채팅의 별지는 아직 채팅 파일 안에 있습니다. 분리 저장으로 바꾸면 평소 채팅 로딩이 가벼워지고, 보관·수정할 때도 자동으로 바뀝니다.'), backup];
    if (!split && currentDrawer().items.length) {
        const migrate = iconButton('split', '별지 본문을 채팅 파일 밖으로 분리해 저장', () => commit('migrate'), '분리 저장으로 바꾸기');
        migrate.disabled = isGenerating(); nodes.push(migrate);
    }
    body.append(section('백업 · 저장 방식', ...nodes));
    dialog.replaceChildren(bar, body, statusLine());
}

// Runs as soon as the module loads, before the chat is drawn: the wand entry and the message
// button then appear together with SillyTavern's own, instead of after the chat has loaded.
let earlyDone = false;
function installEarly() {
    if (earlyDone) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    earlyDone = true;
    // Same markup as SillyTavern's own wand entries, so themes align the icon and label the same way.
    const container = el('div', 'extension_container interactable');
    const entry = el('div', 'list-group-item flex-container flexGap5 interactable');
    entry.id = 'sideleaf-wand'; entry.tabIndex = 0; entry.setAttribute('role', 'listitem'); entry.title = '별지 보관함 열기';
    // SillyTavern's bundled Font Awesome star, like every other entry: menu tweakers and themes
    // recognise and position font icons, but not custom SVGs.
    const glyph = el('div', 'fa-fw fa-solid fa-star extensionsMenuExtensionButton');
    entry.append(glyph, el('span', '', '별지'));
    entry.addEventListener('click', () => open());
    entry.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    container.append(entry); menu.append(container);
    // Unsupported host: keep only the menu entry (which explains why) and hook into nothing else.
    if (missingFeatures().length) return;
    applySettings();
    // The message template is copied for every message SillyTavern draws, so the button is part of
    // each message from the start (other extensions add theirs the same way).
    addButton(document.querySelector('#message_template .mes'));
    // One listener for every message, including ones drawn later.
    const activate = event => {
        const button = event.target instanceof Element ? event.target.closest('#chat .sideleaf-archive-button') : null;
        if (!button) return;
        if (event.type === 'keydown') { if (event.key !== 'Enter' && event.key !== ' ') return; event.preventDefault(); }
        archiveFromMessage(button);
    };
    document.addEventListener('click', activate);
    document.addEventListener('keydown', activate);
}

let initialized = false;
function initialize() {
    installEarly();
    if (initialized) return;
    initialized = true;
    if (!earlyDone) { console.warn('[Sideleaf] Wand menu unavailable'); return; }
    if (missingFeatures().length) { console.warn('[Sideleaf] Missing host features:', missingFeatures()); return; }
    const ctx = context();
    installQrSource(context);
    const on = (type, handler) => { if (ctx.eventTypes[type]) ctx.eventSource.on(ctx.eventTypes[type], handler); };
    let buttonsQueued = false;
    // Messages drawn before the template had the button (or by builds without a template) catch up here.
    // A short timer instead of requestAnimationFrame: rAF stalls while the tab is in the background.
    let measureNext = false;
    const queueButtons = measure => { measureNext ||= measure === true; if (buttonsQueued) return; buttonsQueued = true; setTimeout(() => { buttonsQueued = false; addMessageButtons(measureNext); measureNext = false; }, 16); };
    for (const event of ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MORE_MESSAGES_LOADED']) on(event, () => queueButtons(false));
    on('CHAT_CHANGED', () => queueButtons(true));
    addMessageButtons(true);
    // Preview/dry-run generation also emits STARTED, sometimes without ENDED.
    // Read the core state instead of keeping a potentially stale event latch.
    // Only the generation-dependent controls change; rebuilding the list would reset scroll and drags.
    const updateGeneration = () => { if (dialog) setTimeout(refreshGenerationState, 0); };
    on('GENERATION_STARTED', updateGeneration);
    on('GENERATION_ENDED', updateGeneration);
    on('GENERATION_STOPPED', updateGeneration);
    on('CHAT_CHANGED', () => {
        if (!pending && !busy && (!dialog || openedChat !== chatIdentity(context()))) clearArchiveCache();
        if (openedChat !== chatIdentity(context()) && dialog) {
            if (pending) { note('채팅이 변경되었습니다. 저장 중이던 원래 채팅을 확인해주세요.', true); return; }
            // An unsaved title/body edit belongs to the previous chat; it cannot be saved here.
            close(true);
        }
    });
    if (ctx.SlashCommandParser && ctx.SlashCommand) ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
        name: 'sideleaf', callback: () => { open(); return ''; }, helpString: '현재 채팅의 메시지 보관함을 엽니다.',
    }));
}

installEarly();
const boot = context();
if (boot.eventTypes?.APP_READY && boot.eventSource) {
    boot.eventSource.on(boot.eventTypes.APP_READY, initialize);
    // Builds that do not replay APP_READY to late listeners: initialize once the UI is there anyway.
    setTimeout(initialize, 5000);
}
else initialize();
