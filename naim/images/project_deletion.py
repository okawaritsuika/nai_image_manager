"""Delete a project candidate's source and link through their existing owners."""
from contextlib import nullcontext
from pathlib import Path

from naim.storage.daki_projects import DakiNotFoundError, SIDES
from naim.storage.image_files import IMAGE_FILES_LOCK, staged_image_removal
from naim.storage.json_files import json_lock


class ProjectImageReferencesConflict(ValueError):
    def __init__(self, references):
        super().__init__('다른 항목에서도 사용하는 그림입니다. 삭제 영향을 확인해 주세요.')
        self.references = references


def delete_project_candidate_image(store, project_id, candidate_id, *,
                                   confirm_daki=False, references_provider=None):
    if type(confirm_daki) is not bool:
        raise ValueError('삭제 확인 값은 true 또는 false여야 합니다.')
    # Image writers acquire these locks in this order before linking a candidate.
    with IMAGE_FILES_LOCK, json_lock(store.path):
        project = store.get_project(project_id)
        match = next(((side, item) for side in SIDES
                      for item in project['candidates'][side]
                      if item['id'] == candidate_id), None)
        if match is None:
            raise DakiNotFoundError('다키 후보를 찾을 수 없습니다.')
        side, candidate = match
        relative = store._clean(candidate['path'])
        source = None
        actual = relative
        try:
            full_path, actual = store.resolve_image(relative)
            source = Path(full_path)
            if source.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.webp'):
                raise ValueError('지원하는 그림 파일만 삭제할 수 있습니다.')
        except FileNotFoundError:
            pass  # A missing source must not prevent removing its stale card.
        if not confirm_daki:
            references = [ref for ref in store.references(paths=[relative, actual])
                          if not (ref.get('project_id') == project_id
                                  and ref.get('project_name') == project['name']
                                  and ref.get('side') == side
                                  and ref.get('path') == candidate['path'])]
            if references_provider:
                references.extend(references_provider([relative, actual]) or [])
            if references:
                raise ProjectImageReferencesConflict(references)
        removal = staged_image_removal(source) if source is not None else nullcontext()
        with removal:
            updated = store.remove_candidate(project_id, candidate_id)
        return updated, str(source) if source is not None else None, actual
