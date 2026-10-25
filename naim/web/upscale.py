"""Legacy gallery upscale HTTP contract, independent of global Flask state."""
import os
import random
import time

import upscale_logic
from naim.jobs.upscale import now_iso
from naim.storage.daki_projects import DakiNotFoundError


class UpscaleAPI:
    def __init__(self, jobs, normalize_path, resolve_source, validate_project_context=None,
                 authorize_nai=None):
        self.jobs = jobs
        self.normalize_path = normalize_path
        self.resolve_source = resolve_source
        self.validate_project_context = validate_project_context
        self.authorize_nai = authorize_nai

    def start(self):
        from flask import jsonify, request
        try:
            data = request.json or {}
            request_source_path = data.get('source_path', '')
            source_path = self.normalize_path(request_source_path)
            if not source_path:
                return jsonify({'status': 'error', 'message': '업스케일할 이미지 경로가 없습니다.'}), 400
            project_context = None
            if 'projectContext' in data:
                if self.validate_project_context is None:
                    raise ValueError('다키 프로젝트 업스케일을 사용할 수 없습니다.')
                validated = self.validate_project_context(
                    data.get('projectContext'), request_source_path,
                )
                project_context = validated['projectContext']
                source_path = validated['candidatePath']
                full_path = validated['sourceFullPath']
                relative_path = validated['sourceRelativePath']
            else:
                full_path, relative_path = self.resolve_source(source_path)
            engine = upscale_logic.normalize_upscale_engine(data.get('engine') or 'realcugan')
            fit_5_16 = data.get('fit_5_16') is True and engine != 'nai'
            width, height = upscale_logic.validate_target_size(
                data.get('target_width', 2500), data.get('target_height', 8000),
            )
            if engine == 'nai':
                from PIL import Image
                from naim.images.nai_upscale import plan_nai_upscale
                if data.get('nai_confirmed') is not True:
                    raise ValueError('NAI 자동 맞춤 크기와 Anlas 사용 안내를 확인해 주세요.')
                if self.authorize_nai is None:
                    raise ValueError('NovelAI 키 설정을 확인해 주세요.')
                self.authorize_nai()
                with Image.open(full_path) as source:
                    plan = plan_nai_upscale(*source.size)
                if (width, height) != (plan['output_width'], plan['output_height']):
                    raise ValueError('NAI 맞춤 크기를 업스케일 창에서 다시 확인해 주세요.')
            elif engine in ('illustrationjanai', 'animesharp'):
                from naim.upscale_assets import UPSCALE_ASSETS
                if not next(row['installed'] for row in UPSCALE_ASSETS.list() if row['id'] == engine):
                    raise ValueError('업스케일 창에서 선택한 모델을 먼저 다운로드해 주세요.')
            quality = str(data.get('quality') or 'standard').strip().lower()
            if quality not in ('fast', 'standard', 'high'):
                quality = 'standard'
            job_id = f'upscale_{int(time.time() * 1000)}_{random.randint(1000, 9999)}'
            job_data = {
                'id': job_id, 'status': 'queued', 'progress': 0, 'message': '대기 중...',
                'source_path': validated['candidatePath'] if project_context is not None else relative_path,
                'source_name': os.path.basename(full_path),
                'target_width': width, 'target_height': height, 'engine': engine, 'quality': quality,
                'result_path': '', 'result_src': '', 'error': '',
                'created_at': now_iso(), 'updated_at': now_iso(),
            }
            if project_context is not None:
                job_data['projectContext'] = project_context
            if fit_5_16:
                job_data['fit_5_16'] = True
            job = self.jobs.submit(job_data)
            return jsonify({'status': 'started', 'job': job, 'job_id': job_id})
        except DakiNotFoundError as error:
            return jsonify({'status': 'error', 'message': str(error)}), 404
        except FileNotFoundError as error:
            return jsonify({'status': 'error', 'message': str(error)}), 404
        except ValueError as error:
            return jsonify({'status': 'error', 'message': str(error)}), 400
        except Exception as error:
            return jsonify({'status': 'error', 'message': str(error)}), 500

    def status(self, job_id):
        return self._job_response(self.jobs.get(job_id))

    def list(self):
        from flask import jsonify
        return jsonify({'status': 'success', 'jobs': self.jobs.list()})

    def cancel(self, job_id):
        return self._job_response(self.jobs.cancel(job_id))

    @staticmethod
    def _job_response(job):
        from flask import jsonify
        if job is None:
            return jsonify({'status': 'error', 'message': '작업을 찾을 수 없습니다.'}), 404
        return jsonify({'status': 'success', 'job': job})
