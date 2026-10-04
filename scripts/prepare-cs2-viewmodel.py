"""Keep only the five matching CS2 viewmodel families, without changing poses."""
import hashlib
import json
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'games/freight-fire/assets/viewmodel-cs2'
ARCHIVE = ROOT / 'artifacts/dust2-viewmodel/animations-source.glb'
FAMILIES = {'m4a1', 'ak47', 'awp', 'usp', 'knife'}


def main():
    source = ARCHIVE if ARCHIVE.exists() else DEST / 'animations.glb'
    binary = source.read_bytes()
    # Read the original mirror hash from the downloaded lock, avoiding a
    # second hand-maintained representation of the upstream manifest.
    lock = json.loads((DEST / 'source-lock.json').read_text(encoding='utf-8-sig'))
    entry = next(f for f in lock['files'] if f['path'] == 'assets/viewmodel/animations.glb')
    assert hashlib.sha256(binary).hexdigest() == entry['sha256']
    assert len(binary) == entry['bytes']
    n = struct.unpack_from('<I', binary, 12)[0]
    gltf = json.loads(binary[20:20 + n])
    payload = binary[28 + n:]
    original_count = len(gltf['animations'])
    selected = [a for a in gltf['animations'] if a['name'].split('/')[0] in FAMILIES]
    needed = sorted({s[k] for a in selected for s in a['samplers'] for k in ('input', 'output')})
    mapping = {old: new for new, old in enumerate(needed)}
    accessors = [dict(gltf['accessors'][i]) for i in needed]
    view_ids = sorted({a['bufferView'] for a in accessors})
    view_mapping = {old: new for new, old in enumerate(view_ids)}
    views, compact = [], bytearray()
    for i in view_ids:
        view = dict(gltf['bufferViews'][i])
        offset, length = view.get('byteOffset', 0), view['byteLength']
        compact.extend(b'\0' * (-len(compact) % 4))
        view['byteOffset'] = len(compact)
        compact.extend(payload[offset:offset + length])
        views.append(view)
    for a in accessors:
        a['bufferView'] = view_mapping[a['bufferView']]
    for animation in selected:
        for sampler in animation['samplers']:
            for key in ('input', 'output'):
                sampler[key] = mapping[sampler[key]]
    gltf.update(animations=selected, accessors=accessors, bufferViews=views, buffers=[{'byteLength': len(compact)}])
    metadata = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    metadata += b' ' * (-len(metadata) % 4)
    compact.extend(b'\0' * (-len(compact) % 4))
    result = struct.pack('<4sII', b'glTF', 2, 28 + len(metadata) + len(compact))
    result += struct.pack('<I4s', len(metadata), b'JSON') + metadata
    result += struct.pack('<I4s', len(compact), b'BIN\0') + compact
    output = DEST / 'animations-selected.glb'
    output.write_bytes(result)
    # Retain the verified original as ignored research, so the public build
    # does not include animation families that this game never uses.
    if source != ARCHIVE:
        assert source.resolve().is_relative_to(ROOT.resolve())
        assert ARCHIVE.resolve().is_relative_to((ROOT / 'artifacts').resolve())
        ARCHIVE.parent.mkdir(parents=True, exist_ok=True)
        source.replace(ARCHIVE)
    summary = {
        'sourcePath': entry['path'], 'sourceSHA256': entry['sha256'],
        'sourceBytes': len(binary), 'sourceClips': original_count,
        'output': output.name, 'bytes': len(result),
        'sha256': hashlib.sha256(result).hexdigest(),
        'clips': [a['name'] for a in selected],
        'processing': 'Unchanged animation values; only unused families/accessors/buffer views removed.',
    }
    (DEST / 'animation-selection.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
