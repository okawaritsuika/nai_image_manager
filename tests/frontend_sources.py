import re


def read_page_scripts(root, page):
    """Inspect scripts actually loaded by the page, in HTML execution order."""
    html = (root / page).read_text(encoding="utf-8")
    scripts = re.findall(r'<script\s+src="(/static/[^"?]+\.js)(?:\?[^\"]*)?"', html)
    return '\n'.join((root / script.lstrip('/')).read_text(encoding="utf-8") for script in scripts)
