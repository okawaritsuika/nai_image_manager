"""Bounded submission for image work, with results delivered as they finish."""
from concurrent.futures import FIRST_COMPLETED, wait


def iter_completed(executor, function, items, max_pending, stop_check=None, **kwargs):
    """Yield (item, future); on stop, drain submitted work without adding more."""
    items = iter(items)
    pending = {}
    exhausted = False
    try:
        while True:
            while not exhausted and len(pending) < max(1, max_pending):
                if stop_check and stop_check():
                    exhausted = True
                    break
                try:
                    item = next(items)
                except StopIteration:
                    exhausted = True
                    break
                pending[executor.submit(function, item, **kwargs)] = item
            if not pending:
                return
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                item = pending.pop(future)
                yield item, future
    finally:
        for future in pending:
            future.cancel()
