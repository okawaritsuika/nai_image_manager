const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('gallery scripts load in HTML order and initialize character names and selection', () => {
    const root = path.join(__dirname, '..');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const listeners = [];
    const context = vm.createContext({
        console,
        document: {
            getElementById: () => null,
            addEventListener: (type, callback) => listeners.push({type, callback}),
        },
        window: {addEventListener: () => {}},
        localStorage: {getItem: () => null},
    });
    for (const match of html.matchAll(/<script\s+src="(\/static\/[^"?]+\.js)"/g)) {
        const filename = path.join(root, match[1]);
        vm.runInContext(fs.readFileSync(filename, 'utf8'), context, {filename: match[1]});
    }
    assert.equal(context.getGalleryCharacterBaseKey('Sample_Hero_(blue_archive)'), 'sample hero');
    assert.equal(context.getGalleryCharacterBaseKey('Sample_Hero_blue_archive'), 'sample hero');
    assert.ok(context.getGalleryCharacterKoreanDisplayName('Sakuragi_Mano'));
    context.bindGallerySelectionEvents();
    assert.ok(listeners.some(item => item.type === 'pointerdown' && item.callback === context.beginGalleryMultiFolderBoxSelection));
    assert.ok(listeners.some(item => item.type === 'pointerdown' && item.callback === context.beginGalleryBulkDeleteBoxSelection));
});
