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

    if (cm?.hasFocus && cm.dom && container.contains(cm.dom) && typeof cm.coordsAtPos === 'function') {
        // Obsidian's editor range is already the selected text. A transient
        // difference from CM6's internal selection (e.g. task-list widgets)
        // must not suppress the toolbar.
        const start = cm.coordsAtPos(from, 1);
        const end = cm.coordsAtPos(to, -1);
        if (start && end && Math.abs(start.top - end.top) < 3 && end.right >= start.left) {
            return rangeRect(start, end);
        }
        // Keep the toolbar near the caret for a multiline selection.
        if (end || start) return end ?? start;
    }

    // CM6 may temporarily lack coordinates when Live Preview replaces nodes.
    // Fall back only to a selection genuinely inside the active editor.
    if (cm && !cm.hasFocus &&
        !(typeof document !== 'undefined' && document.activeElement &&
            container.contains(document.activeElement))) return null;
    const anchor = nativeSelection?.anchorNode;
    if (!nativeSelection || nativeSelection.isCollapsed || !nativeSelection.rangeCount ||
        !anchor || !container.contains(anchor)) return null;
    const range = nativeSelection.getRangeAt(0);
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    return rect && (rect.width || rect.height) ? rect : null;
}
