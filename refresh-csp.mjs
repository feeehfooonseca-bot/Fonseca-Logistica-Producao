// Run after changes to any inline JavaScript in index.html.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const html=await readFile(new URL('./index.html',import.meta.url),'utf8');
const hashes=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].filter(([,attrs])=>!attrs.includes('src=')&&!attrs.includes('ld+json')).map(([,attrs,code])=>"'sha256-"+createHash('sha256').update(code).digest('base64')+"'").join(' ');
const path=new URL('./_worker.js',import.meta.url);const worker=await readFile(path,'utf8');
await writeFile(path,worker.replace(/const INLINE_HASHES = .*?;/,'const INLINE_HASHES = '+JSON.stringify(hashes)+';'));
