// One consistent set: 24px grid, round 1.8px strokes. Dots use zero-length
// segments so they inherit the stroke colour of the current theme.
const paths = {
    // Brand mark: a filled star (별), distinct from the outline glyphs in the message menu.
    star: ['M12 3.8L14.29 9.64L20.56 10.02L15.71 14.01L17.29 20.08L12 16.7L6.71 20.08L8.29 14.01L3.44 10.02L9.71 9.64Z'],
    search: ['M10.8 18a7.2 7.2 0 1 0 0-14.4 7.2 7.2 0 0 0 0 14.4Z', 'm20.4 20.4-4.5-4.5'],
    close: ['M6.5 6.5l11 11M17.5 6.5l-11 11'],
    edit: ['M4 20h4.2L19.1 9.1a2.9 2.9 0 0 0-4.2-4.2L4 15.8V20Z', 'm13.4 6.4 4.2 4.2'],
    pencil: ['M4 6h10M4 11h7M4 16h4', 'M12.5 20.5v-2.7l6-6a1.9 1.9 0 0 1 2.7 2.7l-6 6h-2.7Z'],
    check: ['m5 12.6 4.4 4.4L19 7.4'],
    download: ['M12 4v11', 'm7.4 10.6 4.6 4.6 4.6-4.6', 'M5 19.5h14'],
    copy: ['M9.5 8.5h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z', 'M5.5 15.5h-.8A1.2 1.2 0 0 1 3.5 14.3V4.7a1.2 1.2 0 0 1 1.2-1.2h9.6a1.2 1.2 0 0 1 1.2 1.2v.8'],
    title: ['M5 7.5V5h14v2.5', 'M12 5v14', 'M9 19h6'],
    book: ['M3 5.6c3-1.3 6.2-1.1 9 1 2.8-2.1 6-2.3 9-1v13c-3-1.3-6.2-1.1-9 1-2.8-2.1-6-2.3-9-1v-13Z', 'M12 6.6v13'],
    list: ['M9 6.5h11M9 12h11M9 17.5h11', 'M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01'],
    left: ['m14.5 6-6 6 6 6'], right: ['m9.5 6 6 6-6 6'],
    up: ['m6 14.5 6-6 6 6'], down: ['m6.5 9.5 5.5 5.5 5.5-5.5'],
    back: ['M19 12H5.5', 'm11 6-6 6 6 6'],
    all: ['M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z', 'm8 12.2 2.9 2.9L16.2 9'],
    clear: ['M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z', 'M8.5 12h7'],
    trash: ['M4.5 7h15', 'M9.5 7V5.2a1.2 1.2 0 0 1 1.2-1.2h2.6a1.2 1.2 0 0 1 1.2 1.2V7', 'M6.5 7l.8 11.8a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7', 'M10 11v5.5M14 11v5.5'],
    restore: ['M9 14.5 4 9.5l5-5', 'M4 9.5h10.2a5.3 5.3 0 0 1 0 10.6H10'],
    grip: ['M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01'],
    sort: ['M7 4.5v15', 'm4 16.5 3 3 3-3', 'M13.5 6.5h7M13.5 12h5M13.5 17.5h3'],
    layers: ['m12 3.5 8.5 4.6-8.5 4.6-8.5-4.6L12 3.5Z', 'm3.5 12.4 8.5 4.6 8.5-4.6', 'm3.5 16.4 8.5 4.6 8.5-4.6'],
    split: ['M4.5 4.5h7v15h-7z', 'M15 7.5h4.5v12H15', 'M15 4.5h4.5'],
    folder: ['M3.5 7.2V17.8a1.7 1.7 0 0 0 1.7 1.7h13.6a1.7 1.7 0 0 0 1.7-1.7V9.6a1.7 1.7 0 0 0-1.7-1.7h-6.6L10.4 5.5H5.2a1.7 1.7 0 0 0-1.7 1.7Z'],
    plus: ['M12 5.5v13M5.5 12h13'],
    // Gear: six teeth, generated on the same 24px grid.
    settings: ['M9.73 5.38L10.17 2.98L13.83 2.98L14.27 5.38L16.6 6.72L18.89 5.91L20.72 9.07L18.87 10.65L18.87 13.35L20.72 14.93L18.89 18.09L16.6 17.28L14.27 18.62L13.83 21.02L10.17 21.02L9.73 18.62L7.4 17.28L5.11 18.09L3.28 14.93L5.13 13.35L5.13 10.65L3.28 9.07L5.11 5.91L7.4 6.72Z', 'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6Z'],
    append: ['M6 4.5v8a3 3 0 0 0 3 3h10', 'm15 11.5 4 4-4 4'],
};
const heavy = new Set(['grip']);
// Filled shapes keep a thin same-colour stroke only to soften their corners.
const filled = new Set(['star']);
export function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('cd-icon');
    if (filled.has(name)) svg.classList.add('cd-filled');
    if (!paths[name]) console.warn('[Sideleaf] Unknown icon', name);
    for (const d of paths[name] || paths.star) {
        const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d);
        path.setAttribute('fill', filled.has(name) ? 'currentColor' : 'none'); path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', filled.has(name) ? '1.2' : heavy.has(name) ? '2.6' : '1.8');
        path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); svg.append(path);
    }
    return svg;
}
