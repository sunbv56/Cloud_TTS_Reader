// Back / swipe-back closes the top open layer. Each open layer owns one history entry, pushed
// while the user's gesture is still active. Closing from the UI drops the surplus entries in a
// microtask, so a close followed by an open in the same handler nets out. A user Back never
// pushes a replacement entry: Chrome marks entries added without user activation as skippable,
// and a later Back would then leave the app.

const stack = [];
let entries = 0;
let skipPops = 0;
let deferredPushes = 0;
let reconcileQueued = false;
let dropStale = false;

const isLayerEntry = (state) => !!state && state.novaLayer === true;

function pushEntry() {
    history.pushState({ novaLayer: true }, '');
    entries += 1;
}

function reconcile() {
    reconcileQueued = false;
    const surplus = entries - stack.length;
    if (surplus <= 0) return;
    entries -= surplus;
    skipPops += 1;
    history.go(-surplus);
}

function queueReconcile() {
    if (reconcileQueued) return;
    reconcileQueued = true;
    queueMicrotask(reconcile);
}

// A layer that refuses to close on Back gets its entry back on the next user interaction.
function restoreEntryOnNextInteraction() {
    const restore = () => {
        window.removeEventListener('pointerdown', restore, true);
        window.removeEventListener('keydown', restore, true);
        if (entries < stack.length) pushEntry();
    };
    window.addEventListener('pointerdown', restore, true);
    window.addEventListener('keydown', restore, true);
}

// close() runs when Back is pressed with this layer on top; returning false keeps it open.
export function openLayer(name, close) {
    const existing = stack.find(layer => layer.name === name);
    if (existing) {
        existing.close = close;
        return;
    }
    stack.push({ name, close });
    // A layer closed earlier in this gesture leaves a surplus entry: reuse it. If its removal is
    // already in flight (history.go is async), push once that traversal lands.
    if (entries >= stack.length) return;
    if (skipPops > 0) deferredPushes += 1;
    else pushEntry();
}

export function closeLayer(name) {
    const index = stack.findIndex(layer => layer.name === name);
    if (index === -1) return;
    stack.splice(index, 1);
    queueReconcile();
}

window.addEventListener('popstate', (event) => {
    if (dropStale) {
        if (isLayerEntry(event.state)) history.back();
        else dropStale = false;
        return;
    }
    if (skipPops > 0) {
        skipPops -= 1;
        for (; deferredPushes > 0; deferredPushes -= 1) {
            if (entries < stack.length) pushEntry();
        }
        return;
    }
    entries = Math.max(0, entries - 1);
    const top = stack.pop();
    if (!top) return;
    let keepOpen = false;
    try {
        keepOpen = top.close() === false;
    } catch (error) {
        console.error('[layers]', error);
    }
    if (keepOpen) {
        stack.push(top);
        restoreEntryOnNextInteraction();
    }
});

// A reload while layers were open leaves stale layer entries above the page; step back past them.
if (isLayerEntry(history.state)) {
    dropStale = true;
    history.back();
}
