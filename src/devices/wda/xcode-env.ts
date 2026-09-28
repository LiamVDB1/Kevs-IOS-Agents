import { execFileSync } from 'node:child_process';

const FALLBACK_DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';

/** XCODE_DEVELOPER_DIR, else the active `xcode-select` developer dir when it is a full Xcode. */
export function resolveDeveloperDir(): string {
    if (process.env.XCODE_DEVELOPER_DIR) return process.env.XCODE_DEVELOPER_DIR;
    try {
        const selected = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim();
        if (selected.endsWith('.app/Contents/Developer')) return selected;
    } catch {
        // xcode-select is macOS-only; fall through to the conventional path.
    }
    return FALLBACK_DEVELOPER_DIR;
}
