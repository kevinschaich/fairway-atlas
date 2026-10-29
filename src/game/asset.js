// Static files (audio, commentary, data, textures, snapshot) live in public/ and are served next to the page,
// so they resolve against the page, not the module (which Vite bundles into assets/). Under node (tests) they
// resolve to public/ on disk.
const base=globalThis.document?.baseURI??globalThis.location?.href??new URL('../../public/',import.meta.url);
export const asset=p=>new URL(p,base);
