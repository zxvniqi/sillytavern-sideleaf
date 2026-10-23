import test from 'node:test';
import assert from 'node:assert/strict';
import {ArchiveFiles, portableChat} from './archive-files.js';
import {KEY, editPlan, restorePlan, readDrawer} from './model.js';

function fixture() {
    let seq=0, fail=false;
    const disk=new Map(), calls=[];
    const request=async(url,options={})=>{
        calls.push({url,method:options.method||'GET'});
        if(fail) return new Response('',{status:500});
        if(url==='/api/files/upload') {
            const body=JSON.parse(options.body);
            disk.set(body.name,JSON.parse(Buffer.from(body.data,'base64').toString('utf8')));
            return Response.json({path:`user/files/${body.name}`});
        }
        const value=disk.get(url.split('/').pop());
        return value ? Response.json(value) : new Response('',{status:404});
    };
    const make=()=>new ArchiveFiles({request,headers:()=>({}),uuid:()=>String(++seq)});
    return {disk,calls,make,fail:()=>{fail=true;}};
}
const drawer=()=>({version:1,revision:'r1',order:['a'],items:[{id:'a',originalIndex:1,archivedAt:1,title:'주제',message:{name:'가상 화자',mes:'原文 🌿',swipes:['原文','대안'],extra:{display_text:'번역문',custom:{keep:true}}},screenText:'화면',screenTextComplete:true,editedText:'수정문'}]});

test('lazy files: no requests before open/save, inline data reads locally, complete portable roundtrip',async()=>{
    const f=fixture(),store=f.make(),d=drawer();
    assert.equal(f.calls.length,0);
    assert.deepEqual(await store.load({[KEY]:d}),d);
    assert.equal(f.calls.length,0);
    const pointer=await store.save(d);
    assert.equal(pointer.version,2);assert.equal(pointer.count,1);assert.equal(pointer.items,undefined);
    assert.ok(JSON.stringify(pointer).length<200);
    const loaded=await f.make().load({[KEY]:pointer});assert.deepEqual(loaded,d);
    const exported=portableChat({name1:'QA',name2:'QA',chatMetadata:{other:'keep',[KEY]:pointer},chat:[{mes:'active'}]},loaded);
    const imported=exported.map(line=>JSON.parse(JSON.stringify(line)));
    assert.deepEqual(readDrawer(imported[0].chat_metadata),d);
    assert.equal(imported[0].chat_metadata.other,'keep');assert.equal(imported[1].mes,'active');
    const emptyServer=fixture();assert.deepEqual(await emptyServer.make().load(imported[0].chat_metadata),d);assert.equal(emptyServer.calls.length,0);
});
test('title/order saves reuse payloads; earlier branch keeps its own title',async()=>{
    const f=fixture(),store=f.make(),d=drawer(),original=await store.save(d);
    const before=f.disk.size;
    const changed=editPlan([],d,'a','새 제목',undefined,()=> 'r2').drawer;
    changed.order=['a'];
    const pointer=await store.save(changed);
    assert.equal(f.disk.size-before,1);
    assert.equal((await f.make().load({[KEY]:original})).items[0].title,'주제');
    assert.equal((await f.make().load({[KEY]:pointer})).items[0].title,'새 제목');
    assert.deepEqual(f.disk.get(original.file).entries[0].payload,f.disk.get(pointer.file).entries[0].payload);
});
test('editing body saves only new edit, adding a message saves only new payload',async()=>{
    const f=fixture(),store=f.make(),d=drawer(),first=await store.save(d);
    const changed=editPlan([],d,'a','주제','새 수정문',()=> 'r2').drawer;
    const second=await store.save(changed),index=f.disk.get(second.file);
    assert.deepEqual(index.entries[0].payload,f.disk.get(first.file).entries[0].payload);
    assert.deepEqual(f.disk.get(index.entries[0].edit.file).values,[{kind:'edit',text:'새 수정문'}]);
    const added={id:'b',originalIndex:2,archivedAt:2,message:{mes:'new'}};
    const third=await store.save({...changed,revision:'r3',items:[...changed.items,added]});
    const refs=f.disk.get(third.file).entries;
    assert.deepEqual(f.disk.get(refs[1].payload.file).values,[{kind:'message',message:added.message}]);
    const restored=restorePlan([],await f.make().load({[KEY]:third}),['a'],()=> 'r4');
    assert.deepEqual(restored.chat[0],d.items[0].message);
});
test('failed upload and missing/corrupt files never change source drawer',async()=>{
    const f=fixture(),d=drawer(),before=structuredClone(d),store=f.make(),pointer=await store.save(d);
    f.disk.delete(f.disk.get(pointer.file).entries[0].payload.file);
    await assert.rejects(store.load({[KEY]:pointer}),/읽지 못/);
    f.fail();await assert.rejects(store.save(d),/저장에 실패/);
    assert.deepEqual(d,before);
});
test('reject external paths, mismatched revisions and bad payload slots',async()=>{
    const f=fixture(),store=f.make(),pointer=await store.save(drawer());
    await assert.rejects(store.load({[KEY]:{...pointer,file:'https://example.com/private'}}),/연결 정보/);
    await assert.rejects(store.load({[KEY]:{...pointer,revision:'wrong'}}),/일치/);
    f.disk.get(pointer.file).entries[0].payload.slot=999;
    await assert.rejects(store.load({[KEY]:pointer}),/원문/);
});
test('readback corruption is detected before returning a pointer',async()=>{
    const store=new ArchiveFiles({uuid:()=> '1',headers:()=>({}),request:async(url)=>Response.json(url==='/api/files/upload'?{}:{changed:true})});
    await assert.rejects(store.save(drawer()),/검증하지 못/);
});
