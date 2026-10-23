import { chatIdentity } from './model.js';

// Observe native QR UI only. Do not replace QR functions or read QR scripts.
export function installQrSource(getContext) {
    let run = null;
    const valid = () => run && Date.now() - run.started < 10 * 60_000 && run.chat === chatIdentity(getContext());
    document.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const qr = target.closest('.qr--button');
        if (qr && !event.ctrlKey && !target.closest('.qr--button-expander')) {
            const label = qr.querySelector('.qr--button-label')?.textContent?.trim();
            const ctx = getContext();
            run = label && chatIdentity(ctx) ? { label:label.slice(0,160), subject:'', chat:chatIdentity(ctx), started:Date.now(), existing:new WeakSet(ctx.chat.filter(x=>x && typeof x==='object')) } : null;
            return;
        }
        if (!valid()) { run = null; return; }
        if (target.closest('.popup-button-cancel, #send_but')) { run = null; return; }
        if (target.closest('.popup-button-ok')) captureInput(target.closest('.popup'));
    }, true);
    function captureInput(popup) {
        if (!valid() || run.subject || !popup) return;
        const input = popup.querySelector('textarea.popup-input, input.popup-input:not([type="password"]):not([type="hidden"])');
        if (input && input.getClientRects().length && input.value.trim()) run.subject = input.value.trim().slice(0,160);
    }
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && valid() && event.target.closest?.('.popup')) run = null;
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey && event.target.matches?.('.popup-input, .popup-button-ok')) {
            const popup = event.target.closest('.popup');
            // Native Popup marks accepted keyboard submissions as closing. A
            // newline in a multiline input must not freeze a half-written title.
            queueMicrotask(() => { if (popup?.hasAttribute('closing')) captureInput(popup); });
        }
    }, true);
    document.addEventListener('input', event => { if (event.isTrusted && event.target.id === 'send_textarea') run = null; }, true);
    const ctx = getContext();
    const tagMessage = index => {
        if (!valid()) { run = null; return; }
        const message = getContext().chat[Number(index)];
        if (!message || message.is_user || run.existing.has(message)) return;
        message.extra ??= {};
        message.extra.sideleafSource ??= {label:run.label, ...(run.subject ? {subject:run.subject} : {})};
        // Native message saving persists this field with the message.
    };
    for (const event of ['MESSAGE_RECEIVED','CHARACTER_MESSAGE_RENDERED']) if (ctx.eventTypes[event]) ctx.eventSource.on(ctx.eventTypes[event], tagMessage);
    for (const event of ['CHAT_CHANGED','GENERATION_STOPPED','GENERATION_ENDED']) if (ctx.eventTypes[event]) ctx.eventSource.on(ctx.eventTypes[event], () => { run = null; });
}
