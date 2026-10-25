"""Image header inspection and explicit WebP conversion HTTP boundary."""
from flask import jsonify, request
from PIL import Image

from naim.jobs.image_conversion import image_paths
from naim.storage.daki_projects import DakiNotFoundError


def register_image_conversion_routes(app, jobs, resolver, validate_project_context=None):
    def payload():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise ValueError('JSON 요청 내용을 확인해 주세요.')
        return data

    @app.post('/api/gallery/image-formats')
    def gallery_image_formats():
        try:
            paths = image_paths(payload().get('paths'), limit=200)
        except ValueError as error:
            return jsonify(status='error', message=str(error)), 400
        formats = {}
        for path in paths:
            try:
                full_path, _ = resolver(path)
                with Image.open(full_path) as image:
                    formats[path] = image.format or 'UNKNOWN'
            except (OSError, ValueError):
                formats[path] = 'UNKNOWN'
        return jsonify(status='success', formats=formats)

    @app.route('/api/gallery/webp', methods=['GET', 'POST'])
    def gallery_webp():
        try:
            if request.method == 'POST':
                data = payload()
                paths = data.get('paths')
                context = None
                if 'projectContext' in data:
                    paths = image_paths(paths)
                    if len(paths) != 1 or validate_project_context is None:
                        raise ValueError('프로젝트 이미지는 한 장씩 변환해 주세요.')
                    validated = validate_project_context(data['projectContext'], paths[0])
                    context = validated['projectContext']
                    paths = [validated['candidatePath']]
                job = jobs.start(paths, data.get('quality', 90), data.get('keep_original', False), context)
            else:
                job = jobs.snapshot()
            return jsonify(status='success', job=job)
        except (DakiNotFoundError, FileNotFoundError) as error:
            return jsonify(status='error', message=str(error)), 404
        except ValueError as error:
            return jsonify(status='error', message=str(error)), 400
        except RuntimeError as error:
            return jsonify(status='error', message=str(error)), 409

    @app.post('/api/gallery/webp/cancel')
    def gallery_webp_cancel():
        try:
            return jsonify(status='success', job=jobs.cancel(payload().get('id')))
        except ValueError as error:
            return jsonify(status='error', message=str(error)), 400
        except RuntimeError as error:
            return jsonify(status='error', message=str(error)), 409
