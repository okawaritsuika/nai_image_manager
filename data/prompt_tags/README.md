# Prompt tag suggestion data

The CSV tag/count files are copied from the `Jio7/danbooru-tags-classified`
dataset at revision `90da0a2bc51724d2b28aef1f3f2a422663a2ede`. The dataset card
declares the data as MIT licensed. Each CSV contains a Danbooru tag and its
post frequency; duplicate tags across files are merged using the largest count.
Rows with an empty count are retained with a frequency of zero.

`ko.json` is copied from the same prompt tag asset bundle. Its accompanying
source notes describe the Korean labels as Codex-assisted and unofficial, so
they are offered as search aids while the original English tag remains the
inserted value.
