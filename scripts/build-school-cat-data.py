# Generates model/school-cat-data.json from scripts/school.txt (OIerDB school list).
# Each school gets a display code: <province code>#<pinyin initials of official name>#<index>,
# where index = (1-based line number) - 4, i.e. 0-based over non-comment lines.
# Usage: python scripts/build-school-cat-data.py [school.txt] [output.json]
import json
import re
import sys

from pypinyin import Style, lazy_pinyin

PROVINCE_CODES = {
    '安徽': 'AH', '北京': 'BJ', '福建': 'FJ', '甘肃': 'GS', '广东': 'GD',
    '广西': 'GX', '贵州': 'GZ', '海南': 'HI', '河北': 'HE', '河南': 'HA',
    '黑龙江': 'HL', '湖北': 'HB', '湖南': 'HN', '吉林': 'JL', '江苏': 'JS',
    '江西': 'JX', '辽宁': 'LN', '内蒙古': 'NM', '山东': 'SD', '山西': 'SX',
    '陕西': 'SN', '上海': 'SH', '四川': 'SC', '天津': 'TJ', '新疆': 'XJ',
    '浙江': 'ZJ', '重庆': 'CQ', '宁夏': 'NX', '云南': 'YN', '澳门': 'MO',
    '香港': 'HK', '青海': 'QH', '西藏': 'XC', '台湾': 'TW',
}


def abbreviation(name: str) -> str:
    letters = lazy_pinyin(name, style=Style.FIRST_LETTER, errors='default')
    chars = []
    for source, letter in zip(name, letters):
        if re.match(r'[一-鿿]', source):
            chars.append(letter[0].upper() if letter else 'X')
        elif source.isascii() and source.isalnum():
            chars.append(source.upper())
    return ''.join(chars)


def main() -> None:
    source = sys.argv[1] if len(sys.argv) > 1 else 'scripts/school.txt'
    target = sys.argv[2] if len(sys.argv) > 2 else 'model/school-cat-data.json'
    schools = []
    skipped = 0
    with open(source, encoding='utf-8') as handle:
        for line_number, raw in enumerate(handle, start=1):
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            code = line_number - 4
            fields = line.split(',')
            # Blank placeholder rows (",,") occupy a line number but carry no
            # school; they are skipped since the explicit code keeps alignment.
            if len(fields) < 3 or not fields[0].strip() or not fields[2].strip():
                print(f'line {line_number}: placeholder row, skipped (code {code})')
                skipped += 1
                continue
            province, official = fields[0].strip(), fields[2].strip()
            prov_code = PROVINCE_CODES.get(province)
            if not prov_code:
                print(f'line {line_number}: unknown province {province!r}')
                prov_code = 'UN'
            abbr = abbreviation(official)
            if not abbr:
                print(f'line {line_number}: empty abbreviation for {official!r}')
                abbr = 'X'
            schools.append([code, prov_code, abbr])
    with open(target, 'w', encoding='utf-8') as handle:
        json.dump({'schools': schools}, handle, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(schools)} schools ({skipped} placeholders skipped) -> {target}')
    for entry in (schools[0], schools[1], schools[2], schools[-1]):
        print(f'  #{entry[0]}: {entry[1]}#{entry[2]}#{entry[0]}')


if __name__ == '__main__':
    main()
