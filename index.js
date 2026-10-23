import { KEY, PAGE_SIZE, readDrawer, archivePlan, restorePlan, chatIdentity, preview, readingVersions, editPlan, orderedItems, reorderPlan } from './model.js';
import { isGenerating } from '../../../../script.js';
import { icon } from './icons.js';
import { installQrSource } from './qr-source.js';

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
let reader = false;
let composing = false;
let expanded = new Set();
let editMode = false;
let sortMode = 'desc';
let readerKey = null;
let readerItems = [];
let readerReturn = null;
let readerRevision = null;
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
function iconButton(name, label, action) {
    const node = button('', action, 'cd-icon-button'); node.append(icon(name));
    node.title = label; node.setAttribute('aria-label', label); return node;
}
function setSort(value) {
    sortMode = value; context().accountStorage?.setItem('sideleaf.sort', value); page = 0; render();
}
function archiveItems() {
    return orderedItems(readDrawer(context().chatMetadata), sortMode).map(item => ({...item,key:item.id,index:item.originalIndex}));
}
function matchesSearch(item) {
    const query = search.trim().toLocaleLowerCase();
    return !query || [item.title, item.message.name, ...readingVersions(item).map(v=>v.text)].some(text => typeof text === 'string' && text.toLocaleLowerCase().includes(query));
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
        const plan = kind === 'order' ? reorderPlan(ctx.chat, readDrawer(ctx.chatMetadata), edit.order, id) : edit ? editPlan(ctx.chat, readDrawer(ctx.chatMetadata), edit.id, edit.title, edit.text, id) : kind === 'archive'
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
        if (['archive','restore'].includes(operation.kind)) await refreshChat();
        if (operation.kind === 'archive') await context().eventSource.emit(context().eventTypes.MESSAGE_DELETED, context().chat.length);
        await context().eventSource.emit('sideleaf:changed', { kind: operation.kind, chatId: context().chatId });
    } finally {
        busy = false; if (operation.kind !== 'edit' && operation.kind !== 'order') page = 0;
        view = 'archive';
        if (operation.kind === 'order') setSort('manual');
        if (readerReturn) { const target = archiveItems().find(x=>x.key===readerReturn); readerReturn = null; if (target) showReader(target); else render(); }
        else render();
    }
    note(operation.kind === 'archive' ? '선택한 메시지를 별지에 보관했습니다.' : ['edit','order'].includes(operation.kind) ? '변경 사항을 저장했습니다.' : '선택한 메시지를 채팅 끝에 복원했습니다.');
}

function close() {
    if (busy || pending) { note('저장을 확인한 뒤 닫아주세요.', true); return; }
    if (editing) { note('편집을 저장하거나 취소한 뒤 닫아주세요.', true); return; }
    clearTimeout(searchTimer);
    dialog?.close(); dialog?.remove(); dialog = null;
    snapshot = []; selected.clear(); search = '';
    reader = false; expanded.clear(); composing = false;
    editMode = false; readerKey = null; readerItems = []; readerReturn = null; readerRevision = null;
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
    sortMode = context().accountStorage?.getItem('sideleaf.sort') || sortMode;
    dialog = el('dialog', 'cd-dialog');
    dialog.id = 'sideleaf-dialog';
    dialog.setAttribute('aria-label', '별지');
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    document.body.append(dialog);
    applyChatAppearance();
    render(); dialog.showModal();
}

function render() {
    if (!dialog) return;
    if ((editing || reader || composing) && !busy) return;
    dialog.classList.remove('cd-reading');
    const ctx = context();
    const generating = isGenerating();
    let drawer;
    try { drawer = readDrawer(ctx.chatMetadata); } catch (error) { dialog.replaceChildren(el('p', '', error.message), button('닫기', close)); return; }
    const heading = el('header', 'cd-header');
    const title = el('div', 'cd-title');
    const name = el('h2', 'cd-brand', '별지'); name.prepend(icon('leaf'));
    title.append(name, el('p', 'cd-subtitle', String(ctx.chatId || '저장된 채팅을 먼저 열어주세요.')));
    const dismiss = iconButton('close', '닫기', close); dismiss.disabled = busy || Boolean(pending);
    const editToggle = iconButton(editMode ? 'check' : 'edit', editMode ? '편집 완료' : '편집 모드', () => { editMode=!editMode; selected.clear(); render(); });
    editToggle.disabled = busy || Boolean(pending); editToggle.setAttribute('aria-pressed',String(editMode));
    const actions = el('div','cd-actions'); actions.append(editToggle,dismiss); heading.append(title,actions);
    const nav = el('nav', 'cd-tabs'); nav.setAttribute('aria-label', '별지 보기');
    for (const [key, label] of [['archive', `보관함 ${drawer.items.length}`], ['select', '메시지 선택']]) {
        const tab = button(label, () => { view = key; page = 0; search = ''; selected.clear(); render(); });
        tab.setAttribute('aria-pressed', String(view === key)); tab.disabled = busy || Boolean(pending);
        nav.append(tab);
    }
    const toolbar = el('div', 'cd-toolbar');
    const input = el('input', 'cd-search'); input.type = 'search'; input.placeholder = '제목·내용·이름 검색'; input.setAttribute('aria-label', '내용·이름 검색'); input.value = search;
    input.disabled = busy || Boolean(pending);
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
    toolbar.append(input);
    if (view === 'archive' && editMode) {
        const sort = el('select','cd-sort'); sort.setAttribute('aria-label','메시지 정렬');
        for (const [value,label] of [['desc','최신순 ↓'],['asc','오래된순 ↑'],['manual','직접 정한 순서']]) { const option=el('option','',label); option.value=value; sort.append(option); }
        sort.value=sortMode; sort.disabled=busy || Boolean(pending); sort.addEventListener('change',()=>setSort(sort.value)); toolbar.append(sort);
    }
    const hint = el('p', 'cd-hint', view === 'archive'
        ? '이 채팅에서 보관한 메시지만 표시합니다. 복원하면 채팅 끝에 추가됩니다.'
        : '원하는 메시지만 골라 보관하세요. 보관한 메시지는 대화 화면과 이후 AI 대화 기록에서 빠집니다.');
    const list = el('div', 'cd-list'); list.setAttribute('aria-label', view === 'archive' ? '보관 메시지' : '선택할 메시지');
    if (view === 'select' && snapshot.length && (snapshot.length !== ctx.chat.length || snapshot.some((message, i) => message !== ctx.chat[i]))) selected.clear();
    snapshot = ctx.chat.slice();
    const items = view === 'archive'
        ? archiveItems()
        : ctx.chat.map((message, index) => ({ key: index, message, index })).reverse();
    const query = search.trim().toLocaleLowerCase();
    const filtered = query ? items.filter(matchesSearch) : items;
    if (editMode || view === 'select') {
        const all = iconButton('all','전체 선택', () => { filtered.forEach(item=>selected.add(item.key)); render(); });
        all.title='전체 선택 · 검색 결과 전체 페이지'; all.disabled=busy || Boolean(pending) || !filtered.length; toolbar.append(all);
    }
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    for (const item of filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) list.append(row(item));
    if (!filtered.length) list.append(el('p', 'cd-empty', query ? '검색 결과가 없습니다.' : view === 'archive' ? '아직 비어 있어요. 메시지 선택에서 필요한 내용만 보관하세요.' : '선택할 메시지가 없습니다.'));
    const pagination = el('div', 'cd-pagination');
    const previous = button('이전', () => { page--; render(); }); previous.disabled = page === 0 || busy || Boolean(pending);
    const next = button('다음', () => { page++; render(); }); next.disabled = page >= pages - 1 || busy || Boolean(pending);
    pagination.append(previous, el('span', '', `${page + 1} / ${pages}`), next);
    const footer = el('footer', 'cd-footer');
    footer.hidden = view === 'archive' && !editMode && !pending;
    const clear = iconButton('clear','선택 해제', () => { selected.clear(); render(); }); clear.disabled = !selected.size || busy || Boolean(pending);
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
    dialog.replaceChildren(heading, nav, toolbar, ...(editMode || view==='select' ? [hint] : []), list, pagination, footer, status);
}

function row(item, full = false) {
    const card = el('article', 'cd-card');
    const top = el('div', 'cd-card-top');
    const label = el('label', 'cd-pick');
    const check = el('input'); check.type = 'checkbox'; check.checked = selected.has(item.key); check.disabled = busy || Boolean(pending);
    check.setAttribute('aria-label', `메시지 #${item.index} 선택`);
    check.hidden = full || view === 'archive' && !editMode;
    check.addEventListener('change', () => {
        if (check.checked) selected.add(item.key); else selected.delete(item.key);
        const action = dialog.querySelector('.cd-action');
        action.textContent = `선택 ${selected.size}개 ${view === 'archive' ? '복원' : '보관'}`;
        action.disabled = !selected.size || busy || Boolean(pending) || !openedChat || isGenerating();
        dialog.querySelector('.cd-footer .cd-button').disabled = !selected.size;
    });
    label.append(check, el('strong', '', item.message.name || (item.message.is_user ? '사용자' : 'AI')), el('span', 'cd-number', `#${item.index}`));
    top.append(label);
    if (view==='archive' && editMode && !full) {
        const move = iconButton('move','순서 이동',()=>moveEditor(item)); move.disabled=busy||Boolean(pending);
        const grip = iconButton('grip','끌어서 순서 변경',()=>moveEditor(item)); grip.draggable = !busy && !pending;
        grip.addEventListener('dragstart', event=>{event.dataTransfer.setData('text/x-sideleaf',item.key);event.dataTransfer.effectAllowed='move';});
        card.addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('text/x-sideleaf')){event.preventDefault();card.classList.add('cd-drop-target');}});
        card.addEventListener('dragleave',()=>card.classList.remove('cd-drop-target'));
        card.addEventListener('drop',event=>{event.preventDefault();card.classList.remove('cd-drop-target');const from=event.dataTransfer.getData('text/x-sideleaf');const ids=archiveItems().map(x=>x.key);if(from && from!==item.key && ids.includes(from)){ids.splice(ids.indexOf(from),1);ids.splice(ids.indexOf(item.key),0,from);commit('order',{order:ids});}});
        top.append(grip,move);
    }
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
    details.addEventListener('toggle', () => {
        if (!details.isConnected) return;
        if (details.open) { if (!shown) appendText(); if (!full) expanded.add(item.key); }
        else expanded.delete(item.key);
    });
    if (full || expanded.has(item.key)) { details.open = true; appendText(); }
    if (view === 'archive') {
        const tools = el('div', 'cd-reader-tools');
        if (versions.length > 1) {
            const wrap = el('span','cd-version-wrap'); wrap.append(icon('language'));
            const select = el('select', 'cd-version'); select.setAttribute('aria-label', '읽을 본문');
            select.title = `본문 선택 · ${current.label}`;
            for (const version of versions) { const option = el('option', '', version.label); option.value = version.key; select.append(option); }
            select.addEventListener('change', () => { current = versions.find(v => v.key === select.value); select.title=`본문 선택 · ${current.label}`; fullText = current.text; shown = 0; body.replaceChildren(); appendText(); });
            wrap.append(select); tools.append(wrap);
        }
        if (!full) tools.append(iconButton('expand','크게 읽기', () => showReader(item)));
        tools.append(iconButton('copy','복사', () => copyText(current.text)));
        tools.append(iconButton('title','제목 수정', () => editItem(item, current.text, true)), iconButton('text','본문 수정', () => editItem(item, current.text)));
        details.insertBefore(tools, body);
    }
    if (full) { summary.hidden = true; card.append(details); }
    else card.append(top, details);
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

function editItem(item, text, titleOnly = false) {
    if (busy || pending) return;
    editing = item.key;
    clearTimeout(searchTimer);
    const wasReader = reader;
    if (wasReader) readerReturn = item.key;
    reader = false;
    const header = el('header', 'cd-header'); header.append(el('h2', '', '보관본 편집'));
    const titleLabel = el('label', 'cd-edit-label', '제목');
    const title = el('input', 'cd-search'); title.value = item.title || ''; title.maxLength = 160; title.setAttribute('aria-label', '제목'); titleLabel.append(title);
    const bodyLabel = el('label', 'cd-edit-label cd-edit-body', '읽기용 본문');
    const body = el('textarea', 'cd-editor'); body.value = text; body.setAttribute('aria-label', '읽기용 본문'); bodyLabel.append(body);
    const hint = el('p', 'cd-hint', '수정본은 별지에서 읽고 복사할 때 사용합니다. 원문·번역은 따로 보존하며, 채팅 복원은 원본 메시지를 사용합니다.');
    const footer = el('footer', 'cd-footer');
    footer.append(button('취소', () => { editing = null; readerReturn=null; if (wasReader) showReader(item); else render(); }), button('저장', () => commit('edit', {id:item.key, title:title.value, text:titleOnly || body.value === text ? undefined : body.value}), 'cd-primary'));
    const status = el('p', 'cd-status'); status.setAttribute('role', 'status');
    dialog.replaceChildren(header, titleLabel, ...(titleOnly ? [] : [bodyLabel, hint]), footer, status); title.focus();
}

function showReader(item) {
    clearTimeout(searchTimer);
    const revision = readDrawer(context().chatMetadata).revision;
    if (!reader || readerRevision !== revision) {
        readerItems = archiveItems().filter(matchesSearch);
        if (!readerItems.some(x=>x.key===item.key)) readerItems=archiveItems();
        readerRevision = revision;
    }
    reader = true;
    readerKey = item.key;
    dialog.classList.add('cd-reading');
    const heading = el('header', 'cd-header');
    const index=readerItems.findIndex(x=>x.key===item.key);
    const previous=iconButton('left','이전 메시지',()=>stepReader(-1)); previous.disabled=index<=0;
    const next=iconButton('right','다음 메시지',()=>stepReader(1)); next.disabled=index>=readerItems.length-1;
    const nav=el('div','cd-actions'); nav.append(previous,iconButton('list','메시지 목록',showReaderList),el('span','cd-reader-count',`${index+1} / ${readerItems.length}`),next);
    const controls=el('div','cd-actions');
    const editToggle=iconButton(editMode?'check':'edit',editMode?'편집 완료':'편집 모드',()=>{editMode=!editMode;showReader(item)});editToggle.setAttribute('aria-pressed',String(editMode));
    controls.append(editToggle,iconButton('close','큰 화면 닫기',()=>{reader=false;readerKey=null;dialog.classList.remove('cd-reading');render()}));
    heading.append(nav,controls);
    const content = el('div', 'cd-reading-content'); content.append(row(item, true));
    let touch;
    content.addEventListener('pointerdown',event=>{if(event.pointerType==='touch' && !event.target.closest('button,select,input,textarea'))touch={x:event.clientX,y:event.clientY};});
    content.addEventListener('pointercancel',()=>{touch=null});
    content.addEventListener('pointerup',event=>{if(!touch)return;const dx=event.clientX-touch.x,dy=event.clientY-touch.y;touch=null;if(Math.abs(dx)>70 && Math.abs(dx)>Math.abs(dy)*1.5)stepReader(dx<0?1:-1);});
    content.tabIndex=0;
    content.addEventListener('keydown',event=>{if(event.target.closest('button,select,input,textarea'))return;if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();stepReader(event.key==='ArrowRight'?1:-1);}});
    const status = el('p', 'cd-status'); status.setAttribute('role', 'status');
    dialog.replaceChildren(heading, content, status); content.scrollTop = 0;
    content.focus({preventScroll:true});
}

function stepReader(direction) {
    const index=readerItems.findIndex(x=>x.key===readerKey), next=readerItems[index+direction];
    if (!next) return;
    showReader(next);
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) dialog.querySelector('.cd-reading-content').animate([{opacity:.4,transform:`translateX(${direction*24}px)`},{opacity:1,transform:'translateX(0)'}],{duration:140});
}

function showReaderList() {
    if (dialog.querySelector('.cd-jump')) return;
    const popup=el('section','cd-jump'); popup.setAttribute('role','dialog');popup.setAttribute('aria-label','메시지 목록');
    const input=el('input','cd-search');input.type='search';input.placeholder='목록에서 찾기';input.setAttribute('aria-label','목록에서 찾기');
    const list=el('div','cd-jump-items');let offset=0;
    const draw=()=>{const found=readerItems.filter(x=>`${x.title||''} ${readingVersions(x)[0].text}`.toLocaleLowerCase().includes(input.value.toLocaleLowerCase()));list.replaceChildren();
        for(const item of found.slice(offset,offset+PAGE_SIZE)){const entry=button(item.title||preview({mes:readingVersions(item)[0].text},80),()=>showReader(item));if(item.key===readerKey)entry.setAttribute('aria-current','true');list.append(entry)}
        const pages=el('div','cd-actions');const prev=iconButton('left','목록 이전 페이지',()=>{offset-=PAGE_SIZE;draw()});prev.disabled=offset===0;const next=iconButton('right','목록 다음 페이지',()=>{offset+=PAGE_SIZE;draw()});next.disabled=offset+PAGE_SIZE>=found.length;pages.append(prev,el('span','',`${Math.floor(offset/PAGE_SIZE)+1} / ${Math.max(1,Math.ceil(found.length/PAGE_SIZE))}`),next);list.append(pages);
    };
    input.addEventListener('input',()=>{offset=0;draw()});
    const header=el('div','cd-actions');header.append(input,iconButton('close','목록 팝업 닫기',()=>{popup.remove();dialog.querySelector('.cd-reading-content').focus()}));
    popup.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();popup.remove();dialog.querySelector('.cd-reading-content').focus()}});
    popup.append(header,list);dialog.append(popup);draw();input.focus();
}

function moveEditor(item) {
    if(busy||pending)return;
    editing=item.key;const ids=archiveItems().map(x=>x.key);
    const label=el('label','cd-edit-label','이동할 위치');const input=el('input','cd-search');input.type='number';input.min='1';input.max=String(ids.length);input.value=String(ids.indexOf(item.key)+1);input.setAttribute('aria-label','이동할 위치');label.append(input);
    const save=()=>{const n=Number(input.value);if(!Number.isInteger(n)||n<1||n>ids.length){input.reportValidity();return;}ids.splice(ids.indexOf(item.key),1);ids.splice(n-1,0,item.key);commit('order',{order:ids});};
    dialog.replaceChildren(el('h2','','순서 이동'),label,el('p','cd-hint',`전체 보관함의 1~${ids.length}번째 위치입니다.`),button('취소',()=>{editing=null;render()}),button('저장',save),el('p','cd-status'));
    input.focus();input.select();
}

function applyChatAppearance() {
    const chat = document.querySelector('#chat');
    if (!chat) return;
    const text = getComputedStyle(chat.querySelector('.mes_text') || chat);
    for (const [name, value] of Object.entries({color:text.color, 'font-family':text.fontFamily, 'font-size':text.fontSize, 'line-height':text.lineHeight, 'letter-spacing':text.letterSpacing})) dialog.style.setProperty(name, value);
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
    dialog.style.backgroundColor = color || '#20212b';
    dialog.style.backgroundImage = layers.length ? layers.join(',') : 'none';
    dialog.style.backgroundSize = 'cover'; dialog.style.backgroundPosition = 'center';
    const message = chat.querySelector('.mes');
    if (message) dialog.style.setProperty('--sideleaf-message-bg', getComputedStyle(message).backgroundColor);
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
        const entry = el('button', 'sideleaf-archive-button mes_button'); entry.append(icon('leaf'));
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
    entry.prepend(icon('leaf'));
    container.append(entry); menu.append(container);
    const ctx = context();
    installQrSource(context);
    const on = (type, handler) => { if (ctx.eventTypes[type]) ctx.eventSource.on(ctx.eventTypes[type], handler); };
    let buttonsQueued = false;
    const queueButtons = () => { if (buttonsQueued) return; buttonsQueued = true; requestAnimationFrame(() => { buttonsQueued = false; addMessageButtons(); }); };
    for (const event of ['CHAT_CHANGED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MORE_MESSAGES_LOADED']) on(event, queueButtons);
    addMessageButtons();
    // Preview/dry-run generation also emits STARTED, sometimes without ENDED.
    // Read the core state instead of keeping a potentially stale event latch.
    const updateGeneration = () => { if (dialog) setTimeout(() => { if (dialog && !document.activeElement?.matches('.cd-search')) render(); }, 0); };
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
