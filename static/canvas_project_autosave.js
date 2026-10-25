(function (root) {
    'use strict';

    function createProjectCanvasAutosave({
        snapshot,
        send,
        status = () => {},
        onSaved = () => {},
        setTimer = setTimeout,
        clearTimer = clearTimeout,
        delay = 600
    }) {
        if (typeof snapshot !== 'function' || typeof send !== 'function') {
            throw new TypeError('snapshot and send must be functions');
        }

        let binding = null;
        let generation = 0;
        let timer = null;
        let dirty = false;
        let failure = null;
        let retryRequest = null;
        let running = null;
        let lastStatus = null;

        function report(value, error) {
            if (value === lastStatus && value !== 'error' && value !== 'conflict') return;
            lastStatus = value;
            try {
                status(value, error);
            } catch (_) {
                // A UI status callback must not interrupt the save path.
            }
        }

        function copyBinding(value = binding) {
            return value ? {...value} : null;
        }

        function cancelTimer() {
            if (timer !== null) clearTimer(timer);
            timer = null;
        }

        function isConflict(error) {
            return Boolean(error && error.status === 409);
        }

        function fail(error, request = null) {
            const kind = isConflict(error) ? 'conflict' : 'error';
            if (kind === 'conflict') {
                retryRequest = null;
                dirty = true;
            } else if (request) {
                retryRequest = request;
            } else {
                dirty = true;
            }
            failure = {kind, error};
            report(failure.kind, error);
        }

        function validRevision(value, minimum) {
            return Number.isSafeInteger(value) && value > 0 && value >= minimum;
        }

        async function drain(saveGeneration) {
            while (binding && generation === saveGeneration && !failure && (dirty || retryRequest)) {
                let request = retryRequest;
                if (!request) {
                    const target = copyBinding();
                    let state;
                    try {
                        state = snapshot();
                    } catch (error) {
                        fail(error);
                        return false;
                    }

                    dirty = false;
                    request = {binding: target, state, revision: target.revision};
                }

                report('saving');
                let metadata;
                try {
                    metadata = await send(copyBinding(request.binding), request.state, request.revision);
                } catch (error) {
                    if (generation === saveGeneration && binding) fail(error, request);
                    return false;
                }

                if (generation !== saveGeneration || !binding) return false;
                if (!validRevision(metadata && metadata.revision, request.revision)) {
                    fail(new Error('Project canvas save returned an invalid revision'), request);
                    return false;
                }

                binding.revision = metadata.revision;
                if (retryRequest === request) retryRequest = null;
            }

            if (generation !== saveGeneration || !binding) return false;
            if (failure) return false;
            return true;
        }

        function flush() {
            cancelTimer();
            if (!binding) return Promise.resolve(true);
            if (running) return running;
            if (failure) return Promise.resolve(false);
            if (!dirty && !retryRequest) return Promise.resolve(true);

            const saveGeneration = generation;
            let task;
            task = drain(saveGeneration).then(result => {
                if (running === task) running = null;
                if (result && generation === saveGeneration && binding) {
                    try {
                        onSaved(copyBinding());
                    } catch (_) {
                        // The server commit is authoritative even if a UI callback fails.
                    }
                    if (generation === saveGeneration && binding && !dirty &&
                        !running && timer === null) {
                        report('saved');
                    }
                }
                return result;
            });
            running = task;
            return task;
        }

        function schedule(immediate = false) {
            if (!binding) return true;
            dirty = true;

            if (failure) {
                report(failure.kind, failure.error);
                return false;
            }

            if (running) {
                report('saving');
                return true;
            }

            report('pending');
            if (immediate) return flush();
            if (timer === null) {
                timer = setTimer(() => {
                    timer = null;
                    void flush();
                }, delay);
            }
            return true;
        }

        function connect(nextBinding) {
            if (timer !== null || dirty || failure || retryRequest || running) {
                throw new Error('Cannot change project canvas while a save is pending');
            }
            if (!nextBinding || typeof nextBinding !== 'object' ||
                !nextBinding.projectId || !nextBinding.canvasId ||
                !Number.isSafeInteger(nextBinding.revision) || nextBinding.revision < 1) {
                throw new TypeError('binding requires projectId, canvasId, and a positive safe revision');
            }

            generation++;
            binding = {...nextBinding};
            failure = null;
            dirty = false;
            retryRequest = null;
            report('saved');
            return copyBinding();
        }

        async function disconnect() {
            cancelTimer();
            if (!binding) {
                report('idle');
                return true;
            }
            if (!(await flush())) return false;
            binding = null;
            failure = null;
            dirty = false;
            retryRequest = null;
            generation++;
            report('idle');
            return true;
        }

        function retry() {
            if (!binding) return Promise.resolve(true);
            if (failure && failure.kind === 'conflict') return Promise.resolve(false);
            if (failure) {
                failure = null;
                report('pending');
            }
            return flush();
        }

        return {
            connect,
            current: () => copyBinding(),
            schedule,
            flush,
            retry,
            disconnect,
            isUnsaved: () => Boolean(dirty || retryRequest || failure || running)
        };
    }

    root.createProjectCanvasAutosave = createProjectCanvasAutosave;
    if (typeof module === 'object' && module.exports) {
        module.exports = {createProjectCanvasAutosave};
    }
})(typeof globalThis === 'object' ? globalThis : this);
