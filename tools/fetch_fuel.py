#!/usr/bin/env python3
"""Fetch this week's retail fuel prices from the U.S. Energy Information Administration (EIA)
and write data/fuel.json for the app.

Runs every day from .github/workflows/fuel.yml (free on a public repo). No API key: it reads
EIA's public weekly tables. Standard library only.

  python3 tools/fetch_fuel.py            # writes data/fuel.json
  python3 tools/fetch_fuel.py --check    # print what it found, write nothing

EIA publishes once a week (usually Monday evening, Eastern time), by region, by some states
and by some cities. It is an average of stations, not the price at one pump.
"""
import html
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SOURCES = {
    # product key in the app -> EIA weekly table, all areas
    'gas': 'https://www.eia.gov/dnav/pet/pet_pri_gnd_a_epmr_pte_dpgal_w.htm',      # regular gasoline
    'diesel': 'https://www.eia.gov/dnav/pet/pet_pri_gnd_a_epd2d_pte_dpgal_w.htm',  # on-highway diesel
}

# EIA row names -> short keys the app looks up (see js/autoprice.js)
AREAS = {
    'U.S.': 'US',
    'East Coast (PADD1)': 'PADD1', 'New England (PADD 1A)': 'PADD1A', 'Central Atlantic (PADD 1B)': 'PADD1B',
    'Lower Atlantic (PADD 1C)': 'PADD1C', 'Midwest (PADD 2)': 'PADD2', 'Gulf Coast (PADD 3)': 'PADD3',
    'Rocky Mountain (PADD 4)': 'PADD4', 'West Coast (PADD 5)': 'PADD5', 'West Coast less California': 'PADD5XCA',
    'California': 'CA', 'Colorado': 'CO', 'Florida': 'FL', 'Massachusetts': 'MA', 'Minnesota': 'MN',
    'New York': 'NY', 'Ohio': 'OH', 'Texas': 'TX', 'Washington': 'WA',
    'Boston': 'city:boston', 'Chicago': 'city:chicago', 'Cleveland': 'city:cleveland', 'Denver': 'city:denver',
    'Houston': 'city:houston', 'Los Angeles': 'city:losangeles', 'Miami': 'city:miami',
    'New York City': 'city:nyc', 'San Francisco': 'city:sanfrancisco', 'Seattle': 'city:seattle',
}


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'QuoteSnap fuel price update (github.com/LinKPlayt/quotesnap-)'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode('latin-1')


def parse(page):
    """-> (week ending 'YYYY-MM-DD', {area_key: price})"""
    # the column headers are the week-ending dates, e.g. 11/02/26
    dates = re.findall(r'class="Series5"[^>]*>\s*(\d{2}/\d{2}/\d{2})', page)
    if not dates:
        raise ValueError('no week columns found: EIA page layout changed?')
    m, d, y = dates[-1].split('/')
    week = f'20{y}-{m}-{d}'
    out = {}
    # each area row: <td class="DataStub1">Name</td> ... six weekly cells ... <td class="DataHist">
    # (rows hold a nested table, so split on the name cells rather than on <tr>)
    for chunk in page.split('class="DataStub1"')[1:]:
        name_html = chunk[chunk.index('>') + 1:chunk.index('</td>')]
        name = re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', name_html))).strip()
        key = AREAS.get(name)
        if not key:
            continue
        cells = chunk[:chunk.find('DataHist')] if 'DataHist' in chunk else chunk
        nums = [float(c) for c in re.findall(r'class="(?:DataB|Current2)"[^>]*>\s*(\d+\.\d+)\s*<', cells)]
        if not nums:
            continue
        price = nums[-1]  # the newest week is the last column
        if 1 < price < 15:  # sanity: dollars per gallon
            out[key] = round(price, 3)
    if 'US' not in out:
        raise ValueError('no U.S. average found: EIA page layout changed?')
    return week, out


def main():
    data = {'source': 'U.S. Energy Information Administration, weekly retail prices (dollars per gallon, incl. taxes)',
            'sourceUrl': 'https://www.eia.gov/petroleum/gasdiesel/',
            'fetched': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
    for product, url in SOURCES.items():
        week, prices = parse(fetch(url))
        data[product] = prices
        data['week'] = max(data.get('week', ''), week)
    if '--check' in sys.argv:
        print(json.dumps(data, indent=1))
        return
    path = Path(__file__).resolve().parent.parent / 'data' / 'fuel.json'
    path.parent.mkdir(exist_ok=True)
    old = json.loads(path.read_text()) if path.exists() else {}
    # only rewrite when the prices changed, so the daily job doesn't commit every day for nothing
    if {k: old.get(k) for k in ('week', 'gas', 'diesel')} == {k: data.get(k) for k in ('week', 'gas', 'diesel')}:
        print('fuel prices unchanged, week of', data['week'])
        return
    path.write_text(json.dumps(data, indent=1, sort_keys=True) + '\n')
    print('wrote', path, 'week of', data['week'], '| US gas', data['gas']['US'], 'diesel', data['diesel']['US'])


if __name__ == '__main__':
    main()
