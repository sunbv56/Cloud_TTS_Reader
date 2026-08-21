/**
 * Offline & Cache Manager (IndexedDB)
 */
export const OFFLINE_MANAGER = {
    dbName: 'CloudTTSReaderDB',
    dbVersion: 1,
    storeName: 'audio_cache',
    _db: null,
    _dbPromise: null,

    async init() {
        if (this._db) return;
        if (this._dbPromise) return this._dbPromise;

        this._dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            request.onerror = () => {
                this._dbPromise = null;
                reject(request.error);
            };
            request.onsuccess = () => {
                this._db = request.result;
                resolve();
            };
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName);
                }
            };
        });
        return this._dbPromise;
    },

    async saveBlob(bookId, chIndex, sIndex, blob) {
        await this.init();
        if (!this._db) return;
        const key = `${bookId}_${chIndex}_${sIndex}`;
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            store.put(blob, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    },

    async getBlob(bookId, chIndex, sIndex) {
        await this.init();
        if (!this._db) return null;
        const key = `${bookId}_${chIndex}_${sIndex}`;
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    },

    async clearCache() {
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = this._db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.clear();
            request.onsuccess = () => {
                this.updateUsageUI();
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    },

    async updateUsageUI() {
        await this.init();
        const tx = this._db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const request = store.getAll();
        request.onsuccess = () => {
            const blobs = request.result;
            const totalBytes = blobs.reduce((sum, b) => sum + b.size, 0);
            const mb = (totalBytes / (1024 * 1024)).toFixed(2);
            const el = document.getElementById('offline-usage-text');
            if (el) el.innerText = `${mb} MB`;
        };
    }
};
