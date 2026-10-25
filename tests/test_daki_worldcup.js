const test = require('node:test');
const assert = require('node:assert/strict');
require('../static/daki_worldcup.js');
const {taggedImages, tournament} = globalThis.DakiWorldCup;
const images = n => Array.from({length: n}, (_, i) => ({path: `image-${i}.png`, src: `/synthetic/${i}.png`, name: `Style ${i}`}));

test('only tagged unique images participate, with optional exact tag selection', () => {
    const data = images(5);
    const tags = {'image-0.png': 'a', 'image-1.png': 'b', 'image-2.png': 'NONE', 'image-4.png': 'a'};
    const input = [...data, data[0], {path: 'missing-src', name: 'No preview'}];
    assert.deepEqual(taggedImages(input, path => tags[path]), [data[0], data[1], data[4]]);
    assert.deepEqual(taggedImages(input, path => tags[path], 'b'), [data[1]]);
    assert.deepEqual(taggedImages(input, path => tags[path], 'unknown'), []);
});

test('every tournament finishes in n-1 choices for even and odd entry counts', () => {
    for (let count = 2; count <= 33; count++) {
        const source = images(count), before = JSON.stringify(source);
        const game = tournament(source, () => .3);
        let state = game.state(), choices = 0;
        while (!state.winner) {
            assert.equal(state.pair.length, 2);
            assert.notEqual(state.pair[0], state.pair[1]);
            state = game.choose(choices % 2); choices++;
            assert.ok(choices < count);
        }
        assert.equal(choices, count - 1);
        assert.ok(source.includes(state.winner));
        assert.equal(JSON.stringify(source), before);
    }
});

test('undo restores a decision across a round boundary and the final choice', () => {
    const game = tournament(images(5), () => .99);
    const first = game.state(); game.choose(1);
    const second = game.state(); game.choose(0);
    assert.equal(game.state().remaining, 3);
    assert.deepEqual(game.undo(), second);
    assert.deepEqual(game.undo(), first);
    game.choose(0); game.choose(0); game.choose(0);
    const final = game.state(); assert.equal(final.remaining, 2);
    game.choose(1); assert.ok(game.state().winner);
    assert.deepEqual(game.undo(), final);
});

test('invalid input and choices cannot create phantom matches', () => {
    assert.throws(() => tournament(images(1)), /두 장/);
    const game = tournament(images(2), () => 0);
    const first = game.state(); assert.deepEqual(game.choose(-1), first);
    assert.deepEqual(game.choose(2), first);
    game.choose(1); const final = game.state(); assert.deepEqual(game.choose(0), final);
});

test('snapshot records shuffled initial order and only choices remaining after undo', () => {
    const source = images(5), game = tournament(source, () => .1);
    const initial = game.snapshot();
    assert.equal(initial.participants.length, 5);
    assert.notDeepEqual(initial.participants.map(image => image.path), source.map(image => image.path));
    assert.deepEqual(initial.choices, []);
    const selected = game.state().pair[1].path; game.choose(1);
    assert.deepEqual(game.snapshot().choices, [selected]);
    game.choose(0); game.undo();
    assert.deepEqual(game.snapshot().choices, [selected]);
    assert.deepEqual(game.snapshot().participants, initial.participants);
    const copied = game.snapshot(); copied.choices.push('unrelated'); copied.participants[0].name = 'Changed outside';
    assert.deepEqual(game.snapshot().choices, [selected]);
    assert.notEqual(game.snapshot().participants[0].name, 'Changed outside');
    while (!game.state().winner) game.choose(0);
    assert.equal(game.snapshot().choices.length, source.length - 1);
    assert.equal(game.snapshot().choices.at(-1), game.state().winner.path);
    game.undo(); assert.equal(game.snapshot().choices.length, source.length - 2);
});
