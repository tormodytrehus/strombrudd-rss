# Strømbrudd-RSS

Direkteoppdatert RSS-feed for strømbrudd hos Tensio og Nettselskapet AS.

## Hovedfeed

https://strombrudd-rss.tormod-ytrehus.workers.dev/strombrudd.xml

Feeden lages av en Cloudflare Worker og oppdateres ved forespørsel, med omtrent 10 sekunders mellomlagring.

## Reservefeed

https://tormodytrehus.github.io/strombrudd-rss/strombrudd.xml

Reservefeeden oppdateres automatisk via GitHub Actions hvert 15. minutt.
