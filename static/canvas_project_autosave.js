(function (root) {
    'use strict';

    function createProjectCanvasAutosave({
        snapshot,
        send,
        recover,
        onRecovered = () => {},
        status = () => {},
        onSaved = () => {},
        onMissing = () => {},
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
        let committedState = null;

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

        function fail(error, request = null, recoverable = false) {
            const kind = recoverable || isConflict(error) ? 'conflict' : 'error';
            if (kind === 'conflict') {
                retryRequest = null;
                dirty = true;
            } else if (request) {
                retryRequest = request;
            } else {
                dirty = true;
            }
            failure = {kind, error, recoverable};
            report(failure.kind, error);
        }

        function validRevision(value, minimum) {
            return Number.isSafeInteger(value) && value > 0 && value >= minimum;
        }

        function disconnectMissing(error) {
            if (!binding || !error || error.status !== 404 || error.code !== 'daki_not_found') {
                return false;
            }

            const missingBinding = copyBinding();
            cancelTimer();
            binding = null;
            committedState = null;
            failure = null;
            dirty = false;
            retryRequest = null;
            running = null;
            generation++;
            report('idle');
            try {
                onMissing(missingBinding);
            } catch (_) {
                // A UI callback must not interrupt missing-binding cleanup.
            }
            return true;
        }

        async function drain(saveGeneration, initialCanvasId, needsRecovery) {
            while (binding && generation === saveGeneration && !failure && (dirty || retryRequest)) {
                if (needsRecovery) {
                    report('recovering');
                    let next;
                    try {
                        next = await recover(copyBinding());
                        if (generation !== saveGeneration || !binding) return false;
                        if (!next || typeof next.canvasId !== 'string' || !next.canvasId.trim() ||
                            next.canvasId === binding.canvasId || next.projectId !== binding.projectId ||
                            next.side !== binding.side || !validRevision(next.revision, 1)) {
                            throw new Error('복구된 프로젝트 캔버스의 연결 정보를 확인할 수 없습니다.');
                        }
                    } catch (error) {
                        if (generation === saveGeneration && binding) fail(error, null, true);
                        return false;
                    }
                    Object.assign(binding, next);
                    needsRecovery = false;
                    try {
                        onRecovered(copyBinding());
                    } catch (_) {
                        // The new binding owns subsequent writes even if a UI update fails.
                    }
                    continue;
                }
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
                    if (generation === saveGeneration && binding) {
                        if (disconnectMissing(error)) return true;
                        if (isConflict(error) && typeof recover === 'function') {
                            if (binding.canvasId !== initialCanvasId) {
                                fail(error, null, true);
                                return false;
                            }
                            retryRequest = null;
                            dirty = true;
                            needsRecovery = true;
                            continue;
                        }
                        fail(error, request);
                    }
                    return false;
                }

                if (generation !== saveGeneration || !binding) return false;
                if (!validRevision(metadata && metadata.revision, request.revision)) {
                    fail(new Error('Project canvas save returned an invalid revision'), request);
                    return false;
                }

                binding.revision = metadata.revision;
                committedState = metadata.state ?? request.state;
                if (retryRequest === request) retryRequest = null;
            }

            if (generation !== saveGeneration || !binding) return false;
            if (failure) return false;
            return true;
        }

        function startFlush(needsRecovery = false) {
            cancelTimer();
            if (!binding) return Promise.resolve(true);
            if (running) return running;
            if (failure) return Promise.resolve(false);
            if (!dirty && !retryRequest) return Promise.resolve(true);

            const saveGeneration = generation;
            const initialCanvasId = binding.canvasId;
            // Install the shared promise before status and recovery callbacks can re-enter.
            let start;
            const task = new Promise(resolve => {start = resolve;});
            async function finish() {
                let result;
                do {
                    result = await drain(saveGeneration, initialCanvasId, needsRecovery);
                    needsRecovery = false;
                } while (result && generation === saveGeneration && binding && dirty);
                if (running === task) running = null;
                if (result && generation === saveGeneration && binding) {
                    try {
                        onSaved(copyBinding(), committedState);
                    } catch (_) {
                        // The server commit is authoritative even if a UI callback fails.
                    }
                    if (generation === saveGeneration && binding && !dirty &&
                        !running && timer === null) {
                        report('saved');
                    }
                }
                return result;
            }
            running = task;
            start(finish());
            return task;
        }

        function flush() {
            return startFlush();
        }

        function schedule(immediate = false) {
            if (!binding) return true;
            dirty = true;

            if (failure) {
                report(failure.kind, failure.error);
                return false;
            }

            if (running) {
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
            committedState = null;
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
            const disconnectGeneration = generation;
            const disconnectBinding = binding;
            do {
                if (!(await flush())) return false;
                if (!binding) return true;
                if (generation !== disconnectGeneration || binding !== disconnectBinding) return false;
            } while (dirty || running);
            binding = null;
            committedState = null;
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

        function retryConflict() {
            if (running) return running;
            if (!binding || !failure?.recoverable) return Promise.resolve(false);
            failure = null;
            return startFlush(true);
        }

        return {
            connect,
            current: () => copyBinding(),
            schedule,
            flush,
            retry,
            retryConflict,
            disconnect,
            disconnectMissing,
            isSavePending: () => !failure && Boolean(dirty || running),
            isUnsaved: () => Boolean(dirty || retryRequest || failure || running)
        };
    }

    root.createProjectCanvasAutosave = createProjectCanvasAutosave;
    if (typeof module === 'object' && module.exports) {
        module.exports = {createProjectCanvasAutosave};
    }
})(typeof globalThis === 'object' ? globalThis : this);
