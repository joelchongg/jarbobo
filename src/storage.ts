/**
 * Shared diagram storage for jarbobo — used by BOTH the MCP server (writer) and
 * the extension (reader / layout-writeback / custom editor).
 *
 * Diagram files live wherever they're semantically relevant — a NEW diagram's
 * container file (one per lineage, holding every version) is placed next to
 * the code it documents:
 *   - all its code refs point at one file  -> alongside that file
 *   - refs span several files under one dir -> in that shared directory
 *   - no refs, or refs all over the repo   -> at the workspace root (or cwd)
 * and named after what it shows: the `fileName` the caller gave, else the
 * title's first few words ("shred-tile-leader-path.jarbobo").
 * See chooseDiagramLocation(). There's no dedicated diagrams folder — a
 * workspace is searched recursively (walkDiagramFiles) to find/list them.
 *
 * GLOBAL (legacy, read only for backward compatibility with diagrams saved
 * before this scheme existed): a versioned lineage of separate files at
 * ~/.jarbobo/diagrams/<id>/v<N>.json. Nothing new is ever written there.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const GLOBAL_HOME = path.join(os.homedir(), '.jarbobo');
export const GLOBAL_DIAGRAMS = path.join(GLOBAL_HOME, 'diagrams');
export const JARBOBO_EXT = '.jarbobo';

// Prepended to every local .jarbobo file so someone who opens it as plain text
// knows what it is and how to view it properly. JSON never begins with "//",
// so these lines are trivially strippable before parsing.
export const FILE_HEADER =
    '// Jarbobo diagram — open this file with the Jarbobo extension to view it as\n' +
    '// an interactive diagram (nodes link back to source). Install the viewer:\n' +
    '//   https://github.com/tch1001/jarbobo\n' +
    '// The JSON below is the diagram data (one file per diagram, all versions inside).\n';

// The reader's own notes on elements, keyed by element ("node:pack",
// "edge:a→b:label", "participant:stem", "message:a→b:label"). They live
// beside the versions, not inside one, so a redraw or new version keeps them.
export type Note = { text: string; label?: string; updated?: string };
export type Container = { id: string; versions: Array<Record<string, unknown>>; notes?: Record<string, Note> };

/** Strip a leading run of `//` comment lines (and an optional BOM) — safe on
 *  pure JSON too, which can never start with `//`. */
export function stripHeader(text: string): string {
    return text.replace(/^﻿?(?:[ \t]*\/\/[^\n]*\r?\n)*/, '');
}

export function isContainerFile(file: string): boolean {
    return file.endsWith(JARBOBO_EXT);
}

/** Meta fields the extension attaches for the webview; never persisted to disk. */
export function stripMeta(d: Record<string, unknown>): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    for (const k of Object.keys(d)) {
        if (k === '_id' || k === '_version' || k === '_versions' || k === '_file' || k === '_notes') { continue; }
        clean[k] = d[k];
    }
    return clean;
}

export function parseContainer(text: string): Container {
    const obj = JSON.parse(stripHeader(text)) as Record<string, unknown>;
    if (Array.isArray(obj.versions)) {
        const notes = obj.notes && typeof obj.notes === 'object' ? obj.notes as Record<string, Note> : undefined;
        return { id: String(obj.id ?? ''), versions: obj.versions as Array<Record<string, unknown>>, ...(notes ? { notes } : {}) };
    }
    // tolerate a bare single-diagram file
    return { id: String(obj.id ?? ''), versions: [obj] };
}

export function readContainer(file: string): Container {
    return parseContainer(fs.readFileSync(file, 'utf8'));
}

export function serializeContainer(c: Container): string {
    const notes = c.notes && Object.keys(c.notes).length ? { notes: c.notes } : {};
    const body = JSON.stringify({ id: c.id, ...notes, versions: c.versions.map(stripMeta) }, null, 2);
    return FILE_HEADER + body + '\n';
}

export function writeContainer(file: string, c: Container): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serializeContainer(c));
}

/** Workspace root, used as a fallback anchor when a diagram has no code refs
 *  to place itself by. JARBOBO_WORKSPACE (set by the extension's MCP
 *  registration) wins; otherwise walk up from cwd to the nearest .git. */
export function findWorkspaceRoot(): string | undefined {
    const env = process.env.JARBOBO_WORKSPACE;
    if (env && fs.existsSync(env)) { return env; }
    let dir = process.cwd();
    for (;;) {
        if (fs.existsSync(path.join(dir, '.git'))) { return dir; }
        const parent = path.dirname(dir);
        if (parent === dir) { return undefined; }
        dir = parent;
    }
}

// Directories never descended into when looking for .jarbobo files, EXCEPT
// a literal `.jarbobo` dir — that's the old convention's storage folder, and
// walking into it is how existing diagrams saved there stay discoverable.
const WALK_SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', 'target', '.next', 'vendor', '.cache', 'coverage',
]);
const WALK_MAX_FILES = 5000; // safety cap for pathological repos

/** Recursively find every `*.jarbobo` file under `root` (mtime order not
 *  guaranteed — callers that care about recency should stat and sort). */
export function walkDiagramFiles(root: string): string[] {
    const results: string[] = [];
    const walk = (dir: string) => {
        if (results.length >= WALK_MAX_FILES) { return; }
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (results.length >= WALK_MAX_FILES) { return; }
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (WALK_SKIP_DIRS.has(e.name)) { continue; }
                if (e.name.startsWith('.') && e.name !== '.jarbobo') { continue; }
                walk(full);
            } else if (e.isFile() && e.name.endsWith(JARBOBO_EXT)) {
                results.push(full);
            }
        }
    };
    walk(root);
    return results;
}

/** Every source file a diagram's elements reference (absolute paths, deduped). */
export function collectRefFiles(diagram: Record<string, unknown>): string[] {
    const files = new Set<string>();
    const visit = (el: Record<string, unknown>) => {
        if (typeof el.file === 'string') { files.add(el.file); }
        if (Array.isArray(el.refs)) {
            for (const r of el.refs as Array<Record<string, unknown>>) {
                if (typeof r.file === 'string') { files.add(r.file); }
            }
        }
    };
    for (const key of ['nodes', 'edges', 'groups', 'classes', 'relations', 'participants', 'messages', 'lanes', 'items', 'tracks']) {
        const arr = diagram[key];
        if (Array.isArray(arr)) { arr.forEach((el) => visit(el as Record<string, unknown>)); }
    }
    return [...files];
}

function longestCommonDir(files: string[]): string {
    const dirs = files.map((f) => path.dirname(f).split(path.sep));
    let common = dirs[0];
    for (const d of dirs.slice(1)) {
        let i = 0;
        while (i < common.length && i < d.length && common[i] === d[i]) { i++; }
        common = common.slice(0, i);
    }
    return common.join(path.sep) || path.sep;
}

function slugForFile(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'diagram';
}

// A title cut to whole words, at most ~48 characters and not ending on a
// filler word ("…-arrives-and-is"), so names stay readable.
const FILLER = new Set(['a', 'an', 'and', 'the', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'by', 'from', 'at', 'or']);
function nameFromTitle(title: string): string {
    const words: string[] = [];
    let len = 0;
    for (const w of slugForFile(title).split('-').filter(Boolean)) {
        if (len + (words.length ? 1 : 0) + w.length > 48) { break; }
        len += (words.length ? 1 : 0) + w.length;
        words.push(w);
    }
    while (words.length > 1 && FILLER.has(words[words.length - 1])) { words.pop(); }
    return words.join('-') || 'diagram';
}

/** Where a NEW diagram's container file should live: named and placed after
 *  whatever code it documents, rather than in a dedicated diagrams folder. */
export function chooseDiagramLocation(
    diagram: Record<string, unknown>,
    opts: { workspaceRoot?: string; title?: string; fileName?: string },
): { dir: string; name: string } {
    // Named after what the diagram shows, never after a directory: several
    // diagrams over one area would otherwise all be "src", told apart only by
    // a random suffix.
    const name = opts.fileName ? slugForFile(opts.fileName.replace(/\.jarbobo$/, '')) : nameFromTitle(opts.title ?? 'diagram');
    const root = opts.workspaceRoot ?? process.cwd();
    const refs = collectRefFiles(diagram);
    if (!refs.length) { return { dir: root, name }; }
    if (refs.length === 1 || new Set(refs).size === 1) { return { dir: path.dirname(refs[0]), name }; }
    const commonDir = longestCommonDir(refs);
    // refs span unrelated top-level areas (or the workspace root itself)
    if (!commonDir || commonDir === opts.workspaceRoot || commonDir === path.sep) { return { dir: root, name }; }
    return { dir: commonDir, name };
}
