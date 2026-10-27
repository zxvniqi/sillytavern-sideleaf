import test from 'node:test';
import assert from 'node:assert/strict';
import { installQrSource } from './qr-source.js';

function fixture() {
    const listeners = new Map(), events = new Map();
    let active = false, observer, clock = 1_000_000;
    const form = {classList:{contains:()=>active}};
    const selectors = {qr:'.qr--button', ctx:'.ctx-menu .ctx-item', send_but:'#send_but', popup:'.popup', ok:'.popup-button-ok'};
    class FakeElement {
        constructor(kind, value = 'Synthetic topic') {this.kind=kind;this.id=kind;this.value=value;}
        closest(selector) { if (this.kind==='ok' && selector==='.popup') return new FakeElement('popup', this.value); return selector.split(',').some(s=>s.trim()===selectors[this.kind]) ? this : null; }
        matches(selector) { return this.kind==='popup' ? selector.includes('dialog.popup') : this.kind==='input' && selector.includes('.popup-input'); }
        querySelector(selector) { return selector.includes('qr--button-label') ? {textContent:this.kind==='ctx'?'Menu QR':'Synthetic QR'} : {value:this.value,getClientRects:()=>[{}]}; }
    }
    const old = {document:globalThis.document,Element:globalThis.Element,MutationObserver:globalThis.MutationObserver,now:Date.now};
    globalThis.Element=FakeElement;
    Date.now=()=>clock;
    globalThis.document={addEventListener:(type,fn)=>{const list=listeners.get(type)||[];list.push(fn);listeners.set(type,list);},getElementById:id=>id==='form_sheld'?form:null,querySelector:()=>null};
    globalThis.MutationObserver=class {constructor(fn){this.fn=fn;observer=this;}observe(){}disconnect(){this.disconnected=true;}};
    const ctx={chatId:'synthetic',groupId:'group',chat:[{mes:'existing',extra:{}}],substituteParams:text=>text.replace('{{char}}','Hero'),eventTypes:Object.fromEntries(['MESSAGE_RECEIVED','MESSAGE_SENT','CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED','CHAT_CHANGED','GENERATION_STOPPED','GENERATION_ENDED'].map(k=>[k,k])),eventSource:{on:(type,fn)=>events.set(type,fn)}};
    installQrSource(()=>ctx);
    const fire=(type,event)=>listeners.get(type)?.forEach(fn=>fn(event));
    const click=(kind,isTrusted=true,value)=>fire('click',{target:new FakeElement(kind,value),isTrusted});
    const emit=(type,value)=>events.get(type)?.(value);
    const append=(is_user=false)=>{ctx.chat.push({mes:'result',is_user,extra:{}});return ctx.chat.length-1;};
    return {ctx,click,emit,append,fire,FakeElement,wait:ms=>{clock+=ms;},setActive:value=>{active=value;},mutation:oldValue=>observer.fn([{oldValue}]),observer:()=>observer,
        cleanup:()=>{Date.now=old.now;for(const [key,value] of Object.entries(old))if(key!=='now'){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}};
}

test('native QR programmatic send retains its title, including user output',()=>{
    const f=fixture();try {
        f.click('qr');f.click('send_but',false);
        const i=f.append(true);f.emit('MESSAGE_SENT',i);
        assert.equal(f.ctx.chat[i].extra.sideleafSource.label,'Synthetic QR');
        f.emit('MESSAGE_RECEIVED',0);assert.equal(f.ctx.chat[0].extra.sideleafSource,undefined);
    }finally{f.cleanup();}
});

test('QR generate-then-append survives generation end and stops shortly after the script ends',()=>{
    const f=fixture();try {
        f.click('qr');f.setActive(true);f.mutation('');
        f.emit('GENERATION_ENDED');f.wait(60_000);const i=f.append();f.emit('MESSAGE_RECEIVED',i);
        assert.equal(f.ctx.chat[i].extra.sideleafSource.label,'Synthetic QR');
        f.setActive(false);f.mutation('isExecutingCommandsFromChatInput');
        const late=f.append();f.emit('MESSAGE_RECEIVED',late);
        assert.equal(f.ctx.chat[late].extra.sideleafSource.label,'Synthetic QR','output right after the script still counts');
        f.wait(5000);const next=f.append();f.emit('MESSAGE_RECEIVED',next);
        assert.equal(f.ctx.chat[next].extra.sideleafSource,undefined);
        assert.equal(f.observer().disconnected,true);
    }finally{f.cleanup();}
});

test('QR runs without a visible running state keep the result that follows the generation',()=>{
    const f=fixture();try {
        f.click('ctx');f.emit('GENERATION_ENDED');
        const i=f.append();f.emit('USER_MESSAGE_RENDERED',i);
        assert.equal(f.ctx.chat[i].extra.sideleafSource.label,'Menu QR');
    }finally{f.cleanup();}
});

test('input from a popup closed without a click, with macros resolved',()=>{
    const f=fixture();try {
        f.click('qr');
        const input=new f.FakeElement('input','{{char}}의 하루');
        f.fire('input',{target:input,isTrusted:false});
        f.fire('close',{target:new f.FakeElement('popup','')});
        const i=f.append();f.emit('MESSAGE_RECEIVED',i);
        assert.deepEqual(f.ctx.chat[i].extra.sideleafSource,{label:'Synthetic QR',subject:'Hero의 하루'});
    }finally{f.cleanup();}
});

test('manual send, chat switch and stopped generation cannot inherit QR title',()=>{
    for(const stop of ['manual','typing','CHAT_CHANGED','GENERATION_STOPPED','GENERATION_ENDED']){
        const f=fixture();try {
            f.click('qr');
            if(stop==='manual')f.click('send_but',true);
            else if(stop==='typing')f.fire('input',{target:{id:'send_textarea'},isTrusted:true});
            else f.emit(stop);
            if(stop==='GENERATION_ENDED')f.wait(5000);
            const i=f.append();f.emit('CHARACTER_MESSAGE_RENDERED',i);
            assert.equal(f.ctx.chat[i].extra.sideleafSource,undefined,stop);
        }finally{f.cleanup();}
    }
});
