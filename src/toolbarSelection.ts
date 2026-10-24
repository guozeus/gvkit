/**
 * Resolve a text selection against the real Obsidian editor, not the browser's
 * DOM selection. Live Preview (notably task list widgets) can replace DOM nodes
 * and leave window.getSelection() collapsed while CodeMirror still has a range.
 */
export interface ToolbarSelectionEditor {
    getCursor(which: 'from' | 'to'): { line: number; ch: number };
    posToOffset(position: { line: number; ch: number }): number;
}

export interface CodeMirrorSelectionGeometry {
    readonly hasFocus: boolean;
    readonly dom: HTMLElement;
    readonly state: { readonly selection: { readonly main: { readonly from: number; readonly to: number } } };
    coordsAtPos(position: number, side?: -1 | 1): DOMRect | null;
}

function rangeRect(start: DOMRect, end: DOMRect): DOMRect {
    const left = Math.min(start.left, end.left);
    const right = Math.max(start.right, end.right);
    const top = Math.min(start.top, end.top);
    const bottom = Math.max(start.bottom, end.bottom);
    return { left, right, top, bottom, width: right - left, height: bottom - top } as DOMRect;
}

export function resolveEditorSelectionRect(
    editor: ToolbarSelectionEditor,
    container: HTMLElement,
    cm: CodeMirrorSelectionGeometry | null | undefined,
    nativeSelection: Selection | null,
): DOMRect | null {
    const from = editor.posToOffset(editor.getCursor('from'));
    const to = editor.posToOffset(editor.getCursor('to'));
    if (to <= from) return null;

    if (cm) {
        // Obsidian's source editor uses CodeMirror 6. Its selection is the
        // authority; a DOM selection can disappear around checkbox widgets.
        if (!cm.hasFocus || !container.contains(cm.dom)) return null;
        const active = cm.state.selection.main;
        if (active.from !== from || active.to !== to) return null;

        const start = cm.coordsAtPos(from, 1);
        const end = cm.coordsAtPos(to, -1);
        if (start && end && Math.abs(start.top - end.top) < 3 && end.right >= start.left) {
            return rangeRect(start, end);
        }
        // For multiline selections, position near the end/caret rather than
        // spanning the entire block and obstructing unrelated text.
        return end ?? start;
    }

    // The legacy editor has no CM6 view. Preserve the previous DOM fallback.
    const anchor = nativeSelection?.anchorNode;
    if (!nativeSelection || nativeSelection.isCollapsed || !nativeSelection.rangeCount ||
        !anchor || !container.contains(anchor)) return null;
    const range = nativeSelection.getRangeAt(0);
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    return rect && (rect.width || rect.height) ? rect : null;
}
