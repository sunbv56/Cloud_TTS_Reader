// Back / swipe-back closes the top open layer. While any layer is open one guard entry sits
// above the page in history; closing the last layer from the UI drops it with history.back().

const stack = [];
let onGuard = false;
let backPending = false;

const isGuard = (state) => !!state && state.novaLayer === true;

function sync() {
    if (backPending) return;
    if (stack.length && !onGuard) {
        history.pushState({ novaLayer: true }, '');
        onGuard = true;
    } else if (!stack.length && onGuard) {
        backPending = true;
        onGuard = false;
        history.back();
    }
}

// close() runs when Back is pressed with this layer on top; returning false keeps it open.
export function openLayer(name, close) {
    const existing = stack.find(layer => layer.name === name);
    if (existing) existing.close = close;
    else stack.push({ name, close });
    sync();
}

export function closeLayer(name) {
    const index = stack.findIndex(layer => layer.name === name);
    if (index === -1) return;
    stack.splice(index, 1);
    sync();
}

window.addEventListener('popstate', (event) => {
    onGuard = isGuard(event.state);
    if (backPending) {
        backPending = false;
    } else if (!onGuard) {
        const top = stack.pop();
        try {
            if (top && top.close() === false) stack.push(top);
        } catch (error) {
            console.error('[layers]', error);
        }
    }
    sync();
});

// A reload while a layer was open leaves a stale guard as the current entry.
onGuard = isGuard(history.state);
sync();
