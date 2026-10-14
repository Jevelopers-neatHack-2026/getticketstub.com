import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const compile = file => ts.transpileModule(readFileSync(new URL(`../src/customer/landing/${file}`, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function motionEnv({ search = '', storageFails = false, renderer = 'NVIDIA', rendererThrows = false, hints = {}, reduced = false } = {}) {
  let losses = 0, probes = 0;
  const stored = new Map();
  const location = new URL(`https://example.test/?campaign=kept${search}&other=yes#studio`);
  const state = { keep: 'history state' };
  const gl = {
    getExtension(name) { return name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 1 } : { loseContext() { losses++; } }; },
    getParameter() { if (rendererThrows) throw new Error('renderer blocked'); return renderer; },
  };
  const media = { matches: reduced };
  const window = {
    location,
    history: { state, replaceState(s, _, url) { assert.equal(s, state); location.href = new URL(url, location).href; } },
    matchMedia: () => media,
    localStorage: {
      getItem(k) { if (storageFails) throw new Error('storage blocked'); return stored.get(k) ?? null; },
      setItem(k, v) { if (storageFails) throw new Error('storage blocked'); stored.set(k, v); },
      removeItem(k) { if (storageFails) throw new Error('storage blocked'); stored.delete(k); },
    },
  };
  const env = { exports: {}, window, URL, URLSearchParams, navigator: { hardwareConcurrency: 8, deviceMemory: 8, ...hints }, document: {
    createElement() { probes++; return { getContext: () => gl }; },
  } };
  vm.runInNewContext(compile('motion.ts'), env);
  return { ...env.exports, location, stored, media, losses: () => losses, probes: () => probes };
}
for (const first of ['on', 'off']) test(`motion: query ${first} is an initial choice and repeated toggles work`, () => {
  const env = motionEnv({ search: `&motion=${first}` });
  assert.equal(env.readMotionPref(), first);
  const next = first === 'on' ? 'off' : 'on';
  env.writeMotionPref(next);
  assert.equal(env.readMotionPref(), next);
  assert.equal(env.location.searchParams.get('motion'), next);
  assert.equal(env.location.searchParams.get('campaign'), 'kept');
  assert.equal(env.location.searchParams.get('other'), 'yes');
  assert.equal(env.location.hash, '#studio');
  env.writeMotionPref(first);
  assert.equal(env.readMotionPref(), first);
});
test('motion: storage failures preserve repeated choices for this load, including auto', () => {
  const env = motionEnv({ storageFails: true, search: '&motion=off' });
  for (const choice of ['on', 'off', 'on', 'auto']) {
    env.writeMotionPref(choice);
    assert.equal(env.readMotionPref(), choice);
  }
  assert.equal(env.location.searchParams.has('motion'), false);
});
test('motion: automatic preference follows OS changes and explicit on overrides reduce', () => {
  const env = motionEnv();
  assert.equal(env.landingMode().still, false);
  env.media.matches = true;
  assert.equal(env.landingMode().still, true);
  env.writeMotionPref('on');
  assert.equal(env.landingMode().still, false);
  assert.equal(env.probes(), 1);
});
test('motion: GPU probe releases even when the renderer read fails and caches fallback', () => {
  const env = motionEnv({ rendererThrows: true });
  assert.equal(env.hasHardwareGL(), false);
  assert.equal(env.losses(), 1);
  assert.equal(env.hasHardwareGL(), false);
  assert.equal(env.probes(), 1);
});
for (const renderer of ['SwiftShader', 'llvmpipe', 'softpipe', 'software renderer', 'Microsoft Basic Render Driver', 'lavapipe']) {
  test(`motion: ${renderer} uses printed fallback`, () => {
    const env = motionEnv({ renderer });
    assert.equal(env.landingMode().no3d, true);
    assert.equal(env.losses(), 1);
  });
}
for (const hints of [{ connection: { saveData: true } }, { connection: { effectiveType: 'slow-2g' } }, { connection: { effectiveType: '2g' } }, { deviceMemory: 2 }, { hardwareConcurrency: 2 }]) {
  test(`motion: ${JSON.stringify(hints)} falls back before probing WebGL`, () => {
    const env = motionEnv({ hints });
    assert.equal(env.landingMode().no3d, true);
    assert.equal(env.probes(), 0);
  });
}

// Render the real component with deterministic hooks; its effect, click handler and cleanup run unchanged.
function landingEnv({ delayBoard = false, generatedCards = false } = {}) {
  let effect, cleanup, refIndex = 0, stateIndex = 0, stopped = 0;
  const states = [0, false];
  const refs = [], listeners = new Map(), changes = new Set(), modes = [], focus = [], drafts = [];
  const boardCallbacks=[];
  let cards=[];
  const card = (kind) => ({kind,tagName:'FIGURE',blocked:false,closest(selector){return selector==='[inert],[hidden]'&&this.blocked?{}:selector==='#boardUI'&&kind==='preview'?{id:'boardUI'}:null;},getAttribute:name=>name==='aria-label'?`${kind} stub. Press to flip it over.`:null,focus(options){documentNode.activeElement=this;focus.push(options);}});
  const emptyInput = () => ({ tagName:"INPUT", closest:selector=>selector==='#boardUI'?{id:'boardUI'}:null, getAttribute(name) { return name === "id" ? "ev" : null; }, value: "", selectionStart: 0, selectionEnd: 0, selectionDirection: "none", focus(o) { documentNode.activeElement=this; focus.push(o); this.selectionStart=this.selectionEnd=this.value.length; this.selectionDirection="none"; }, setSelectionRange(start,end,direction) { this.selectionStart=start; this.selectionEnd=end; this.selectionDirection=direction; } });
  let rawInput = emptyInput();
  const link = (href) => ({ tagName:"A", closest:()=>null, getAttribute(name) { return name === "href" ? href : null; }, focus(options) { documentNode.activeElement=this;focus.push(options); } });
  let navLink=link('#studio'), ctaLink=link('#make');
  const hosts = Array.from({length:4}, (_,i) => ({
    querySelectorAll() { return i === 0 ? [toggle,rawInput,navLink,ctaLink,...cards] : []; },
    contains(el) { return this.querySelectorAll().includes(el); },
    set innerHTML(_) { if (i===0) { if ([rawInput,navLink,ctaLink,...cards].includes(documentNode.activeElement)) documentNode.activeElement=documentNode.body; cards=[];rawInput=emptyInput();navLink=link('#studio');ctaLink=link('#make'); } },
  }));
  let pref = 'auto', reduced = false;
  const toggle = { tagName:"BUTTON", closest:()=>null, getAttribute(name) { return name === "aria-label" ? "Reduce motion" : null; }, setAttribute(k, v) { this[k] = v; }, focus(o) { documentNode.activeElement=this; focus.push(o); }, addEventListener(k, v) { listeners.set(k, v); }, removeEventListener(k) { listeners.delete(k); } };
  const documentNode = { activeElement: toggle, body: { nodeName:"BODY" } };
  const el = { dataset: {}, classList: { remove() {} }, querySelector: sel => sel === '#maker #ev' ? rawInput : toggle, querySelectorAll: () => hosts };
  const exports = {};
  vm.runInNewContext(compile('Landing.tsx'), { exports, window: { matchMedia: () => ({ addEventListener(_, cb) { changes.add(cb); }, removeEventListener(_, cb) { changes.delete(cb); } }) }, document: documentNode, require(id) {
    if (id === 'react') return {
      useRef(initial) { const i = refIndex++; return refs[i] ??= { current: i === 0 ? el : initial }; },
      useState: () => { const i = stateIndex++; return [states[i], next => { states[i] = typeof next === "function" ? next(states[i]) : next; }]; }, useEffect: cb => { effect = cb; },
    };
    if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null };
    if (id === 'next/navigation') return { useRouter: () => ({ push() {} }) };
    if (id === './MotionContext') return { MotionOffContext: { Provider: 'motion-provider' } };
    if (id === './motion') return { readMotionPref: () => pref, writeMotionPref: v => { pref = v; }, landingMode: () => ({ still: pref === 'off' || (pref === 'auto' && reduced), no3d: pref !== 'on', reason: pref === 'on' ? '' : 'motion off' }) };
    if (id === './landing.script') return { mountLanding: ctx => {
      modes.push(ctx.mode); drafts.push(rawInput.value);
      if(generatedCards)cards=[card('studio'),card('preview')];
      const ready=()=>{if(generatedCards)cards.push(card('ribbon'));ctx.onBoardReady?.();};
      if(delayBoard)boardCallbacks.push(ready);else ready();
      return () => { stopped++; };
    } };
    if (id === './markup') return { CHROME_HTML: '', HERO_HTML: '', REST_HTML: '', FOOT_HTML: '' };
    return {};
  } });
  const render = () => { cleanup?.(); refIndex = 0; stateIndex = 0; exports.Landing({ children: null }); cleanup = effect(); };
  render();
  return { render, el, toggle, modes, focus, changes, drafts, boardCallbacks, document:documentNode, card:kind=>cards.find(c=>c.kind===kind), input:()=>rawInput, nav:()=>navLink, cta:()=>ctaLink, click: () => listeners.get('click')(), system(v) { reduced = v; for (const cb of changes) cb(); }, run: () => states[0], motionOff: () => states[1], stopped: () => stopped, cleanup: () => cleanup() };
}

for(const kind of ['studio','preview','ribbon'])test(`automatic OS remount resolves the regenerated ${kind} ticket after creation`,()=>{
  const env=landingEnv({delayBoard:true,generatedCards:true});env.boardCallbacks.at(-1)();const original=env.card(kind);original.focus({preventScroll:true});
  env.system(true);env.render();assert.notEqual(env.card(kind),original);
  if(kind==='studio')assert.equal(env.document.activeElement,env.card(kind),'synchronously created studio card restores immediately');
  else assert.equal(env.document.activeElement,env.document.body,'pending board/gallery content does not consume the restoration');
  env.boardCallbacks.at(-1)();assert.equal(env.document.activeElement,env.card(kind));
  assert.ok(env.focus.every(options=>options.preventScroll));env.cleanup();
});
test('generated ribbon focus restoration respects a newly focused React input and disposed mounts',()=>{
  const env=landingEnv({delayBoard:true,generatedCards:true});env.boardCallbacks.at(-1)();env.card('ribbon').focus({preventScroll:true});env.system(true);env.render();
  const pending=env.boardCallbacks.at(-1),embedded={value:'New React draft'};env.document.activeElement=embedded;const before=env.focus.length;
  pending();assert.equal(env.document.activeElement,embedded);assert.equal(env.focus.length,before);
  env.cleanup();env.document.activeElement=env.document.body;pending();assert.equal(env.document.activeElement,env.document.body);assert.equal(env.focus.length,before);
});
test('generated ticket restoration does not attempt or consume focus on an inert or hidden target',()=>{
  const env=landingEnv({delayBoard:true,generatedCards:true});env.card('preview').focus({preventScroll:true});env.system(true);env.render();env.card('preview').blocked=true;
  const before=env.focus.length;env.boardCallbacks.at(-1)();assert.equal(env.document.activeElement,env.document.body);assert.equal(env.focus.length,before);
  env.card('preview').blocked=false;env.boardCallbacks.at(-1)();assert.equal(env.document.activeElement,env.card('preview'));env.cleanup();
});
for(const kind of ['input','ribbon'])test(`successive automatic changes retain pending ${kind} focus and retire older callbacks`,()=>{
  const env=landingEnv({delayBoard:true,generatedCards:true});env.boardCallbacks.at(-1)();
  const original=kind==='input'?env.input():env.card(kind);original.focus({preventScroll:true});
  if(kind==='input'){original.value='Pending maker draft';original.setSelectionRange(2,7,'backward');}
  env.system(true);env.render();env.boardCallbacks.at(-1)();
  env.system(false);env.render();const old=env.boardCallbacks.at(-1);assert.equal(env.document.activeElement,env.document.body);
  env.system(true);env.render();const before=env.focus.length;old();assert.equal(env.focus.length,before,'the retired mount cannot restore a stale target');
  env.boardCallbacks.at(-1)();assert.equal(env.document.activeElement,kind==='input'?env.input():env.card(kind));
  if(kind==='input')assert.deepEqual([env.input().value,env.input().selectionStart,env.input().selectionEnd,env.input().selectionDirection],['Pending maker draft',2,7,'backward']);
  env.cleanup();
});
test('new React focus supersedes an unfulfilled generated target across automatic changes',()=>{
  const env=landingEnv({delayBoard:true,generatedCards:true});env.boardCallbacks.at(-1)();env.card('ribbon').focus({preventScroll:true});env.system(true);env.render();
  const embedded={value:'Preserved React edit'};env.document.activeElement=embedded;env.system(false);env.render();env.boardCallbacks.at(-1)();assert.equal(env.document.activeElement,embedded);env.cleanup();
});

test('automatic maker focus waits for settled board layout and restores its exact selection',()=>{
  const env=landingEnv({delayBoard:true});env.input().value='Delayed gallery fixture';env.input().focus({preventScroll:true});env.input().setSelectionRange(4,9,'backward');
  env.system(true);env.render();
  assert.equal(env.document.activeElement,env.document.body,'no premature attempt on a hidden/inert board');
  env.boardCallbacks.at(-1)();
  assert.equal(env.document.activeElement,env.input());
  assert.deepEqual([env.input().selectionStart,env.input().selectionEnd,env.input().selectionDirection],[4,9,'backward']);
  env.cleanup();
});
for(const alternative of ['embedded','nav'])test(`delayed board readiness does not steal new ${alternative} focus`,()=>{
  const env=landingEnv({delayBoard:true});env.input().focus({preventScroll:true});env.system(true);env.render();
  const next=alternative==='embedded'?{value:'Kept React draft'}:env.nav();env.document.activeElement=next;
  const before=env.focus.length;env.boardCallbacks.at(-1)();assert.equal(env.document.activeElement,next);assert.equal(env.focus.length,before);env.cleanup();
});
test('delayed board readiness preserves new typing and caret in the replacement maker field',()=>{
  const env=landingEnv({delayBoard:true});env.input().value='Original draft';env.input().focus({preventScroll:true});env.input().setSelectionRange(2,5,'backward');env.system(true);env.render();
  env.input().focus({preventScroll:true});env.input().value+=' new edit';const end=env.input().value.length;env.input().setSelectionRange(end,end,'none');
  const before=env.focus.length;env.boardCallbacks.at(-1)();assert.equal(env.document.activeElement,env.input());assert.equal(env.input().value,'Original draft new edit');
  assert.deepEqual([env.input().selectionStart,env.input().selectionEnd,env.input().selectionDirection],[end,end,'none']);assert.equal(env.focus.length,before);env.cleanup();
});
test('delayed board readiness is inert after unmount or a subsequent remount',()=>{
  const env=landingEnv({delayBoard:true});env.input().focus({preventScroll:true});env.system(true);env.render();
  const late=env.boardCallbacks.at(-1);env.cleanup();const before=env.focus.length;late();assert.equal(env.focus.length,before);
  env.render();late();assert.equal(env.focus.length,before);env.cleanup();
});
test('manual toggle and raw navigation focus remain immediate while board readiness is pending',()=>{
  const env=landingEnv({delayBoard:true});env.nav().focus({preventScroll:true});env.system(true);env.render();assert.equal(env.document.activeElement,env.nav());
  env.click();env.render();assert.equal(env.document.activeElement,env.toggle);env.boardCallbacks.at(-1)();assert.equal(env.document.activeElement,env.toggle);env.cleanup();
});
test('Landing effect follows system changes only in auto, reflects aria-pressed and restores switch focus', () => {
  const env = landingEnv();
  assert.equal(env.toggle['aria-pressed'], 'false');
  env.system(true);
  assert.equal(env.run(), 1);
  env.render();
  assert.equal(env.toggle['aria-pressed'], 'true');
  assert.equal(env.el.dataset.motion, 'off');
  assert.equal(env.motionOff(), true);
  env.click(); env.render();
  assert.equal(env.toggle['aria-pressed'], 'false');
  assert.equal(env.el.dataset.motion, '3d');
  assert.equal(env.motionOff(), false);
  assert.equal(Object.hasOwn(env.el.dataset, 'lite'), false);
  assert.equal(env.focus.length, 2);
  assert.ok(env.focus.every(o => o.preventScroll));
  env.system(false);
  assert.equal(env.run(), 2, 'an explicit on choice ignores OS changes');
  env.click(); env.render();
  assert.equal(env.toggle['aria-pressed'], 'true');
  assert.equal(env.changes.size, 1, 'each remount removes the previous media listener');
  env.cleanup();
  assert.equal(env.changes.size, 0);
  assert.equal(env.stopped(), 4);
});

test('Landing host rebuild keeps the maker draft and selection while focus returns to its Motion switch', () => {
  const env = landingEnv();
  const original = env.input();
  original.value = 'Nova Riot, Dublin, July 12';
  original.setSelectionRange(5,15,'backward');
  for (let i=0;i<2;i++) {
    env.click(); env.render();
    assert.notEqual(env.input(),original,'the host was rebuilt');
    assert.equal(env.input().value,'Nova Riot, Dublin, July 12');
    assert.deepEqual([env.input().selectionStart,env.input().selectionEnd,env.input().selectionDirection],[5,15,'backward']);
    assert.equal(env.drafts.at(-1),'Nova Riot, Dublin, July 12','the new initializer receives the preserved value');
  }
  assert.equal(env.focus.length,2);
  assert.ok(env.focus.every(options=>options.preventScroll));
  env.cleanup();
});

test('automatic OS changes retain raw maker focus and selection, while manual toggles keep switch focus', () => {
  const env=landingEnv();
  const first=env.input();first.value='Nova Riot, Dublin';first.focus({preventScroll:true});first.setSelectionRange(5,9,'backward');
  env.system(true);env.render();
  assert.notEqual(env.input(),first);
  assert.equal(env.document.activeElement,env.input());
  assert.equal(env.input().value,'Nova Riot, Dublin');
  assert.deepEqual([env.input().selectionStart,env.input().selectionEnd,env.input().selectionDirection],[5,9,'backward']);
  // Continued typing targets the replacement input, then the reverse OS transition restores its new caret.
  env.document.activeElement.value+=' encore';const caret=env.document.activeElement.value.length;env.document.activeElement.setSelectionRange(caret,caret,'none');
  env.system(false);env.render();
  assert.equal(env.document.activeElement,env.input());assert.equal(env.input().value,'Nova Riot, Dublin encore');
  assert.deepEqual([env.input().selectionStart,env.input().selectionEnd,env.input().selectionDirection],[caret,caret,'none']);
  env.click();env.render();assert.equal(env.document.activeElement,env.toggle);
  assert.ok(env.focus.every(options=>options.preventScroll));env.cleanup();
});
test('automatic OS changes leave an embedded React input focused without a stale maker focus target', () => {
  const env=landingEnv();env.input().focus({preventScroll:true});env.system(true);env.render();
  const embedded={value:'Kept embedded draft',selectionStart:4,selectionEnd:8,selectionDirection:'backward'};
  env.document.activeElement=embedded;
  for (const reduced of [false,true]) {
    env.system(reduced);env.render();
    assert.equal(env.document.activeElement,embedded);
    assert.deepEqual([embedded.value,embedded.selectionStart,embedded.selectionEnd,embedded.selectionDirection],['Kept embedded draft',4,8,'backward']);
  }
  env.cleanup();
});

for (const kind of ['nav','cta']) test(`automatic OS changes retain a focused raw ${kind} link across host reconstruction`,()=>{
  const env=landingEnv();const first=env[kind]();first.focus({preventScroll:true});
  for (const reduced of [true,false]) {
    env.system(reduced);env.render();
    assert.equal(env.document.activeElement,env[kind]());assert.notEqual(env[kind](),first);
    assert.equal(env[kind]().getAttribute('href'),kind==='nav'?'#studio':'#make');
  }
  assert.ok(env.focus.every(options=>options.preventScroll));env.cleanup();
});
