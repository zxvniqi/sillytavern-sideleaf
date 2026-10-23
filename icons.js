const paths = {
    download: ['M12 3v12m-5-5 5 5 5-5','M4 16v5h16v-5'],
    leaf: ['M5 3h9l5 5v12H5z','M14 3v5h5','M8 17c0-5 3-6 7-6 0 4-2 6-7 6Zm0 0 5-4','m3 5-1-2m1-1 1-2'],
    copy: ['M8 8h11v12H8z','M15 8V4H4v12h4'],
    edit: ['m4 16-1 5 5-1L20 8l-4-4Z','m13 7 4 4'],
    title: ['M3 5h18M12 5v15M8 20h8'],
    text: ['M4 5h16M4 10h16M4 15h11M4 20h8'],
    language: ['M3 5h11M8 3v2M5 7c1 4 4 7 8 8M12 5c-1 5-4 9-9 11','m14 20 4-10 4 10m-6-4h4'],
    expand: ['M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5'],
    list: ['M8 5h13M8 12h13M8 19h13M3 5h1M3 12h1M3 19h1'],
    left: ['m15 4-8 8 8 8'], right: ['m9 4 8 8-8 8'],
    close: ['m5 5 14 14M19 5 5 19'],
    check: ['m5 12 4 4L19 6'],
    all: ['M8 3h13v13M3 8h13v13H3z','m6 14 3 3 5-6'],
    clear: ['M4 4h16v16H4z','m8 8 8 8m0-8-8 8'],
    move: ['m8 6 4-4 4 4M12 2v20m-4-4 4 4 4-4'],
    grip: ['M8 5h1m6 0h1M8 12h1m6 0h1M8 19h1m6 0h1'],
    up: ['m5 15 7-7 7 7'], down: ['m5 9 7 7 7-7'],
};
export function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true'); svg.classList.add('cd-icon');
    for (const d of paths[name] || paths.leaf) {
        const path = document.createElementNS(svg.namespaceURI,'path'); path.setAttribute('d',d);
        path.setAttribute('fill','none'); path.setAttribute('stroke','currentColor'); path.setAttribute('stroke-width','1.7');
        path.setAttribute('stroke-linecap','round'); path.setAttribute('stroke-linejoin','round'); svg.append(path);
    }
    return svg;
}
