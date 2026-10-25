// Gallery feature functions; shared state is declared in index.js.
function isGalleryDateGroupNode(node) {
    return Boolean(node?.isGalleryDateGroup);
}

function getGalleryMultiFolderKey(folder) {
    if (isGalleryDateGroupNode(folder)) {
        return normalizeGalleryPathKey(folder?.path || folder?.name || '');
    }

    return getGalleryBulkDeleteFolderKey(folder);
}

function getGalleryIsoWeekInfo(date) {
    // ISO 주차는 로컬 날짜를 기준으로 계산하되, UTC 자정으로 변환해 DST 영향을 피한다.
    const localDateUtc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    const mondayIndex = (new Date(localDateUtc).getUTCDay() + 6) % 7;
    const thursdayUtc = localDateUtc + (3 - mondayIndex) * 86400000;
    const isoYear = new Date(thursdayUtc).getUTCFullYear();
    const jan4Utc = Date.UTC(isoYear, 0, 4);
    const jan4MondayIndex = (new Date(jan4Utc).getUTCDay() + 6) % 7;
    const firstWeekMondayUtc = jan4Utc - jan4MondayIndex * 86400000;
    const week = 1 + Math.round((thursdayUtc - firstWeekMondayUtc) / 604800000);

    return {year: isoYear, week};
}

function getGalleryDateGroupDescriptor(mtime, grouping = 'month') {
    const timestamp = Number(mtime);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

    const date = new Date(timestamp * 1000);
    if (Number.isNaN(date.getTime())) return null;

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    if (grouping === 'day') {
        return {
            key: `${year}-${month}-${day}`,
            label: `${year}-${month}-${day}`,
            timestamp,
            date
        };
    }

    if (grouping === 'week') {
        const isoWeek = getGalleryIsoWeekInfo(date);
        const week = String(isoWeek.week).padStart(2, '0');
        return {
            key: `${isoWeek.year}-W${week}`,
            label: `${isoWeek.year}년 ${isoWeek.week}주`,
            timestamp,
            date
        };
    }

    return {
        key: `${year}-${month}`,
        label: `${year}년 ${date.getMonth() + 1}월`,
        timestamp,
        date
    };
}

function buildGalleryDateGroups(sourceNode, grouping = 'month') {
    const images = [];
    const seenPaths = new Set();
    collectGalleryFolderImages(sourceNode, images, seenPaths);

    const groups = new Map();
    images.forEach((item) => {
        const descriptor = getGalleryDateGroupDescriptor(item?.mtime, grouping);
        if (!descriptor) return;

        let group = groups.get(descriptor.key);
        if (!group) {
            const sourcePath = normalizeGalleryPathKey(sourceNode?.path || sourceNode?.name || 'root');
            group = {
                name: descriptor.label,
                path: `__gallery_date__/${sourcePath}/${grouping}/${descriptor.key}`,
                folders: [],
                images: [],
                thumb: null,
                total_images: 0,
                latestMtime: descriptor.timestamp,
                char_names: [descriptor.label],
                isGalleryDateGroup: true,
                virtualDateGroup: true,
                dateGrouping: grouping,
                dateGroupKey: descriptor.key,
                sourcePath
            };
            groups.set(descriptor.key, group);
        }

        const itemMtime = Number(item.mtime) || 0;
        group.images.push(item);
        group.total_images += 1;
        group.latestMtime = Math.max(group.latestMtime, itemMtime);
        if (!group.thumb) group.thumb = item.path;
    });

    return [...groups.values()]
        .map((group) => {
            group.images.sort((a, b) => {
                const mtimeDiff = (Number(b.mtime) || 0) - (Number(a.mtime) || 0);
                return mtimeDiff || String(a.name || '').localeCompare(String(b.name || ''));
            });
            group.thumb = group.images[0]?.path || group.thumb || null;
            return group;
        })
        .sort((a, b) => {
            const latestDiff = (Number(b.latestMtime) || 0) - (Number(a.latestMtime) || 0);
            return latestDiff || String(a.name || '').localeCompare(String(b.name || ''));
        });
}

function getGalleryDateGroupDisplayImages(group) {
    return (group?.images || []).filter((item) => {
        return passesGalleryDakiFilter(item, false) &&
            galleryPromptSearchMatchesImage(item) &&
            imageMatchesGalleryTagFilter(item);
    });
}

function buildGalleryDateDisplayGroups(sourceNode, grouping = 'month') {
    return buildGalleryDateGroups(sourceNode, grouping)
        .map((group) => {
            const images = getGalleryDateGroupDisplayImages(group);
            return {
                ...group,
                // 카드 수/대표 이미지는 현재 필터 결과를 쓰되, 진입 시 다른 이미지 필터를
                // 다시 적용할 수 있도록 가상 폴더의 원본 이미지 목록은 보존한다.
                images: group.images,
                total_images: images.length,
                thumb: images[0]?.path || group.thumb || null,
                displayImages: images,
                sourceTotalImages: group.total_images
            };
        })
        .filter((group) => group.displayImages.length > 0);
}

