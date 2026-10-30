#!/usr/bin/env python3
"""Offline checks for plugin manifests and the enforced read-only launch surface."""
import json
from pathlib import Path
import tomllib

root = Path(__file__).resolve().parents[1]
plugin = root/'plugins/github-work-inspector'
version = tomllib.loads((root/'Cargo.toml').read_text(encoding="utf-8"))['package']['version']
a = json.loads((plugin/'plugin.json').read_text(encoding="utf-8"))
b = json.loads((plugin/'.codex-plugin/plugin.json').read_text(encoding="utf-8"))
assert a['name'] == b['name'] == plugin.name
assert a['version'] == b['version'] == version
assert a['$schema'] == 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
assert len(b['interface']['shortDescription']) <= 30 and b['interface']['capabilities'] == []
assert b['mcpServers'] == './.mcp.json' and b['skills'] == './skills/'
assert a['extensions']['com.openai']['interface'] == b['interface']
assert b['interface']['defaultPrompt'] == 'このレポを見て'
m = json.loads((plugin/'mcp.json').read_text(encoding="utf-8"))
assert m['$schema'] == 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
for document in [m, json.loads((plugin/'.mcp.json').read_text(encoding="utf-8"))]:
    assert set(document['mcpServers']) == {'github-work-inspector'}
    server = document['mcpServers']['github-work-inspector']
    assert server['command'] == './bin/github-work-inspector'
    assert server['args'] == ['mcp'] and server['cwd'] == '${PLUGIN_ROOT}'
    assert not set(server)-{'command','args','cwd','type'}
assert 'allow_implicit_invocation: false' in (plugin/'skills/github-work-inspector-plugin/agents/openai.yaml').read_text(encoding="utf-8")
assert (root/'.agents/skills/github-work-inspector/references/review-selection.js').read_bytes() == (plugin/'skills/github-work-inspector-plugin/references/review-selection.js').read_bytes()
print(json.dumps({'plugin':a['name'],'version':version,'offline_manifest_checks':'passed'}))
