// Resolve only the image lists needed by a view. Keep existing node identities.
function createGalleryCatalogLoader(fetchPage) {
    const requests = new WeakMap();
    const lanes = Array.from({length: 4}, () => Promise.resolve());
    let nextLane = 0;
    let cancelled = false;
    function pending(node, recursive = false) {
        return Boolean(node && (node._images_pending || (recursive && (node.folders || []).some(child => pending(child, true)))));
    }
    async function loadBatch(nodes) {
        if (cancelled) throw new Error('목록 조회가 취소되었습니다.');
        const byNode = new Map(nodes.map(node => [node, []]));
        const owners = new Map();
        for (const node of nodes) {
            for (const source of node._image_sources || []) owners.set(source, node);
        }
        let after = '';
        const sources = [...owners.keys()];
        for (let offset = 0; offset < sources.length; offset += 128) {
            after = '';
            do {
                if (cancelled) throw new Error('목록 조회가 취소되었습니다.');
                const page = await fetchPage({folders: sources.slice(offset, offset + 128), after, limit: 512});
                if (cancelled) throw new Error('목록 조회가 취소되었습니다.');
                for (const image of page.images) {
                    const folder = image.path?.slice(0, image.path.lastIndexOf('/'));
                    // The index groups generated _upscaled files with their parent folder.
                    const indexedFolder = folder?.endsWith('/_upscaled')
                        ? folder.slice(0, -'/_upscaled'.length) : folder;
                    const owner = nodes.length === 1 ? nodes[0] : owners.get(folder) || owners.get(indexedFolder);
                    if (!owner) throw new Error('잘못된 이미지 폴더입니다.');
                    byNode.get(owner).push(image);
                }
                if (page.next_cursor && page.next_cursor <= after) throw new Error('잘못된 다음 페이지입니다.');
                after = page.next_cursor || '';
            } while (after);
        }
        for (const [node, images] of byNode) {
            if (images.length !== node._images_pending) throw new Error('이미지 목록이 변경되었습니다. 갤러리를 다시 불러와 주세요.');
        }
        // Publish atomically: incomplete/failed pages cannot look like a complete folder.
        for (const [node, images] of byNode) {
            images.sort((a, b) => node.is_comic ? a.name.localeCompare(b.name)
                : Number(b.mtime || 0) - Number(a.mtime || 0) || a.name.localeCompare(b.name));
            node.images = images;
            delete node._images_pending;
        }
    }
    async function load(node, recursive = false) {
        const waiting = new Set();
        const batches = [];
        let batch = [], sourceCount = 0, imageCount = 0;
        function collect(current) {
            if (!current) return;
            if (current._images_pending) {
                if (requests.has(current)) waiting.add(requests.get(current));
                else {
                    const count = (current._image_sources || []).length;
                    // Keep small folders in one page; avoid repeatedly sorting a huge scope.
                    if (batch.length && (sourceCount + count > 128 || imageCount + current._images_pending > 512)) {
                        batches.push(batch);
                        batch = []; sourceCount = 0; imageCount = 0;
                    }
                    batch.push(current);
                    sourceCount += count;
                    imageCount += current._images_pending;
                }
            }
            if (recursive) for (const child of current.folders || []) collect(child);
        }
        collect(node);
        if (batch.length) batches.push(batch);
        for (const nodes of batches) {
            const lane = nextLane++ % lanes.length;
            const request = lanes[lane].catch(() => {}).then(() => loadBatch(nodes)).finally(() => {
                for (const current of nodes) requests.delete(current);
            });
            lanes[lane] = request;
            for (const current of nodes) requests.set(current, request);
            waiting.add(request);
        }
        await Promise.all(waiting);
    }
    async function loadPaths(paths) {
        const images = [];
        const unique = [...new Set(paths)];
        for (let start = 0; start < unique.length; start += 512) {
            if (cancelled) throw new Error('목록 조회가 취소되었습니다.');
            const page = await fetchPage({paths: unique.slice(start, start + 512), limit: 512});
            if (cancelled) throw new Error('목록 조회가 취소되었습니다.');
            images.push(...page.images);
        }
        return images;
    }
    return {pending, load, loadPaths, cancel() { cancelled = true; }};
}
if (typeof module === 'object' && module.exports) module.exports = {createGalleryCatalogLoader};
