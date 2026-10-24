import assert from 'node:assert/strict';
import test from 'node:test';
import {
    resolveEditorSelectionRect,
    type CodeMirrorSelectionGeometry,
    type ToolbarSelectionEditor,
} from '../src/toolbarSelection.ts';

function rect(left: number, top = 80, right = left): DOMRect {
    return {
        left, top, right, bottom: top + 18,
        width: right - left, height: 18,
    } as DOMRect;
}

function fixture(options: {
    focused?: boolean;
    cmFrom?: number;
    cmTo?: number;
    firstRect?: DOMRect | null;
    lastRect?: DOMRect | null;
} = {}) {
    const cmDom = {} as HTMLElement;
    const container = {
        contains: (node: unknown) => node === cmDom,
    } as HTMLElement;
    const editor: ToolbarSelectionEditor = {
        getCursor(which) { return { line: 0, ch: which === 'from' ? 2 : 6 }; },
        posToOffset(position) { return position.ch; },
    };
    const cm: CodeMirrorSelectionGeometry = {
        hasFocus: options.focused ?? true,
        dom: cmDom,
        state: {
            selection: { main: { from: options.cmFrom ?? 2, to: options.cmTo ?? 6 } },
        },
        coordsAtPos(position) {
            if (position === 2) return options.firstRect === undefined ? rect(100) : options.firstRect;
            if (position === 6) return options.lastRect === undefined ? rect(150) : options.lastRect;
            return null;
        },
    };
    return { editor, cm, container };
}

test('checkbox Live Preview: CM6 selection positions toolbar even without native DOM selection', () => {
    const { editor, cm, container } = fixture();
    const result = resolveEditorSelectionRect(editor, container, cm, null);
    assert.equal(result?.left, 100);
    assert.equal(result?.right, 150);
    assert.equal(result?.width, 50);
});

test('do not use a stale browser text selection when CM6 selection is active', () => {
    const { editor, cm, container } = fixture();
    const staleDOMSelection = {
        isCollapsed: false, rangeCount: 1, anchorNode: {},
        getRangeAt: () => ({ getClientRects: () => [rect(500)] }),
    } as unknown as Selection;
    assert.equal(resolveEditorSelectionRect(editor, container, cm, staleDOMSelection)?.left, 100);
});

test('do not show toolbar when another input has focus or the selection has changed', () => {
    const noFocus = fixture({ focused: false });
    assert.equal(resolveEditorSelectionRect(noFocus.editor, noFocus.container, noFocus.cm, null), null);
    const changed = fixture({ cmFrom: 3 });
    assert.equal(resolveEditorSelectionRect(changed.editor, changed.container, changed.cm, null), null);
});

test('multi-line selection anchors near visible caret instead of a giant rectangle', () => {
    const { editor, cm, container } = fixture({ firstRect: rect(100, 30), lastRect: rect(240, 90) });
    assert.equal(resolveEditorSelectionRect(editor, container, cm, null)?.top, 90);
});

test('legacy/non-CM editor uses existing DOM selection fallback', () => {
    const anchor = {};
    const container = { contains: (node: unknown) => node === anchor } as HTMLElement;
    const editor = fixture().editor;
    const nativeSelection = {
        anchorNode: anchor, isCollapsed: false, rangeCount: 1,
        getRangeAt() {
            return { getClientRects: () => [rect(20, 60, 64)] };
        },
    } as unknown as Selection;
    assert.equal(resolveEditorSelectionRect(editor, container, undefined, nativeSelection)?.left, 20);
    assert.equal(resolveEditorSelectionRect(editor, container, undefined, null), null);
});
