import { chatIdentity } from './model.js';

// After the QR script itself is no longer visibly running, messages arriving this soon still count as
// its output (a QR run outside the chat input, e.g. from the editor, shows no running state at all).
const GRACE_MS = 3000;
const LIMIT_MS = 30 * 60_000;

// Observe native QR UI only. Do not replace QR functions or read QR scripts.
export function installQrSource(getContext) {
    let run = null;
    let observer = null;
    const stop = () => { run = null; observer?.disconnect(); observer = null; };
    const scriptActive = () => document.getElementById('form_sheld')?.classList.contains('isExecutingCommandsFromChatInput');
    const popupOpen = () => Boolean(document.querySelector('dialog.popup[open]'));
    const valid = () => run && Date.now() - run.started < LIMIT_MS && run.chat === chatIdentity(getContext())
        && (!run.endsAt || Date.now() < run.endsAt || scriptActive() || popupOpen());
    // A finished script or generation does not end the run at once: the result is often appended right after.
    const settle = () => { if (run && !scriptActive()) run.endsAt = Date.now() + GRACE_MS; };
    const start = label => {
        stop();
        const ctx = getContext();
        label = String(label ?? '').replace(/\s+/g, ' ').trim();
        if (!label || !chatIdentity(ctx)) return;
        run = { label:label.slice(0,160), subject:'', draft:'', chat:chatIdentity(ctx), started:Date.now(), endsAt:0, existing:new WeakSet(ctx.chat.filter(x=>x && typeof x==='object')) };
        // A QR can generate first and append its result afterwards. Observe
        // only this native class during this run, never the chat subtree.
        const form = document.getElementById('form_sheld');
        if (!form) return;
        let started = false;
        observer = new MutationObserver(records => {
            if (!valid()) { stop(); return; }
            started ||= scriptActive() || records.some(r => r.oldValue?.split(/\s+/).includes('isExecutingCommandsFromChatInput'));
            if (started && !scriptActive()) settle();
        });
        observer.observe(form, {attributes:true, attributeFilter:['class'], attributeOldValue:true});
    };
    const labelOf = node => (node.querySelector('.qr--button-label') || node).textContent;
    document.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        // QR bar and pop-out buttons (not the ⋮ expander), context-menu entries, and the editor's run button.
        const qr = target.closest('.qr--button');
        if (qr && !event.ctrlKey && !target.closest('.qr--button-expander')) { start(labelOf(qr)); return; }
        const item = target.closest('.ctx-menu .ctx-item');
        if (item && !target.closest('.ctx-expander')) { start(labelOf(item)); return; }
        if (target.closest('#qr--modal-execute')) { start(document.getElementById('qr--modal-label')?.value); return; }
        if (!valid()) { stop(); return; }
        // QR itself calls send_but.click(); only a person's new send ends it.
        if (target.closest('.popup-button-cancel') || event.isTrusted && target.closest('#send_but, #mes_stop')) { stop(); return; }
        if (target.closest('.popup-button-ok')) captureInput(target.closest('.popup'));
    }, true);
    const inputOf = popup => popup?.querySelector('textarea.popup-input, input.popup-input:not([type="password"]):not([type="hidden"])');
    function captureInput(popup) {
        if (!valid() || run.subject || !popup) return;
        const input = inputOf(popup);
        if (input && input.getClientRects().length && input.value.trim()) run.subject = input.value.trim().slice(0,160);
    }
    // Inputs filled by helper scripts and popups closed without a click (keyboard, scripts) are read
    // from the last value the input held; a cancelled popup has already ended the run.
    document.addEventListener('input', event => {
        if (event.isTrusted && event.target.id === 'send_textarea') { stop(); return; }
        if (run && !run.subject && event.target.matches?.('.popup-input')) run.draft = String(event.target.value ?? '').trim().slice(0,160);
    }, true);
    document.addEventListener('close', event => {
        if (!run || run.subject || !event.target.matches?.('dialog.popup')) return;
        const input = inputOf(event.target);
        const value = (input?.value ?? '').trim() || run.draft;
        if (valid() && value) run.subject = value.slice(0,160);
        if (run) run.draft = '';
    }, true);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && valid() && event.target.closest?.('.popup')) stop();
        if (event.isTrusted && event.key === 'Enter' && event.target.id === 'send_textarea' && !event.shiftKey) stop();
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey && event.target.matches?.('.popup-input, .popup-button-ok')) {
            const popup = event.target.closest('.popup');
            // Native Popup marks accepted keyboard submissions as closing. A
            // newline in a multiline input must not freeze a half-written title.
            queueMicrotask(() => { if (popup?.hasAttribute('closing')) captureInput(popup); });
        }
    }, true);
    const ctx = getContext();
    const tagMessage = index => {
        if (!valid()) { stop(); return; }
        const message = getContext().chat[Number(index)];
        if (!message || run.existing.has(message)) return;
        message.extra ??= {};
        // Inputs may hold macros such as {{char}}; the title shows what they stood for.
        let subject = run.subject;
        try { if (subject && typeof getContext().substituteParams === 'function') subject = String(getContext().substituteParams(subject)).trim() || subject; } catch { /* keep the raw input */ }
        message.extra.sideleafSource ??= {label:run.label, ...(subject ? {subject:subject.slice(0,160)} : {})};
        // Native message saving persists this field with the message.
    };
    for (const event of ['MESSAGE_RECEIVED','MESSAGE_SENT','CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED']) if (ctx.eventTypes[event]) ctx.eventSource.on(ctx.eventTypes[event], tagMessage);
    if (ctx.eventTypes.CHAT_CHANGED) ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, stop);
    // A person pressing Stop ends the run; a stop inside a still-running script (or by another extension) does not.
    if (ctx.eventTypes.GENERATION_STOPPED) ctx.eventSource.on(ctx.eventTypes.GENERATION_STOPPED, () => { if (!scriptActive()) stop(); });
    if (ctx.eventTypes.GENERATION_ENDED) ctx.eventSource.on(ctx.eventTypes.GENERATION_ENDED, settle);
}
