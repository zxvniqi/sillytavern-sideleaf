// Plain-text extraction for search, titles, copying and screen capture. Display formatting is done
// separately in index.js (contentBlock) after sanitising.
export function readableText(root) {
    const blocks = new Set(['P','DIV','SECTION','ARTICLE','DETAILS','SUMMARY','LI','UL','OL','PRE','BLOCKQUOTE','H1','H2','H3','H4','H5','H6','TR']);
    const ignored = new Set(['SCRIPT','STYLE','IFRAME','TEMPLATE','NOSCRIPT','BUTTON','SVG']);
    const parts = [];
    function visit(node) {
        if (node.nodeType === 3) { parts.push(node.textContent); return; }
        // SVG/MathML report lowercase node names, so compare case-insensitively.
        // On a live page, skip what the reader cannot see (collapsed code blocks, hidden UI).
        if (node.nodeType === 1 && node.isConnected && typeof getComputedStyle === 'function' && getComputedStyle(node).display === 'none') return;
        if (ignored.has(node.nodeName.toUpperCase()) || node.hidden || node.getAttribute?.('aria-hidden') === 'true') return;
        if (node.nodeName === 'BR') { parts.push('\n'); return; }
        const block = blocks.has(node.nodeName);
        if (block) parts.push('\n');
        for (const child of node.childNodes) visit(child);
        if (block) parts.push('\n');
    }
    visit(root);
    return parts.join('').replace(/\n[\t ]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}

export function fullDetailsText(text) {
    if (!/<details\b/i.test(text)) return text;
    const template = document.createElement('template');
    template.innerHTML = text;
    return readableText(template.content);
}
