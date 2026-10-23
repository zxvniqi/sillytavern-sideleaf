import test from 'node:test';
import assert from 'node:assert/strict';
import { installQrSource } from './qr-source.js';

function fixture() {
    const listeners = new Map(), events = new Map();
    let active = false, observer;
    const form = {classList:{contains:()=>active}};
    class FakeElement {
        constructor(kind) {this.kind=kind;this.id=kind;}
        closest(selector) { return selector.split(',').some(s=>s.trim()===({qr:'.qr--button',send_but:'#send_but',popup:'.popup'}[this.kind])) ? this : null; }
        querySelector() { return this.kind==='qr' ? {textContent:'Synthetic QR'} : {value:'Synthetic topic',getClientRects:()=>[{}]}; }
    }
    const old = {document:globalThis.document,Element:globalThis.Element,MutationObserver:globalThis.MutationObserver};
    globalThis.Element=FakeElement;
    globalThis.document={addEventListener:(type,fn)=>{const list=listeners.get(type)||[];list.push(fn);listeners.set(type,list);},getElementById:id=>id==='form_sheld'?form:null};
    globalThis.MutationObserver=class {constructor(fn){this.fn=fn;observer=this;}observe(){}disconnect(){this.disconnected=true;}};
    const ctx={chatId:'synthetic',groupId:'group',chat:[{mes:'existing',extra:{}}],eventTypes:Object.fromEntries(['MESSAGE_RECEIVED','MESSAGE_SENT','CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED','CHAT_CHANGED','GENERATION_STOPPED','GENERATION_ENDED'].map(k=>[k,k])),eventSource:{on:(type,fn)=>events.set(type,fn)}};
    installQrSource(()=>ctx);
    const click=(kind,isTrusted=true)=>listeners.get('click').forEach(fn=>fn({target:new FakeElement(kind),isTrusted}));
    const emit=(type,value)=>events.get(type)?.(value);
    const append=(is_user=false)=>{ctx.chat.push({mes:'result',is_user,extra:{}});return ctx.chat.length-1;};
    return {ctx,click,emit,append,setActive:value=>{active=value;},mutation:oldValue=>observer.fn([{oldValue}]),observer:()=>observer,
        cleanup:()=>{for(const [key,value] of Object.entries(old))if(value===undefined)delete globalThis[key];else globalThis[key]=value;}};
}

test('native QR programmatic send retains its title, including user output',()=>{
    const f=fixture();try {
        f.click('qr');f.click('send_but',false);
        const i=f.append(true);f.emit('MESSAGE_SENT',i);
        assert.equal(f.ctx.chat[i].extra.sideleafSource.label,'Synthetic QR');
        f.emit('MESSAGE_RECEIVED',0);assert.equal(f.ctx.chat[0].extra.sideleafSource,undefined);
    }finally{f.cleanup();}
});

test('QR generate-then-append survives generation end and stops at script end',()=>{
    const f=fixture();try {
        f.click('qr');f.setActive(true);f.mutation('');
        f.emit('GENERATION_ENDED');const i=f.append();f.emit('MESSAGE_RECEIVED',i);
        assert.equal(f.ctx.chat[i].extra.sideleafSource.label,'Synthetic QR');
        f.setActive(false);f.mutation('isExecutingCommandsFromChatInput');
        const next=f.append();f.emit('MESSAGE_RECEIVED',next);
        assert.equal(f.ctx.chat[next].extra.sideleafSource,undefined);
        assert.equal(f.observer().disconnected,true);
    }finally{f.cleanup();}
});

test('manual send, chat switch and stopped generation cannot inherit QR title',()=>{
    for(const stop of ['manual','CHAT_CHANGED','GENERATION_STOPPED','GENERATION_ENDED']){
        const f=fixture();try {
            f.click('qr');if(stop==='manual')f.click('send_but',true);else f.emit(stop);
            const i=f.append();f.emit('CHARACTER_MESSAGE_RENDERED',i);
            assert.equal(f.ctx.chat[i].extra.sideleafSource,undefined,stop);
        }finally{f.cleanup();}
    }
});
