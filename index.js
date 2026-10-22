import { KEY, PAGE_SIZE, readDrawer, archivePlan, restorePlan, chatIdentity, preview, readingVersions, editPlan } from './model.js';
import { isGenerating } from '../../../../script.js';

const context = () => SillyTavern.getContext();
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
const id = () => context().uuidv4?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
function button(text, action, className = '') {
    const node = el('button', `cd-button ${className}`, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
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

async function commit(kind, edit = null) {
    if (busy || pending) return;
    try {
        const ctx = assertReady();
        if (!edit && !selected.size) return;
        if (view === 'select' && (snapshot.length !== ctx.chat.length || snapshot.some((message, i) => message !== ctx.chat[i]))) {
            selected.clear(); render(); throw new Error('대화가 변경되어 선택을 해제했습니다. 다시 골라주세요.');
        }
        const plan = edit ? editPlan(ctx.chat, readDrawer(ctx.chatMetadata), edit.id, edit.title, edit.text, id) : kind === 'archive'
            ? archivePlan(ctx.chat, readDrawer(ctx.chatMetadata), [...selected], id)
            : restorePlan(ctx.chat, readDrawer(ctx.chatMetadata), [...selected], id);
        if (kind === 'archive') for (const item of plan.affected) {
            const text = document.querySelector(`#chat .mes[mesid="${item.originalIndex}"] .mes_text`)?.innerText?.trim();
            // Capture only the selected message body, never the surrounding chat/UI.
            if (text && !item.message.extra?.display_text && text !== String(item.message.mes).trim()) item.screenText = text;
        }
        busy = true;
        pending = { ctx, kind, revision: plan.drawer.revision, identity: openedChat,
            recovery: [{ user_name: ctx.name1, character_name: ctx.name2,
                chat_metadata: structuredClone({ ...ctx.chatMetadata, [KEY]: plan.drawer }) }, ...structuredClone(plan.chat)] };
        ctx.chatMetadata[KEY] = plan.drawer;
        ctx.chatMetadata.tainted = true;
        ctx.chat.length = 0;
        for (const message of plan.chat) ctx.chat.push(message);
        selected.clear();
        editing = null;
        render();
        await finishSave();
    } catch (error) {
        busy = false;
        if (pending && !dialog) open();
        render(); note(error.message, true);
        console.error('[Sideleaf]', error);
    }
}

async function finishSave() {
    const operation = pending;
    if (!operation) return;
    if (chatIdentity(context()) !== operation.identity || context().chatMetadata !== operation.ctx.chatMetadata) {
        throw new Error('채팅이 바뀌어 저장을 중단했습니다. 원래 채팅을 확인해주세요.');
    }
    busy = true; render(); note('저장 확인 중…');
    await operation.ctx.saveChat();
    await verifySave(operation.ctx, operation.revision);
    if (chatIdentity(context()) !== operation.identity) throw new Error('채팅이 바뀌었습니다. 저장한 채팅을 다시 열어 확인해주세요.');
    pending = null;
    try {
        if (operation.kind !== 'edit') await refreshChat();
        if (operation.kind === 'archive') await context().eventSource.emit(context().eventTypes.MESSAGE_DELETED, context().chat.length);
        await context().eventSource.emit('sideleaf:changed', { kind: operation.kind, chatId: context().chatId });
    } finally {
        busy = false; page = 0; view = 'archive'; render();
    }
    note(operation.kind === 'archive' ? '선택한 메시지를 별지에 보관했습니다.' : operation.kind === 'edit' ? '제목과 읽기용 본문을 저장했습니다.' : '선택한 메시지를 채팅 끝에 복원했습니다.');
}

function close() {
    if (busy || pending) { note('저장을 확인한 뒤 닫아주세요.', true); return; }
    if (editing) { note('편집을 저장하거나 취소한 뒤 닫아주세요.', true); return; }
    clearTimeout(searchTimer);
    dialog?.close(); dialog?.remove(); dialog = null;
    snapshot = []; selected.clear(); search = '';
}

function downloadRecovery() {
    if (!pending) return;
    const url = URL.createObjectURL(new Blob([pending.recovery.map(item => JSON.stringify(item)).join('\n')], { type: 'application/jsonl' }));
    const link = document.createElement('a'); link.href = url; link.download = 'sideleaf-recovery.jsonl'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function open() {
    if (dialog?.open) { dialog.focus(); return; }
    openedChat = chatIdentity(context());
    view = 'archive'; page = 0; selected.clear(); search = '';
    dialog = el('dialog', 'cd-dialog');
    dialog.id = 'sideleaf-dialog';
    dialog.setAttribute('aria-label', '별지');
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    document.body.append(dialog);
    render(); dialog.showModal();
}

function render() {
    if (!dialog) return;
    if (editing && !busy) return;
    const ctx = context();
    const generating = isGenerating();
    let drawer;
    try { drawer = readDrawer(ctx.chatMetadata); } catch (error) { dialog.replaceChildren(el('p', '', error.message), button('닫기', close)); return; }
    const heading = el('header', 'cd-header');
    const title = el('div', 'cd-title');
    title.append(el('h2', '', '별지'), el('p', 'cd-subtitle', String(ctx.chatId || '저장된 채팅을 먼저 열어주세요.')));
    const dismiss = button('닫기', close); dismiss.disabled = busy || Boolean(pending);
    heading.append(title, dismiss);
    const nav = el('nav', 'cd-tabs'); nav.setAttribute('aria-label', '별지 보기');
    for (const [key, label] of [['archive', `보관함 ${drawer.items.length}`], ['select', '메시지 선택']]) {
        const tab = button(label, () => { view = key; page = 0; search = ''; selected.clear(); render(); });
        tab.setAttribute('aria-pressed', String(view === key)); tab.disabled = busy || Boolean(pending);
        nav.append(tab);
    }
    const toolbar = el('div', 'cd-toolbar');
    const input = el('input', 'cd-search'); input.type = 'search'; input.placeholder = '내용·이름 검색'; input.setAttribute('aria-label', '내용·이름 검색'); input.value = search;
    input.disabled = busy || Boolean(pending);
    input.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { search = input.value; page = 0; render(); const next = dialog.querySelector('.cd-search'); next.focus(); }, 180);
    });
    toolbar.append(input);
    const hint = el('p', 'cd-hint', view === 'archive'
        ? '이 채팅에서 보관한 메시지만 표시합니다. 복원하면 채팅 끝에 추가됩니다.'
        : '원하는 메시지만 골라 보관하세요. 보관한 메시지는 대화 화면과 이후 AI 대화 기록에서 빠집니다.');
    const list = el('div', 'cd-list'); list.setAttribute('aria-label', view === 'archive' ? '보관 메시지' : '선택할 메시지');
    if (view === 'select' && snapshot.length && (snapshot.length !== ctx.chat.length || snapshot.some((message, i) => message !== ctx.chat[i]))) selected.clear();
    snapshot = ctx.chat.slice();
    const items = view === 'archive'
        ? drawer.items.map((item, index) => ({ ...item, key: item.id, index: item.originalIndex, order: index })).reverse()
        : ctx.chat.map((message, index) => ({ key: index, message, index })).reverse();
    const query = search.trim().toLocaleLowerCase();
    const filtered = query ? items.filter(item => `${item.title || ''}\n${item.message.name || ''}\n${readingVersions(item).map(v => v.text).join('\n')}`.toLocaleLowerCase().includes(query)) : items;
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    for (const item of filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) list.append(row({ ...item, autoOpen: view === 'archive' && filtered.length === 1 }));
    if (!filtered.length) list.append(el('p', 'cd-empty', query ? '검색 결과가 없습니다.' : view === 'archive' ? '아직 비어 있어요. 메시지 선택에서 필요한 내용만 보관하세요.' : '선택할 메시지가 없습니다.'));
    const pagination = el('div', 'cd-pagination');
    const previous = button('이전', () => { page--; render(); }); previous.disabled = page === 0 || busy || Boolean(pending);
    const next = button('다음', () => { page++; render(); }); next.disabled = page >= pages - 1 || busy || Boolean(pending);
    pagination.append(previous, el('span', '', `${page + 1} / ${pages}`), next);
    const footer = el('footer', 'cd-footer');
    const clear = button('선택 해제', () => { selected.clear(); render(); }); clear.disabled = !selected.size || busy || Boolean(pending);
    const action = button(view === 'archive' ? `선택 ${selected.size}개 복원` : `선택 ${selected.size}개 보관`, () => commit(view === 'archive' ? 'restore' : 'archive'), 'cd-primary cd-action');
    action.disabled = !selected.size || busy || Boolean(pending) || !openedChat || generating;
    footer.append(clear, action);
    const status = el('p', 'cd-status', generating ? '응답 생성 중에는 보관·복원을 잠시 멈춥니다.' : ''); status.setAttribute('role', 'status');
    if (pending && !busy) {
        footer.replaceChildren(button('백업 후 닫기', async () => {
            downloadRecovery();
            const sameChat = chatIdentity(context()) === pending.identity;
            pending = null;
            close();
            if (sameChat) await refreshChat();
        }), button('저장 다시 확인', () => finishSave().catch(error => { busy = false; render(); note(error.message, true); }), 'cd-primary'));
        status.textContent = '저장을 확인하지 못했습니다. 현재 내용은 메모리에 유지됩니다. 연결을 확인한 뒤 다시 시도하세요.';
    }
    dialog.replaceChildren(heading, nav, toolbar, hint, list, pagination, footer, status);
}

function row(item) {
    const card = el('article', 'cd-card');
    const top = el('div', 'cd-card-top');
    const label = el('label', 'cd-pick');
    const check = el('input'); check.type = 'checkbox'; check.checked = selected.has(item.key); check.disabled = busy || Boolean(pending);
    check.setAttribute('aria-label', `메시지 #${item.index} 선택`);
    check.addEventListener('change', () => {
        if (check.checked) selected.add(item.key); else selected.delete(item.key);
        const action = dialog.querySelector('.cd-action');
        action.textContent = `선택 ${selected.size}개 ${view === 'archive' ? '복원' : '보관'}`;
        action.disabled = !selected.size || busy || Boolean(pending) || !openedChat || isGenerating();
        dialog.querySelector('.cd-footer .cd-button').disabled = !selected.size;
    });
    label.append(check, el('strong', '', item.message.name || (item.message.is_user ? '사용자' : 'AI')), el('span', 'cd-number', `#${item.index}`));
    top.append(label);
    const details = el('details', 'cd-detail');
    const versions = readingVersions(item);
    let current = versions[0];
    const summary = el('summary');
    summary.append(el('strong', 'cd-item-title', item.title || preview({ mes: current.text }, 60)));
    if (view === 'archive') summary.append(el('span', 'cd-item-meta', `${current.label} · ${new Date(item.archivedAt).toLocaleDateString()}`));
    const body = el('div', 'cd-body');
    details.append(summary, body);
    // Read-only text prevents QR HTML/iframe/JS extensions from executing archived content.
    let shown = 0;
    let fullText = current.text;
    const more = button('본문 더 보기', () => appendText());
    function appendText() {
        more.remove();
        const chunk = el('div', 'cd-text', fullText.slice(shown, shown + 20000));
        shown += 20000; body.append(chunk);
        if (shown < fullText.length) body.append(more);
    }
    details.addEventListener('toggle', () => { if (details.open && !shown) appendText(); });
    if (item.autoOpen) { details.open = true; appendText(); }
    if (view === 'archive') {
        const tools = el('div', 'cd-reader-tools');
        if (versions.length > 1) {
            const select = el('select', 'cd-version'); select.setAttribute('aria-label', '읽을 본문');
            for (const version of versions) { const option = el('option', '', version.label); option.value = version.key; select.append(option); }
            select.addEventListener('change', () => { current = versions.find(v => v.key === select.value); fullText = current.text; shown = 0; body.replaceChildren(); appendText(); });
            tools.append(select);
        }
        tools.append(button('복사', () => copyText(current.text)), button('제목·본문 수정', () => editItem(item, current.text)));
        details.insertBefore(tools, body);
    }
    card.append(top, details);
    return card;
}

async function copyText(text) {
    try {
        if (navigator.clipboard && globalThis.isSecureContext) await navigator.clipboard.writeText(text);
        else {
            const area = el('textarea'); area.value = text; area.className = 'cd-clipboard'; dialog.append(area); area.select();
            const copied = document.execCommand('copy'); area.remove(); if (!copied) throw new Error('복사 권한을 확인해주세요.');
        }
        note('현재 보고 있는 본문을 복사했습니다.');
    } catch (error) { note(error.message || '복사하지 못했습니다.', true); }
}

function editItem(item, text) {
    if (busy || pending) return;
    editing = item.key;
    const header = el('header', 'cd-header'); header.append(el('h2', '', '보관본 편집'));
    const titleLabel = el('label', 'cd-edit-label', '제목');
    const title = el('input', 'cd-search'); title.value = item.title || ''; title.maxLength = 160; title.setAttribute('aria-label', '제목'); titleLabel.append(title);
    const bodyLabel = el('label', 'cd-edit-label cd-edit-body', '읽기용 본문');
    const body = el('textarea', 'cd-editor'); body.value = text; body.setAttribute('aria-label', '읽기용 본문'); bodyLabel.append(body);
    const hint = el('p', 'cd-hint', '수정본은 별지에서 읽고 복사할 때 사용합니다. 원문·번역은 따로 보존하며, 채팅 복원은 원본 메시지를 사용합니다.');
    const footer = el('footer', 'cd-footer');
    footer.append(button('취소', () => { editing = null; render(); }), button('저장', () => commit('edit', {id:item.key, title:title.value, text:body.value}), 'cd-primary'));
    const status = el('p', 'cd-status'); status.setAttribute('role', 'status');
    dialog.replaceChildren(header, titleLabel, bodyLabel, hint, footer, status); title.focus();
}

async function archiveFromMessage(event) {
    if (busy || pending || dialog?.open) return;
    const index = Number(event.currentTarget.closest('.mes')?.getAttribute('mesid'));
    if (!Number.isInteger(index)) return;
    openedChat = chatIdentity(context()); view = 'select'; snapshot = context().chat.slice(); selected = new Set([index]);
    await commit('archive');
}

function addMessageButtons() {
    for (const message of document.querySelectorAll('#chat .mes[mesid]')) {
        if (message.querySelector('.sideleaf-archive-button')) continue;
        const target = message.querySelector('.extraMesButtons, .mes_buttons');
        if (!target) continue;
        const entry = el('button', 'sideleaf-archive-button mes_button fa-solid fa-box-archive');
        entry.type = 'button'; entry.title = '별지에 보관'; entry.setAttribute('aria-label', '별지에 보관');
        entry.addEventListener('click', archiveFromMessage); target.append(entry);
    }
}

function initialize() {
    if (document.getElementById('sideleaf-wand')) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) { console.warn('[Sideleaf] Wand menu unavailable'); return; }
    const container = el('div', 'extension_container');
    const entry = button('별지', open, 'list-group-item flex-container flexGap5');
    entry.id = 'sideleaf-wand';
    const icon = el('i', 'fa-solid fa-box-archive'); icon.setAttribute('aria-hidden', 'true'); entry.prepend(icon);
    container.append(entry); menu.append(container);
    const ctx = context();
    const on = (type, handler) => { if (ctx.eventTypes[type]) ctx.eventSource.on(ctx.eventTypes[type], handler); };
    let buttonsQueued = false;
    const queueButtons = () => { if (buttonsQueued) return; buttonsQueued = true; requestAnimationFrame(() => { buttonsQueued = false; addMessageButtons(); }); };
    for (const event of ['CHAT_CHANGED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MORE_MESSAGES_LOADED']) on(event, queueButtons);
    addMessageButtons();
    // Preview/dry-run generation also emits STARTED, sometimes without ENDED.
    // Read the core state instead of keeping a potentially stale event latch.
    const updateGeneration = () => { if (dialog) setTimeout(() => { if (dialog) render(); }, 0); };
    on('GENERATION_STARTED', updateGeneration);
    on('GENERATION_ENDED', updateGeneration);
    on('GENERATION_STOPPED', updateGeneration);
    on('CHAT_CHANGED', () => {
        if (openedChat !== chatIdentity(context()) && dialog) {
            if (pending) { note('채팅이 변경되었습니다. 저장 중이던 원래 채팅을 확인해주세요.', true); return; }
            close();
        }
    });
    if (ctx.SlashCommandParser && ctx.SlashCommand) ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
        name: 'sideleaf', callback: () => { open(); return ''; }, helpString: '현재 채팅의 메시지 보관함을 엽니다.',
    }));
}

const ctx = context();
if (ctx.eventTypes.APP_READY) ctx.eventSource.on(ctx.eventTypes.APP_READY, initialize);
else initialize();
