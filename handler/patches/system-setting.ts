import { SystemModel } from 'hydrooj';

// (g) A no-op `SystemModel.set` must not announce a change.
//
// ui-default rebuilds the *entire* frontend bundle on any `system/setting`
// broadcast: backendlib/builder.ts registers
// `ctx.on('system/setting', () => triggerHotUpdate())`, and because that
// callback passes no path, the `if (path && !path.includes(...)) return` guard
// inside triggerHotUpdate never fires — even a plugin-private key was enough to
// re-run a full esbuild pass (100+ ms CPU, ~325 KiB emitted, one log block per
// rebuild). The same broadcast also makes every configurable plugin re-resolve
// its config from the database (hydrooj/src/loader.ts) and re-push the language
// config to every connected judge daemon (handler/judge.ts).
//
// Hydro itself writes a setting on a timer: service/monitor.ts calls
// `system.set('server.center', ...)` on every heartbeat (every 30 minutes) with
// whatever the center reported, even when the value did not change. Without
// this guard a production instance therefore rebuilds the frontend bundle, with
// no code change at all, twice an hour — and during each rebuild the in-memory
// asset map (vfs/hashes) is being replaced file by file while requests are
// served from it.
//
// The guard only drops the "something changed" signal: the value is still
// persisted, so the database stays authoritative and this worker's cache stays
// fresh. Genuine changes broadcast exactly as before, and the system-settings
// page keeps its own explicit `ctx.broadcast('system/setting', args)`
// (hydrooj/src/handler/manage.ts) plus the plugin reloads it may trigger.

function sameSettingValue(a: any, b: any): boolean {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return false;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}

export function applySystemSettingPatches() {
    // `SystemModel` is a proxy over the service instance, so the method lives
    // on the class prototype (reachable through the proxy's `prototype` key).
    const proto: any = (SystemModel as any).prototype;
    const original = proto?.set;
    if (typeof original !== 'function' || original.__oi33NoopGuard) return;
    const wrapped = async function oi33SystemSet(this: any, key: string, value: any, broadcast = true) {
        const cache = this?.cache;
        if (broadcast && cache && Object.hasOwn(cache, key) && sameSettingValue(cache[key], value)) {
            return await original.call(this, key, value, false);
        }
        return await original.call(this, key, value, broadcast);
    };
    wrapped.__oi33NoopGuard = true;
    proto.set = wrapped;
}
