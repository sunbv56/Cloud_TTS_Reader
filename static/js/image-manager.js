// Client-side illustration normalisation. Images are intentionally flattened to
// one WebP frame so old browsers and Firebase Storage receive a predictable file.
export const IMAGE_MAX_BYTES = 150 * 1024;
export const IMAGE_TARGET_BYTES = 125 * 1024;
export const IMAGE_MAX_DIMENSION = 1200;
export const IMAGE_ACCEPT = '.jpg,.jpeg,.png,.webp,.gif,.bmp,.avif,.image';

const SUPPORTED_TYPES = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'image/bmp', 'image/avif'
]);

function canvasBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
        if (!canvas.toBlob) return reject(new Error('Trình duyệt không hỗ trợ chuyển đổi ảnh.'));
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Không thể chuyển ảnh sang WebP.')), 'image/webp', quality);
    });
}

async function decodeImage(file) {
    if (typeof createImageBitmap === 'function') {
        try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) { /* fallback */ }
    }
    const url = URL.createObjectURL(file);
    try {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        await img.decode();
        return img;
    } finally {
        URL.revokeObjectURL(url);
    }
}

export async function compressImageForStorage(file) {
    const extension = (file?.name || '').toLowerCase().match(/\.[^.]+$/)?.[0];
    const extensionAllowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.image'].includes(extension);
    if (!file || (!SUPPORTED_TYPES.has((file.type || '').toLowerCase()) && !extensionAllowed)) {
        throw new Error('Định dạng ảnh chưa được hỗ trợ. Hãy dùng JPG, PNG, WebP, GIF, BMP hoặc AVIF.');
    }
    let image;
    try {
        image = await decodeImage(file);
    } catch (_) {
        throw new Error('File .image không chứa dữ liệu ảnh hợp lệ hoặc trình duyệt không đọc được.');
    }
    const sourceWidth = image.width || image.naturalWidth;
    const sourceHeight = image.height || image.naturalHeight;
    if (!sourceWidth || !sourceHeight) throw new Error('Ảnh không có kích thước hợp lệ.');

    let width = sourceWidth;
    let height = sourceHeight;
    const fit = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(width, height));
    width = Math.max(1, Math.round(width * fit));
    height = Math.max(1, Math.round(height * fit));

    let bestBlob = null;
    for (let pass = 0; pass < 4; pass++) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { alpha: true });
        ctx.drawImage(image, 0, 0, width, height);

        let low = 0.42;
        let high = 0.86;
        for (let i = 0; i < 8; i++) {
            const quality = (low + high) / 2;
            const blob = await canvasBlob(canvas, quality);
            bestBlob = blob;
            if (blob.size > IMAGE_TARGET_BYTES) high = quality;
            else low = quality;
        }
        const finalBlob = await canvasBlob(canvas, low);
        bestBlob = finalBlob;
        if (bestBlob.size <= IMAGE_MAX_BYTES) break;
        width = Math.max(320, Math.round(width * 0.85));
        height = Math.max(320, Math.round(height * 0.85));
    }

    if (!bestBlob || bestBlob.size > IMAGE_MAX_BYTES) {
        throw new Error('Ảnh vẫn lớn hơn 150 KB sau khi tối ưu. Hãy chọn ảnh đơn giản hơn.');
    }
    const baseName = (file.name || 'illustration').replace(/\.[^.]+$/, '') || 'illustration';
    return new File([bestBlob], `${baseName}.webp`, { type: 'image/webp', lastModified: Date.now() });
}
