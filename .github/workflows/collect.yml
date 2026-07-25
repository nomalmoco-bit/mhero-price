# 망전 시세 자동 수집 — 매일 KST 오전 9시·오후 6시 (크론은 UTC 기준)
# 수동 실행: Actions 탭 → collect-prices → Run workflow
name: collect-prices
on:
  schedule:
    - cron: '0 0 * * *'    # UTC 00:00 = KST 09:00
    - cron: '0 9 * * *'    # UTC 09:00 = KST 18:00
  workflow_dispatch:
permissions:
  contents: write
jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: 시세 수집
        run: node collect.mjs
        env:
          NEXON_API_KEY: ${{ secrets.NEXON_API_KEY }}
      - name: 커밋·푸시
        run: |
          git config user.name "price-bot"
          git config user.email "bot@users.noreply.github.com"
          git add data/prices.json
          git diff --cached --quiet || git commit -m "collect $(date -u +%F_%H%M)"
          git push
