"""HTTP route for bilingual prompt tag autocomplete."""

from flask import jsonify, request

from naim.prompt_suggestions import (
    PromptSuggestionCatalog, PromptSuggestionDataError,
)


def register_prompt_suggestion_routes(app, directory):
    catalog = PromptSuggestionCatalog(directory)

    @app.route('/api/prompt-tags/suggest', methods=['GET'],
               endpoint='prompt_tag_suggestions')
    def prompt_tag_suggestions():
        query = request.args.get('q', '')
        raw_limit = request.args.get('limit')
        limit = None
        if raw_limit is not None:
            try:
                limit = int(raw_limit)
            except (TypeError, ValueError):
                limit = 0

        try:
            items = (catalog.suggest(query) if limit is None
                     else catalog.suggest(query, limit))
        except PromptSuggestionDataError:
            return jsonify({
                'status': 'error', 'message': '프롬프트 태그 사전을 사용할 수 없습니다.',
            }), 503
        except ValueError as error:
            return jsonify({'status': 'error', 'message': str(error)}), 400
        return jsonify({'status': 'success', 'items': items})

    return prompt_tag_suggestions
