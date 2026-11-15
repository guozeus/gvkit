import assert from 'node:assert/strict';
import test from 'node:test';
import MarkdownIt from 'markdown-it';
import { parser } from '@lezer/markdown';
import { Window } from 'happy-dom';
import { applyStyleToSourceSelection, toggleBoldInSourceSelection, WRAPPERS } from '../src/formatting.ts';
import { renderGvkitStyles } from '../src/readingView.ts';

const markdown = new MarkdownIt();
const text = '重要结论';

function render(source: string): HTMLElement {
	const window = new Window();
	Object.assign(globalThis, {
		document: window.document, Node: window.Node, NodeFilter: window.NodeFilter,
		Text: window.Text, HTMLElement: window.HTMLElement,
	});
	const root = window.document.createElement('div') as unknown as HTMLElement;
	root.innerHTML = markdown.render(source);
	renderGvkitStyles(root);
	return root;
}

function assertCombined(result: { source: string; selectionFrom: number; selectionTo: number }, action: keyof typeof WRAPPERS, expectedText: string): void {
	assert.equal(result.source.slice(result.selectionFrom, result.selectionTo), text);
	const root = render(result.source);
	assert.equal(root.textContent?.trim(), expectedText.trim());
	const strong = root.querySelector('strong');
	assert.equal(strong?.textContent, text, result.source);
	const cls = WRAPPERS[action].kind === 'text' ? 'gvkit-text-' : 'gvkit-bg-';
	const colored = root.querySelector('.' + cls + WRAPPERS[action].color);
	assert.equal(colored?.textContent, text, result.source);
	const coveringStrong: number[] = [];
	parser.parse(result.source).iterate({ enter(node) {
		if (node.name === 'StrongEmphasis' && node.from <= result.selectionFrom && node.to >= result.selectionTo) coveringStrong.push(node.from);
	}});
	assert.equal(coveringStrong.length, 1, 'editor parser must recognize the selected text as bold: ' + result.source);
}

for (const action of Object.keys(WRAPPERS) as Array<keyof typeof WRAPPERS>) {
	test(action + ': both click orders preserve rendered bold in continuous Chinese text', () => {
		for (const [before, after] of [['这段', '需要保留'], ['', '需要保留'], ['这段', ''], ['', ''], ['前 ', ' 后'], ['前，', '。后']]) {
			for (const order of ['bold-first', 'color-first']) {
				let result = { source: before + text + after, selectionFrom: before.length, selectionTo: before.length + text.length };
				if (order === 'bold-first') {
					result = toggleBoldInSourceSelection(result.source, result.selectionFrom, result.selectionTo);
					result = applyStyleToSourceSelection(result.source, result.selectionFrom, result.selectionTo, action);
				} else {
					result = applyStyleToSourceSelection(result.source, result.selectionFrom, result.selectionTo, action);
					result = toggleBoldInSourceSelection(result.source, result.selectionFrom, result.selectionTo);
				}
				assertCombined(result, action, before + text + after);
			}
		}
	});

	test(action + ': native bold source selections, reversed selections, and color removal preserve text', () => {
		const source = '前**' + text + '**后';
		for (const [from, to] of [[3, 7], [7, 3], [1, 9]]) {
			const colored = applyStyleToSourceSelection(source, from, to, action);
			const visibleFrom = colored.source.indexOf(text);
			assertCombined({ ...colored, selectionFrom: visibleFrom, selectionTo: visibleFrom + text.length }, action, '前' + text + '后');
			for (const remove of [action, 'clear'] as const) {
				const result = applyStyleToSourceSelection(colored.source, visibleFrom, visibleFrom + text.length, remove);
				assert.equal(result.source, source);
				assert.equal(result.source.slice(result.selectionFrom, result.selectionTo), text);
				assert.equal(render(result.source).querySelector('strong')?.textContent, text);
			}
		}
	});
}

test('color changes and independent text/background layers keep bold and selection', () => {
	let result = toggleBoldInSourceSelection('前' + text + '后', 1, 5);
	for (const action of ['text-blue', 'text-purple', 'bg-blue', 'bg-purple'] as const) {
		result = applyStyleToSourceSelection(result.source, result.selectionFrom, result.selectionTo, action);
		assertCombined(result, action, '前' + text + '后');
	}
	const root = render(result.source);
	assert.equal(root.querySelector('.gvkit-text-purple')?.textContent, text);
	assert.equal(root.querySelector('.gvkit-bg-purple')?.textContent, text);
	const plain = toggleBoldInSourceSelection(result.source, result.selectionFrom, result.selectionTo);
	assert.equal(render(plain.source).querySelector('strong'), null);
	assert.equal(render(plain.source).querySelector('.gvkit-text-purple')?.textContent, text);
	const boldAgain = toggleBoldInSourceSelection(plain.source, plain.selectionFrom, plain.selectionTo);
	assertCombined(boldAgain, 'bg-purple', '前' + text + '后');
});

test('color does not expand to the rest of a larger bold phrase', () => {
	const source = '前**开始' + text + '结束**后';
	const from = source.indexOf(text);
	const result = applyStyleToSourceSelection(source, from, from + text.length, 'text-blue');
	const root = render(result.source);
	assert.equal(root.textContent?.trim(), '前开始' + text + '结束后');
	assert.equal(root.querySelector('strong')?.textContent, '开始' + text + '结束');
	assert.equal(root.querySelector('.gvkit-text-blue')?.textContent, text);
});

test('underscore bold remains standard Markdown after coloring', () => {
	const source = '__' + text + '__';
	const result = applyStyleToSourceSelection(source, 2, 2 + text.length, 'text-blue');
	assertCombined(result, 'text-blue', text);
	assert.equal(result.source, '~={gv-blue}__' + text + '__=~');
});

test('escaped asterisks are not moved as a bold wrapper', () => {
	const source = String.raw`前\**重要结论**后`;
	const from = source.indexOf(text);
	const result = applyStyleToSourceSelection(source, from, from + text.length, 'text-blue');
	assert.equal(result.source, String.raw`前\**~={gv-blue}重要结论=~**后`);
});

test('merged text color can be partially cleared/recolored with bold, links and background retained',()=>{
 for(const inner of ['**甲乙丙**','[甲乙丙](https://example.test)','~={gv-bg-purple}甲乙丙=bg~']){
  const source='~={gv-blue}'+inner+'=~',from=source.indexOf('乙');
  for(const action of ['text-blue','text-purple','clear'] as const){
   const result=applyStyleToSourceSelection(source,from,from+1,action),root=render(result.source);
   assert.equal(root.textContent?.trim(),'甲乙丙',result.source);
   assert.equal([...root.querySelectorAll('.gvkit-text-blue')].map(x=>x.textContent).join(''),'甲丙',result.source);
   if(action==='text-purple')assert.equal(root.querySelector('.gvkit-text-purple')?.textContent,'乙');
   if(inner.startsWith('**'))assert.equal(root.querySelector('strong')?.textContent,'甲乙丙');
   if(inner.startsWith('['))assert.equal(root.querySelector('a')?.getAttribute('href'),'https://example.test');
   if(inner.startsWith('~='))assert.equal([...root.querySelectorAll('.gvkit-bg-purple')].map(x=>x.textContent).join(''),action==='clear'?'甲丙':'甲乙丙');
   assert.equal(result.source.slice(result.selectionFrom,result.selectionTo),'乙');
  }
 }
});

test('Live Preview hides complete multiline color delimiters but keeps code and source mode literal', async()=>{
 const {EditorState}=await import('@codemirror/state');
 const {build}=await import('esbuild');
 const built=await build({entryPoints:['src/editorDecorations.ts'],bundle:true,platform:'node',format:'esm',write:false});
 const {buildDecorations}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0]!.text).toString('base64'));
 const source='~={gv-blue}甲\n乙=~\n\n`~={gv-blue}代码=~`\n\n```\n~={gv-purple}字面=~\n```';
 const root=render('');root.className='is-live-preview';
 const ranges:{from:number;to:number;cls?:string}[]=[];
 const view={state:EditorState.create({doc:source}),dom:root} as any;
 buildDecorations(view).between(0,source.length,(from,to,value)=>{ranges.push({from,to,cls:value.spec.class})});
 assert.deepEqual(ranges.filter(x=>!x.cls).map(x=>source.slice(x.from,x.to)),['~={gv-blue}','=~']);
 assert.equal(ranges.find(x=>x.cls==='gvkit-text-blue')?.to,source.indexOf('乙')+1);
 root.className='';assert.equal(buildDecorations(view).size,0);
});
