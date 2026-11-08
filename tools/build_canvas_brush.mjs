// Build with clang++ on PATH, or set CANVAS_CLANG to a WASI SDK clang++ executable.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const path = file => fileURLToPath(new URL(file, import.meta.url));
const result = spawnSync(process.env.CANVAS_CLANG || 'clang++', [
    '--target=wasm32', '-std=c++17', '-O3', '-msimd128', '-ffp-contract=off',
    '-ffreestanding', '-fno-exceptions', '-nostdlib', '-Wl,--no-entry',
    '-Wl,--export=blend_rgba', '-Wl,--export=blend_rgba_region',
    '-Wl,--export=add_dab', '-Wl,--export=add_dab_region',
    '-Wl,--export=__heap_base', '-Wl,--export-memory',
    path('./canvas_brush.cpp'), '-o', path('../static/canvas_editor/brush.wasm')
], {stdio: 'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
