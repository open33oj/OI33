import re

def extract(path, mid):
    data = open(path, encoding='utf-8', errors='replace').read()
    m = re.search(r'[,\{]' + mid + r'\([A-Za-z$,]*\)\{', data)
    start = m.end()
    depth = 1
    i = start
    in_str = None
    while i < len(data):
        ch = data[i]
        if in_str:
            if ch == '\\':
                i += 2
                continue
            if ch == in_str:
                in_str = None
        else:
            if ch in ('"', "'", '`'):
                in_str = ch
            elif ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    return data[start:i]
        i += 1
    raise RuntimeError('unbalanced')

jq = extract('../node_modules/@hydrooj/ui-default/public/hydro-4.58.4.js', '91688')
sk = extract('../node_modules/@hydrooj/ui-default/public/181.712dd0.chunk.js', '47216')
out = ['var __mods = {};',
       'function __require(id){ var M = {exports:{}}; __mods[id](M, M.exports, __require); return M.exports; }',
       '__mods[91688] = function(c, x){' + jq + '};',
       '__mods[47216] = function(he, T, m){' + sk + '};',
       'window.jQuery = __require(91688);', '__require(47216);']
open('vendor.js', 'w', encoding='utf-8').write('\n'.join(out))
print('ok', len(jq), len(sk))
