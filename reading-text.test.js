import test from 'node:test';
import assert from 'node:assert/strict';
import {readableText} from './reading-text.js';
const text=s=>({nodeType:3,textContent:s});
const element=(name,...children)=>({nodeType:1,nodeName:name,childNodes:children});
test('closed nested details include their complete body without scripts or controls',()=>{
 const tree=element('DIV',element('DETAILS',element('SUMMARY',text('Heading')),element('P',text('First paragraph')),element('DETAILS',element('SUMMARY',text('Nested')),element('P',text('Second paragraph')))),element('STYLE',text('css')),element('SCRIPT',text('script')),element('BUTTON',text('control')));
 assert.equal(readableText(tree),'Heading\n\nFirst paragraph\n\nNested\n\nSecond paragraph');
});
