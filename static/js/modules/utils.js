/**
 * Cloud TTS Reader - Common Utilities and Network Helpers
 */

export const NETWORK_DEFAULT_TIMEOUT_MS = 20_000;
export const NETWORK_DEFAULT_RETRIES = 2;

export class NetworkTimeoutError extends Error {
    constructor(url, timeoutMs) {
        super(`Request timed out after ${timeoutMs}ms: ${url}`);
        this.name = 'NetworkTimeoutError';
        this.retryable = true;
    }
}

export function promiseWithTimeout(promise, timeoutMs, message) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new NetworkTimeoutError(message, timeoutMs)), timeoutMs);
        })
    ]).finally(() => clearTimeout(timer));
}

export function shouldRetryNetworkError(error) {
    return error instanceof NetworkTimeoutError || error?.name === 'TypeError' || error?.retryable === true;
}

export function createLoadTrace(bookId) {
    const started = performance.now();
    return label => console.debug(`[LoadTiming] book=${bookId} step=${label} elapsed_ms=${(performance.now() - started).toFixed(1)}`);
}

export async function fetchWithTimeout(url, options = {}, config = {}) {
    const timeoutMs = config.timeoutMs ?? NETWORK_DEFAULT_TIMEOUT_MS;
    const retries = config.retries ?? NETWORK_DEFAULT_RETRIES;
    const externalSignal = options.signal;
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
        if (externalSignal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        const controller = new AbortController();
        const abortForwarder = () => controller.abort(externalSignal.reason);
        externalSignal?.addEventListener('abort', abortForwarder, { once: true });
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            if (response.ok || ![502, 503, 504].includes(response.status) || attempt === retries) return response;
            lastError = new Error(`HTTP ${response.status}`);
            lastError.retryable = true;
        } catch (error) {
            if (externalSignal?.aborted) throw error;
            if (error.name === 'AbortError') {
                lastError = new NetworkTimeoutError(url, timeoutMs);
            } else {
                lastError = error;
            }
            if (!shouldRetryNetworkError(lastError) || attempt === retries) throw lastError;
        } finally {
            clearTimeout(timer);
            externalSignal?.removeEventListener('abort', abortForwarder);
        }
        await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1) + Math.random() * 250));
    }
    throw lastError;
}
