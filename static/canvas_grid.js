(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CanvasGrid = api;
})(typeof globalThis === 'object' ? globalThis : null, function () {
    const DEFAULT_SETTINGS = Object.freeze({
        density: 8,
        center: false,
        thin: false,
        major: false
    });

    const COUNT_MIN = 1;
    const COUNT_MAX = 32;
    const BOOLEAN_KEYS = ['center', 'thin', 'major'];
    const SVG_NS = 'http://www.w3.org/2000/svg';
    let settings = {...DEFAULT_SETTINGS};

    function normalizeDensity(value, fallback) {
        const fallbackNumber = Number(fallback);
        const safeFallback = Number.isFinite(fallbackNumber)
            ? Math.min(COUNT_MAX, Math.max(COUNT_MIN, Math.round(fallbackNumber)))
            : DEFAULT_SETTINGS.density;
        if (typeof value !== 'number' && typeof value !== 'string') return safeFallback;
        if (typeof value === 'string' && value.trim() === '') return safeFallback;

        const numericValue = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(numericValue)) return safeFallback;
        return Math.min(COUNT_MAX, Math.max(COUNT_MIN, Math.round(numericValue)));
    }

    function normalizeSettings(value, fallback = DEFAULT_SETTINGS) {
        const source = value && typeof value === 'object' ? value : {};
        const fallbackSource = fallback && typeof fallback === 'object' ? fallback : DEFAULT_SETTINGS;
        const normalizedFallback = {
            density: normalizeDensity(fallbackSource.density, DEFAULT_SETTINGS.density),
            center: typeof fallbackSource.center === 'boolean' ? fallbackSource.center : DEFAULT_SETTINGS.center,
            thin: typeof fallbackSource.thin === 'boolean' ? fallbackSource.thin : DEFAULT_SETTINGS.thin,
            major: typeof fallbackSource.major === 'boolean' ? fallbackSource.major : DEFAULT_SETTINGS.major
        };

        const normalized = {
            density: Object.prototype.hasOwnProperty.call(source, 'density')
                ? normalizeDensity(source.density, normalizedFallback.density)
                : normalizedFallback.density
        };
        BOOLEAN_KEYS.forEach((key) => {
            normalized[key] = typeof source[key] === 'boolean' ? source[key] : normalizedFallback[key];
        });
        return normalized;
    }

    function buildGridLines(value, width = 100, height = 100) {
        const current = normalizeSettings(value);
        const lines = {thin: [], major: [], center: []};
        const canvasWidth = Number(width);
        const canvasHeight = Number(height);
        if (!Number.isFinite(canvasWidth) || canvasWidth <= 0 || !Number.isFinite(canvasHeight) || canvasHeight <= 0) {
            return lines;
        }

        const spacing = Math.max(
            Math.min(canvasWidth, canvasHeight) / current.density,
            Math.max(canvasWidth, canvasHeight) / 512,
            Number.MIN_VALUE
        );
        if (!Number.isFinite(spacing) || spacing <= 0) return lines;

        function addAxisLines(axis, size) {
            const maxOffset = Math.ceil((size / 2) / spacing);
            for (let offset = -maxOffset; offset <= maxOffset; offset += 1) {
                const coordinate = (size / 2) + (offset * spacing);
                if (coordinate <= 0 || coordinate >= size) continue;
                const position = offset === 0 ? 50 : (coordinate / size) * 100;
                if (current.major && offset % 4 === 0) {
                    lines.major.push({axis, position});
                } else if (current.thin) {
                    lines.thin.push({axis, position});
                }
            }
        }

        if (current.thin || current.major) {
            addAxisLines('x', canvasWidth);
            addAxisLines('y', canvasHeight);
        }
        if (current.center) {
            lines.center.push({axis: 'x', position: 50}, {axis: 'y', position: 50});
        }
        return lines;
    }

    function getControl(id) {
        return typeof document === 'object' ? document.getElementById(id) : null;
    }

    function syncControls() {
        const controls = {
            density: getControl('canvasGridDensity'),
            center: getControl('canvasGridCenter'),
            thin: getControl('canvasGridThin'),
            major: getControl('canvasGridMajor')
        };
        if (controls.density) controls.density.value = String(settings.density);
        BOOLEAN_KEYS.forEach((key) => {
            if (controls[key]) controls[key].checked = settings[key];
        });
        return controls;
    }

    function pathData(lines) {
        return lines.map((line) => line.axis === 'x'
            ? `M${line.position} 0 V100`
            : `M0 ${line.position} H100`).join(' ');
    }

    function render() {
        if (typeof document !== 'object') return false;
        const surface = getControl('canvasSurface');
        if (!surface) return false;

        surface.querySelectorAll('.canvas-grid-overlay').forEach((overlay) => overlay.remove());
        const width = Number(surface.dataset.width);
        const height = Number(surface.dataset.height);
        if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return false;
        if (!settings.center && !settings.thin && !settings.major) return false;

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.id = 'canvasGridOverlay';
        svg.setAttribute('class', 'canvas-grid-overlay');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');

        const lines = buildGridLines(settings, width, height);
        [
            ['canvas-grid-thin', lines.thin],
            ['canvas-grid-major', lines.major],
            ['canvas-grid-center', lines.center]
        ].forEach(([className, group]) => {
            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('class', className);
            path.setAttribute('d', pathData(group));
            path.setAttribute('fill', 'none');
            path.setAttribute('vector-effect', 'non-scaling-stroke');
            svg.appendChild(path);
        });
        surface.appendChild(svg);
        return true;
    }

    function bindControls() {
        const controls = syncControls();
        const controlList = ['density', ...BOOLEAN_KEYS]
            .map((key) => ({key, control: controls[key]}))
            .filter(({control}) => Boolean(control));
        if (!controlList.length) {
            render();
            return;
        }

        function updateSettings() {
            const next = {
                density: controls.density ? controls.density.value : settings.density,
                center: controls.center ? controls.center.checked : settings.center,
                thin: controls.thin ? controls.thin.checked : settings.thin,
                major: controls.major ? controls.major.checked : settings.major
            };
            settings = normalizeSettings(next, settings);
            syncControls();
            render();
        }

        controlList.forEach(({key, control}) => {
            control.addEventListener(key === 'density' ? 'input' : 'change', updateSettings);
        });
        render();
    }

    const api = {
        DEFAULT_SETTINGS,
        normalizeSettings,
        buildGridLines,
        render,
        getSettings() {
            return {...settings};
        }
    };

    if (typeof window === 'object' && window && typeof window.addEventListener === 'function') {
        window.addEventListener('load', bindControls, {once: true});
    }
    return api;
});
