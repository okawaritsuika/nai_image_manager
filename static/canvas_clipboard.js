// Browser clipboard I/O shared by the canvas and its image editors.
const CanvasImageClipboard = (() => {
    function isSupported(file) {
        if (!file) return false;
        const type = String(file.type || '').toLowerCase();
        return ['image/png', 'image/jpeg', 'image/webp'].includes(type)
            || /\.(png|jpe?g|webp)$/i.test(String(file.name || ''));
    }

    function readEventFile(data) {
        const file = [...(data?.files || [])].find(isSupported);
        if (file) return file;
        for (const item of data?.items || []) {
            if (item.kind !== 'file') continue;
            const candidate = item.getAsFile();
            if (isSupported(candidate)) return candidate;
        }
        return null;
    }

    async function readSystemFile() {
        if (typeof navigator.clipboard?.read !== 'function') return null;
        let items;
        try {
            items = await navigator.clipboard.read();
        } catch (error) {
            // Paste events can still provide an image without read permission.
            return null;
        }
        for (const item of items) {
            for (const type of item.types) {
                if (!isSupported({ type })) continue;
                try {
                    const blob = await item.getType(type);
                    return new File([blob], `clipboard-image.${type.split('/')[1]}`, {
                        type: blob.type || type
                    });
                } catch (error) {
                    // A different representation/item may still be readable.
                }
            }
        }
        return null;
    }

    function toDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('클립보드 이미지를 읽을 수 없습니다.'));
            reader.readAsDataURL(blob);
        });
    }

    return { isSupported, readEventFile, readSystemFile, toDataUrl };
})();
