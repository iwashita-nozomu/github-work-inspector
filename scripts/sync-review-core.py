#!/usr/bin/env python3
"""Generate all host bundles from the same authored core; --check rejects drift."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def outputs():
    contract_data = json.loads((ROOT/'core/contract.json').read_text())
    schema = json.loads((ROOT/'core/observation.schema.json').read_text())
    assert schema['$schema'] == 'https://json-schema.org/draft/2020-12/schema'
    assert set(contract_data['profiles']) == set(schema['$defs']['provenance']['properties']['adapter']['enum'])
    capability_keys = set(schema['$defs']['provenance']['properties']['capabilities']['required'])
    assert all(set(profile) == capability_keys for profile in contract_data['profiles'].values())
    authored = sorted(p for p in (ROOT / 'core').rglob('*') if p.is_file())
    files = {p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in authored}
    lock = {'contract_version': contract_data['contract_version'],
            'authored_files': files, 'consistency_only_not_signature': True}
    digest = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    lock['core_digest'] = digest
    marker = f'<!-- Generated from core/; edit the authored source. Core digest: {digest} -->\n'
    contract = (ROOT/'core/contract.json').read_text()
    bundle = ('/* Generated from core/; consistency digest: ' + digest + ' */\n'
              + 'globalThis.GitHubReviewCoreContract = Object.freeze(' + contract.strip() + ');\n'
              + (ROOT/'core/normalize.js').read_text() + '\n' + (ROOT/'core/selection.js').read_text())
    common = (ROOT/'core/workflow.md').read_text()
    work = (ROOT/'core/adapters/work.md').read_text()
    chat = (ROOT/'core/adapters/chat.md').read_text()
    result = {
        'docs/repository-review-workflow.md': marker + common + '\n' + work,
        'docs/chat-review-workflow.md': marker + common + '\n' + chat,
        'docs/core-contract.json': contract,
        'docs/core-observation.schema.json': (ROOT/'core/observation.schema.json').read_text(),
        'docs/CORE-LOCK.json': json.dumps(lock, indent=2) + '\n',
    }
    for prefix, entry, adapter in [
        ('.agents/skills/github-work-inspector', 'work-cli', work),
        ('plugins/github-work-inspector/skills/github-work-inspector-plugin', 'work-plugin', work),
        ('plugins/github-work-inspector-chat/skills/github-repo-review-chat', 'chat', chat),
    ]:
        # Frontmatter must remain the first bytes; the generated marker follows it.
        entry_text = (ROOT/f'core/entries/{entry}.md').read_text()
        position = entry_text.index('\n---\n', 4) + len('\n---\n')
        entry_text = entry_text[:position] + '\n' + marker + entry_text[position:]
        result[f'{prefix}/SKILL.md'] = entry_text + '\n' + common + '\n' + adapter
        result[f'{prefix}/references/review-selection.js'] = bundle
    chat_ref = 'plugins/github-work-inspector-chat/skills/github-repo-review-chat/references/'
    result[chat_ref+'core-contract.json'] = contract
    result[chat_ref+'observation.schema.json'] = (ROOT/'core/observation.schema.json').read_text()
    result[chat_ref+'CORE-LOCK.json'] = json.dumps(lock, indent=2) + '\n'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    stale = []
    for relative, content in outputs().items():
        path = ROOT/relative
        if args.check:
            if not path.is_file() or path.read_text(encoding='utf-8') != content:
                stale.append(relative)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding='utf-8')
    if stale:
        raise SystemExit('Shared review core drift: ' + ', '.join(stale))
    print(json.dumps({'shared_core': 'synchronized', 'generated_files': len(outputs()), 'check': args.check}))


if __name__ == '__main__':
    main()
