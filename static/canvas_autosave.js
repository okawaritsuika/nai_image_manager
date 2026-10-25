// Keep the existing localStorage format; defer repeated serialization, not user data.
function createCanvasAutosave({snapshot, write, status, setTimer = setTimeout, clearTimer = clearTimeout}) {
    let timer = null;
    let dirty = false;
    let failed = false;
    let lastStatus = null;
    function report(value) {
        if (value === lastStatus) return;
        lastStatus = value;
        status(value);
    }
    function flush() {
        if (timer !== null) clearTimer(timer);
        timer = null;
        if (!dirty) return !failed;
        try {
            write(JSON.stringify(snapshot()));
            dirty = false;
            failed = false;
            report('saved');
            return true;
        } catch (error) {
            failed = true;
            report('error');
            return false;
        }
    }
    return {
        schedule(immediate = false) {
            dirty = true;
            if (!failed) report('pending');
            if (immediate) return flush();
            // A fixed window also saves during continuous edits; it cannot starve.
            if (timer === null) timer = setTimer(flush, 200);
            return !failed;
        },
        flush,
        reset() {
            if (timer !== null) clearTimer(timer);
            timer = null;
            dirty = failed = false;
            report('idle');
        }
    };
}
if (typeof module === 'object' && module.exports) module.exports = {createCanvasAutosave};
