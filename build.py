"""Rebuild the standalone HTML with Python's standard library only."""
import argparse
import hashlib
import json
from pathlib import Path


def render(root):
    root = Path(root)
    html = (root / 'src/template.html').read_text(encoding='utf-8')
    demo = {side: (root / 'fixtures' / name).read_text(encoding='utf-8')
            for side, name in [('ledger', 'ledger-standard.csv'),
                               ('invoices', 'invoices-standard.csv')]}
    replacements = [('/*__CORE__*/', (root / 'src/core.js').read_text(encoding='utf-8')),
                    ('/*__APP__*/', (root / 'src/app.js').read_text(encoding='utf-8')),
                    ('/*__DEMO__*/', json.dumps(demo, ensure_ascii=False).replace('<', '\\u003c'))]
    for marker, content in replacements:
        if html.count(marker) != 1:
            raise ValueError('Expected exactly one build marker')
        html = html.replace(marker, content)
    return html.encode('utf-8')


def write_output(destination, data):
    destination = Path(destination)
    if destination.exists():
        if destination.read_bytes() != data:
            raise ValueError('Existing output differs; choose a new output path')
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open('xb') as output:
        output.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    data = render(root)
    write_output(args.output or root / 'dist/monthly-reconcile.html', data)
    print(json.dumps({'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}))


if __name__ == '__main__':
    main()
