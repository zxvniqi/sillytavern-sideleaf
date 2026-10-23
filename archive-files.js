import {KEY, readDrawer} from './model.js';

const FILE = /^sideleaf-(?:pack|index)-[a-zA-Z0-9-]+\.json$/;
const pathFor = name => { if (!FILE.test(name)) throw new Error('별지 파일 연결 정보가 올바르지 않습니다.'); return `/user/files/${name}`; };
const refValid = ref => ref && FILE.test(ref.file) && Number.isInteger(ref.slot) && ref.slot >= 0;

export function portableChat(ctx, drawer) {
    return [{user_name:ctx.name1, character_name:ctx.name2, chat_metadata:{...ctx.chatMetadata,[KEY]:drawer}}, ...ctx.chat];
}

// Immutable indexes let branches/exported pointers keep their original archive.
// Unchanged message payloads are reused, including after a title/order edit.
export class ArchiveFiles {
    constructor({request = (...args)=>fetch(...args), headers, uuid}) {
        this.request=request; this.headers=headers; this.uuid=uuid; this.clear();
    }
    clear() { this.generation=(this.generation||0)+1; this.payloadRefs=new WeakMap(); this.editRefs=new Map(); }
    async read(name) {
        const response=await this.request(pathFor(name),{headers:this.headers(),cache:'no-store',signal:AbortSignal.timeout(30000)});
        if (!response.ok) throw new Error('별지 파일을 읽지 못했습니다. 연결 또는 서버 백업을 확인해주세요.');
        return response.json();
    }
    async write(kind,data) {
        const name=`sideleaf-${kind}-${this.uuid()}.json`; pathFor(name);
        const json=JSON.stringify(data), bytes=new TextEncoder().encode(json), chunks=[];
        for(let i=0;i<bytes.length;i+=16384) chunks.push(String.fromCharCode(...bytes.subarray(i,i+16384)));
        const response=await this.request('/api/files/upload',{method:'POST',headers:this.headers(),signal:AbortSignal.timeout(30000),body:JSON.stringify({name,data:btoa(chunks.join(''))})});
        if(!response.ok) throw new Error('별지 분리 파일 저장에 실패했습니다. 채팅은 변경하지 않았습니다.');
        const saved=await this.read(name);
        if(JSON.stringify(saved)!==json) throw new Error('별지 파일 내용을 검증하지 못했습니다. 채팅은 변경하지 않았습니다.');
        return name;
    }
    async load(metadata) {
        const generation=this.generation;
        const pointer=metadata?.[KEY];
        if(pointer?.version!==2) return readDrawer(metadata);
        pathFor(pointer.file);
        const index=await this.read(pointer.file);
        if(index.format!=='sideleaf-index-1'||index.drawer?.revision!==pointer.revision||!Array.isArray(index.entries)||index.entries.length!==pointer.count) throw new Error('별지 목록과 채팅의 연결 정보가 일치하지 않습니다.');
        const names=new Set();
        for(const entry of index.entries){
            if(!entry.data?.id || !refValid(entry.payload) || entry.edit && !refValid(entry.edit)) throw new Error('별지 본문 연결 정보가 올바르지 않습니다.');
            names.add(entry.payload.file);if(entry.edit)names.add(entry.edit.file);
        }
        const packs=new Map(), queue=[...names];
        await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{while(queue.length){const name=queue.shift(),pack=await this.read(name);if(pack.format!=='sideleaf-pack-1'||!Array.isArray(pack.values))throw new Error('지원하지 않는 별지 본문 파일입니다.');packs.set(name,pack.values);}}));
        const items=index.entries.map(entry=>{
            const payload=packs.get(entry.payload.file)[entry.payload.slot];
            if(payload?.kind!=='message'||!payload.message||typeof payload.message!=='object')throw new Error('별지 원문을 찾지 못했습니다.');
            const {kind,...body}=payload, item={...entry.data,...body};
            if(generation===this.generation) this.payloadRefs.set(item.message,{ref:entry.payload,screenText:item.screenText,screenTextComplete:item.screenTextComplete});
            if(entry.edit){const edit=packs.get(entry.edit.file)[entry.edit.slot];if(edit?.kind!=='edit'||typeof edit.text!=='string')throw new Error('별지 수정문을 찾지 못했습니다.');item.editedText=edit.text;if(generation===this.generation)this.editRefs.set(item.id,{text:edit.text,ref:entry.edit});}
            return item;
        });
        if(new Set(items.map(x=>x.id)).size!==items.length)throw new Error('별지 목록에 중복 연결이 있습니다.');
        return readDrawer({[KEY]:{...index.drawer,items}});
    }
    async save(drawer) {
        const values=[], remember=[];
        const entries=drawer.items.map(item=>{
            const {message,screenText,screenTextComplete,editedText,...data}=item;
            let payload=this.payloadRefs.get(message);
            if(!payload || payload.screenText!==screenText || payload.screenTextComplete!==screenTextComplete){
                const ref={file:'',slot:values.length};
                values.push({kind:'message',message,...(screenText===undefined?{}:{screenText}),...(screenTextComplete===undefined?{}:{screenTextComplete})});
                payload={ref,screenText,screenTextComplete};remember.push(()=>this.payloadRefs.set(message,payload));
            }
            const entry={data,payload:payload.ref};
            if(typeof editedText==='string'){
                let edit=this.editRefs.get(item.id);
                if(!edit || edit.text!==editedText){edit={text:editedText,ref:{file:'',slot:values.length}};values.push({kind:'edit',text:editedText});remember.push(()=>this.editRefs.set(item.id,edit));}
                entry.edit=edit.ref;
            }
            return entry;
        });
        if(values.length){
            const pack=await this.write('pack',{format:'sideleaf-pack-1',values});
            for(const entry of entries){if(!entry.payload.file)entry.payload.file=pack;if(entry.edit&&!entry.edit.file)entry.edit.file=pack;}
            for(const apply of remember)apply();
        }
        const {items,...metadata}=drawer;
        const file=await this.write('index',{format:'sideleaf-index-1',drawer:metadata,entries});
        return {version:2,revision:drawer.revision,file,count:items.length};
    }
}
