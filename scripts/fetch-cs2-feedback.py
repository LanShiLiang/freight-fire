"""Recover selected audio/UI resources from the user's dust2-web reference.

The reference lock file provides hashes, not a license grant. Valve retains
the rights to these samples and silhouettes; runtime never fetches remotely.
"""
from pathlib import Path
import concurrent.futures, hashlib, json, urllib.request

ROOT = Path(__file__).resolve().parent.parent
REF = ROOT / 'artifacts/dust2-reference'
LOCK = json.loads((REF / 'config/assets-lock.json').read_text(encoding='utf8'))
FILES = {f['path']: f for f in LOCK['files']}
BASE = LOCK['baseURL']
OUT = ROOT / 'games/freight-fire'

def fetch(path):
    record = FILES[path]
    target = OUT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    data = target.read_bytes() if target.exists() else b''
    if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
        request = urllib.request.Request(BASE + path + '?v=' + record['sha256'][:16], headers={'User-Agent': 'FreightFire-local-development'})
        with urllib.request.urlopen(request, timeout=45) as response:
            data = response.read()
        if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
            raise ValueError('Reference hash mismatch: ' + path)
        target.write_bytes(data)
    return {'path': path, 'bytes': len(data), 'sha256': record['sha256'], 'url': BASE + path}

manifest_record = fetch('assets/audio/cs2/manifest.json')
manifest = json.loads((OUT / manifest_record['path']).read_text(encoding='utf8'))
banks = manifest['banks']
selected = {name: values[:2] for name, values in banks.items() if name in ['kill', 'headHit', 'headArmor', 'bodyHit', 'armorHit'] or name.startswith(('m4a1', 'ak47', 'awp', 'usp', 'knife'))}
paths = {'assets/audio/cs2/' + file for values in selected.values() for file in values}
paths.update('assets/ui-cs2/' + icon + '.svg' for icon in ['m4a1', 'ak47', 'awp', 'usp', 'knife', 'headshot', 'kill', 'killHeadshot', 'death'])
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    records = list(pool.map(fetch, sorted(paths)))
result = {'reference': 'https://github.com/ETO-ze/dust2-web', 'referenceCommit': None, 'lockVersion': LOCK['version'], 'rights': 'Valve and respective creators. Public technical manifest does not relicense original game audio or imagery. Not MIT or CC0.', 'banks': selected, 'files': [manifest_record] + records}
(OUT / 'assets/audio/cs2/freight-manifest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf8')
print(json.dumps({'banks': selected, 'files': len(records), 'bytes': sum(r['bytes'] for r in records)}, ensure_ascii=False))
